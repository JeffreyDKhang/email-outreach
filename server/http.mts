import type {Session} from './types.js';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {DeliveryPayload, PostApi} from '../app/domain/types.js';
import { prepareHeldMessages, prepareOutboxSend, prepareInstantSend } from './outbox.mjs';
import { appAllowance, validateSendingSettings } from './send-policy.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { prepareLiveBatch } from './sending.mjs';
import { publicOAuthError, OAuthConnectionError } from './oauth-errors.mjs';
import { oauthErrorPage } from './oauth-error-page.mjs';

export function createApplication({ root, origin, store, provider }: { root: string; origin: string | (() => string); store: ReturnType<typeof import("./store.mjs").openStore>; provider: import("./types.js").GmailProvider; }) {

    const sessions: Map<string, Session> = new Map();

    const send = (res: ServerResponse<IncomingMessage>, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

    function oauthFailure(req: IncomingMessage, res: ServerResponse<IncomingMessage>, error: unknown) {
        if (!req.headers.accept?.includes('text/html'))
            return send(res, 400, publicOAuthError(error));
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(oauthErrorPage(error));
    }

    async function body<P extends keyof PostApi>(req: IncomingMessage, route: P, limit: number | undefined = 2000000): Promise<PostApi[P]["request"]> { const chunks = []; let size = 0; for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
            throw Error('Request too large.');
        chunks.push(chunk);
    } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }

    function session(req: IncomingMessage) { const id = req.headers.cookie?.match(/(?:^|; )op_session=([a-f0-9]+)/)?.[1], current = sessions.get(id || ''); if (current && current.expires > Date.now())
        return current; return null; }
    const server = createServer(async (req: IncomingMessage, res: ServerResponse<IncomingMessage> & { req: IncomingMessage; }) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
        try {
            const baseOrigin = typeof origin === 'function' ? origin() : origin;
            if (req.headers.host !== new URL(baseOrigin).host)
                return send(res, 403, { error: 'Use the local URL printed by the server.' });
            const url = new URL(req.url || '/', baseOrigin), path = url.pathname;
            if (path === '/oauth/google/callback') {
                const current = session(req), pending = current?.oauth;
                if (current)
                    delete current.oauth;
                if (!pending || pending.expires < Date.now() || url.searchParams.get('state') !== pending.state)
                    return oauthFailure(req, res, new OAuthConnectionError('oauth_session_expired', 'authorization'));
                if (url.searchParams.has('error'))
                    return oauthFailure(req, res, new OAuthConnectionError('access_denied', 'authorization'));
                try {
                    await provider.connect(url.searchParams.get('code'), pending.verifier);
                }
                catch (error) {
                    return oauthFailure(req, res, error);
                }
                res.writeHead(303, { Location: '/app/', 'Cache-Control': 'no-store' });
                return res.end();
            }
            if (path.startsWith('/api/')) {
                if ((req.headers.origin && req.headers.origin !== baseOrigin) || req.headers['sec-fetch-site'] === 'cross-site')
                    return send(res, 403, { error: 'Cross-site request rejected.' });
                for (const [id, s] of sessions)
                    if (s.expires < Date.now())
                        sessions.delete(id);
                if (path === '/api/session' && req.method === 'GET') {
                    let current = session(req);
                    if (!current) {
                        const id = randomBytes(32).toString('hex');
                        current = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + 12 * 3600000 };
                        sessions.set(id, current);
                        res.setHeader('Set-Cookie', `op_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
                    }
                    return send(res, 200, { csrf: current.csrf });
                }
                const current = session(req);
                if (!current)
                    return send(res, 401, { error: 'Refresh the page to start a local session.' });
                if (req.method !== 'GET' && (req.headers['x-csrf-token'] !== current.csrf || !req.headers['content-type']?.startsWith('application/json')))
                    return send(res, 403, { error: 'Invalid request token or content type.' });
                if (path === '/api/workspace' && req.method === 'GET')
                    return send(res, 200, store.readWorkspace());
                if (path === '/api/workspace' && req.method === 'POST') {
                    const value = await body(req, '/api/workspace', 32000000);
                    return send(res, 200, store.writeWorkspace(value.workspace, value.revision));
                }
                if (path === '/api/sending' && req.method === 'GET') {
                    const account = provider.getAccount();
                    return send(res, 200, { account: account ? { email: account.email } : null, connection: provider.getConnectionHealth?.(), allowance: account ? appAllowance(store.jobs(), account.id) : null, settings: store.get('sending-settings') || { delaySeconds: 0 }, paused: store.get('sending-pause'), serverTime: new Date().toISOString() });
                }
                if (path === '/api/sending/settings' && req.method === 'POST') {
                    const settings = validateSendingSettings(await body(req, '/api/sending/settings'));
                    store.set('sending-settings', settings);
                    return send(res, 200, { settings });
                }
                if (path === '/api/sending/resume' && req.method === 'POST') {
                    if (!provider.getAccount())
                        throw Error('Connect Gmail before resuming.');
                    store.remove('sending-pause');
                    return send(res, 200, { resumed: true });
                }
                if (path === '/api/account' && req.method === 'GET')
                    return send(res, 200, { configured: provider.configured(), account: provider.getAccount(), connection: provider.getConnectionHealth?.(), redirectUri: baseOrigin + '/oauth/google/callback' });
                if (path === '/api/google/check' && req.method === 'POST') {
                    if (!provider.checkConnectivity)
                        throw Error('Connectivity checks are unavailable for this provider.');
                    return send(res, 200, await provider.checkConnectivity());
                }
                if (path === '/api/google/config' && req.method === 'POST') {
                    if (provider.getAccount())
                        throw Error('Disconnect the current account before changing OAuth configuration.');
                    const { clientId, clientSecret } = await body(req, '/api/google/config');
                    if (typeof clientId !== 'string' || !clientId.endsWith('.apps.googleusercontent.com') || clientId.length > 300 || typeof clientSecret !== 'string' || clientSecret.length < 8 || clientSecret.length > 500)
                        throw Error('Enter a valid Google web application client ID and client secret.');
                    store.set('google-config', { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
                    return send(res, 200, { saved: true });
                }
                if (path === '/api/google/connect' && req.method === 'POST') {
                    if (provider.getAccount())
                        throw Error('Disconnect first to switch Gmail accounts.');
                    const state = randomBytes(32).toString('hex'), auth = await provider.authorize(state);
                    current.oauth = { state, verifier: auth.verifier, expires: Date.now() + 10 * 60000 };
                    return send(res, 200, { url: auth.url });
                }
                if (path === '/api/account/disconnect' && req.method === 'POST') {
                    store.cancelQueued();
                    current.preview = null;
                    try {
                        await provider.disconnect();
                        return send(res, 200, { disconnected: true });
                    }
                    catch {
                        return send(res, 200, { disconnected: true, notice: 'Local credentials removed. Google revocation could not be confirmed; remove the app in your Google account if needed.' });
                    }
                }
                if (path === '/api/outbox' && req.method === 'GET')
                    return send(res, 200, { messages: store.outbox() });
                if (path === '/api/outbox/add' && req.method === 'POST')
                    return send(res, 200, store.addHeld(prepareHeldMessages(await body(req, '/api/outbox/add'))));
                if (path === '/api/outbox/batch' && req.method === 'POST') {
                    const value = await body(req, '/api/outbox/batch');
                    return send(res, 200, store.assignBatch(value.ids, randomUUID(), value.name));
                }
                if (path === '/api/outbox/remove' && req.method === 'POST') {
                    store.removeHeld((await body(req, '/api/outbox/remove')).ids);
                    return send(res, 200, { removed: true });
                }
                if (path === '/api/instant/preview' && req.method === 'POST') {
                    const preview = prepareInstantSend(await body(req, '/api/instant/preview'), provider.getAccount(), store.jobs());
                    current.preview = preview;
                    return send(res, 200, preview);
                }
                if (path === '/api/outbox/preview' && req.method === 'POST') {
                    const value = await body(req, '/api/outbox/preview'), preview = prepareOutboxSend(store.outbox(), value.ids, provider.getAccount(), store.jobs());
                    current.preview = preview;
                    return send(res, 200, preview);
                }
                if (path === '/api/live/preview' && req.method === 'POST') {
                    const value = await body(req, '/api/live/preview'), preview = prepareLiveBatch(value.leads, value.rules, provider.getAccount(), store.jobs());
                    current.preview = preview;
                    return send(res, 200, preview);
                }
                if (path === '/api/live/enqueue' && req.method === 'POST') {
                    const value = await body(req, '/api/live/enqueue'), preview = current.preview, account = provider.getAccount();
                    if (!preview || preview.expires < Date.now() || preview.id !== value.id || preview.digest !== value.digest || !account || preview.items.some((item: DeliveryPayload) => item.account !== account.id || item.sender !== account.email))
                        throw Error('Review the exact sender and messages again before sending.');
                    if (preview.items.every((item: DeliveryPayload) => item.outboxId))
                        store.enqueueHeld(preview.items);
                    else
                        store.enqueue(preview.items);
                    current.preview = null;
                    return send(res, 200, { queued: preview.items.length });
                }
                if (path === '/api/live/jobs' && req.method === 'GET')
                    return send(res, 200, { jobs: store.jobs() });
                if (path === '/api/live/history/clear' && req.method === 'POST')
                    return send(res, 200, store.clearHistory((await body(req, '/api/live/history/clear')).ids));
                if (path === '/api/live/cancel' && req.method === 'POST') {
                    store.cancelQueued();
                    return send(res, 200, { cancelled: true });
                }
                return send(res, 404, { error: 'API route not found.' });
            }
            if (!['GET', 'HEAD'].includes(req.method || ''))
                return send(res, 405, { error: 'Method not allowed.' });
            if (path === '/') {
                res.writeHead(302, { Location: '/app/' });
                return res.end();
            }
            // Only public app and fixture assets are served, never credentials, databases or source config.
            if (!path.startsWith('/app/') && !path.startsWith('/data/'))
                return send(res, 404, { error: 'Not found.' });
            const decoded = decodeURIComponent(path), target = resolve(root, '.' + decoded + (decoded.endsWith('/') ? 'index.html' : ''));
            if (![resolve(root, 'app') + sep, resolve(root, 'data') + sep].some((prefix: string) => target.startsWith(prefix)))
                return send(res, 403, { error: 'Invalid asset path.' });

            const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };
            if (!types[extname(target)])
                return send(res, 404, { error: 'Not found.' });
            let content;
            try {
                content = await readFile(target);
            }
            catch {
                return send(res, 404, { error: 'Not found.' });
            }
            res.writeHead(200, { 'Content-Type': types[extname(target)], 'Cache-Control': 'no-store' });
            res.end(req.method === 'HEAD' ? undefined : content);
        }
        catch (cause) {
            const error =  cause as { code?: string; message?: string; };
            send(res, error.code === 'workspace_conflict' ? 409 : 400, { ...(error.code === 'workspace_conflict' ? { code: error.code } : {}), error: error.message?.startsWith('UNIQUE constraint') ? 'This message is already queued or recorded.' : error.message?.includes('SQLITE') ? 'Unable to save to the local database.' : error.message || 'Request failed.' });
        }
    });
    return server;
}

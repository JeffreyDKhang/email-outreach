import type {ConnectionHealth, DeliveryPayload} from '../../app/domain/types.js';
import type {GmailProvider} from '../types.js';
import type {Credentials} from 'google-auth-library';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { SendError, requireProvider } from './interface.mjs';
import { OAuthConnectionError, classifyOAuthError } from '../oauth-errors.mjs';
import { checkGoogleConnectivity } from '../google-connectivity.mjs';
export const gmailScopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function mimeMessage(message: Pick<DeliveryPayload, "body" | "sender" | "recipient" | "subject"> & { id?: string; }) {
    if (!mailbox.test(message.sender) || !mailbox.test(message.recipient) || /[\r\n]/.test(message.subject))
        throw new SendError('Invalid address or subject header.');
    if (message.id && !/^[a-zA-Z0-9-]+$/.test(message.id))
        throw new SendError('Invalid message identifier.');
    const subjectChunks = Array.from(message.subject).reduce((chunks: string[], char: string) => { if (!chunks.length || Buffer.byteLength(chunks.at(-1) + char) > 30)
        chunks.push(char);
    else
        chunks[chunks.length - 1] += char; return chunks; }, [] as string[]);
    const subject = subjectChunks.map((chunk: string) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
    const body = Buffer.from(message.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
    return [`From: ${message.sender}`, `To: ${message.recipient}`, `Subject: ${subject}`, `Message-ID: <${message.id || randomUUID()}@officepantry.local>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', '' + body].join('\r\n');
}

export function gmailProvider({ store, redirectUri, clientFactory = (id: string, secret: string) => new OAuth2Client(id, secret, redirectUri), connectivityRequest }: { store: import("../types.js").SettingsStore; redirectUri: string; clientFactory?: (id: string, secret: string) => OAuth2Client; connectivityRequest?: import("../types.js").ConnectivityRequest; }): GmailProvider {

    let health: ConnectionHealth | null = store.get('gmail-connection-status') || null;

    function recordConnection(status: string, error?: OAuthConnectionError | undefined) {
        health = { status, accountId: store.get('gmail-account')?.id || null, checkedAt: new Date().toISOString(),
            ...(error ? { code: error.code, stage: error.stage, error: error.message } : {}) };
        // Keep the current warning in memory even if diagnostic persistence fails.
        try {
            store.set('gmail-connection-status', health);
        }
        catch { }
    }

    function connectionFailure(error: unknown, stage: string, uncertain: boolean | undefined = false) {
        const safe = classifyOAuthError(error, stage);
        recordConnection('needs_attention', safe);
        return Object.assign(new SendError(safe.message, uncertain, true), { connectionCode: safe.code, connectionStage: safe.stage });
    }
    function client() { const config = store.get('google-config'); if (!config)
        throw Error('Save your Google OAuth client configuration first.'); return clientFactory(config.clientId, config.clientSecret); }
    function authenticated() { const account = store.get('gmail-account'); if (!account)
        throw new SendError('Connect Gmail first.'); const auth = client(); auth.setCredentials(account.tokens); auth.on('tokens', (tokens: Credentials) => { if (store.get('gmail-account')?.id === account.id)
        store.set('gmail-account', { ...account, tokens: { ...account.tokens, ...tokens } }); }); return { auth, account }; }
    return requireProvider({
        getAccount() { const account = store.get('gmail-account'); return account ? { id: account.id, email: account.email, provider: 'gmail' } : null; },
        getConnectionHealth() { const id = store.get('gmail-account')?.id || null; return health?.accountId === id ? health : { status: id ? 'unchecked' : 'disconnected' }; },
        checkConnectivity: () => checkGoogleConnectivity(connectivityRequest),
        configured: () => !!store.get('google-config'),
        async authorize(state: string) { const auth = client(), { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync(); return { verifier: codeVerifier, url: auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: gmailScopes, state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }) }; },
        async connect(code: string | null, verifier: string) {
            let stage = 'token_exchange';
            try {
                if (!code || !verifier)
                    throw new OAuthConnectionError('invalid_grant', stage);
                const auth = client(), { tokens } = await auth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri });
                if (!tokens.id_token)
                    throw new OAuthConnectionError('missing_identity_token', stage);
                if (!tokens.refresh_token)
                    throw new OAuthConnectionError('missing_refresh_token', stage);
                stage = 'identity_verification';
                const ticket = await auth.verifyIdToken({ idToken: tokens.id_token, audience: store.get('google-config')?.clientId });
                const identity = ticket.getPayload();
                if (!identity?.sub || identity.email_verified !== true || typeof identity.email !== 'string' || !mailbox.test(identity.email))
                    throw new OAuthConnectionError('identity_not_verified', stage);
                stage = 'permission_check';
                const granted = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : (await auth.getTokenInfo(tokens.access_token || '')).scopes;
                if (!Array.isArray(granted) || !granted.includes(gmailScopes[2]))
                    throw new OAuthConnectionError('gmail_permission_missing', stage);
                stage = 'credential_store';
                store.set('gmail-account', { id: identity.sub, email: identity.email, tokens });
                recordConnection('ready');
            }
            catch (error) {
                const safe = classifyOAuthError(error, stage);
                recordConnection('needs_attention', safe);
                throw safe;
            }
        },
        async disconnect() {
            const account = store.get('gmail-account');
            if (!account)
                return;
            try {
                await client().revokeToken(account.tokens.refresh_token || '');
            }
            finally {
                store.remove('gmail-account');
                health = null;
                store.remove('gmail-connection-status');
            }
        },
        async sendMessage(message: DeliveryPayload) {
            const { auth, account } = authenticated();
            if (message.sender !== account.email)
                throw new SendError('Connected sender changed. Review the batch again.');
            const raw = Buffer.from(mimeMessage(message)).toString('base64url');
            try {
                await auth.getAccessToken();
                recordConnection('ready');
            }
            catch (error) {
                throw connectionFailure(error, 'token_refresh');
            }
            try {
                const response = await auth.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', data: { raw }, retry: false, timeout: 30000 });
                const data =  response.data as { id?: string; };
                if (!data?.id)
                    throw new SendError('Gmail response did not include a message ID. Check Sent before retrying.', true);
                return { provider: 'gmail', messageId: data.id, status: 'accepted' };
            }
            catch (error) {
                if (error instanceof SendError)
                    throw error;
                const status =  (error as { response?: { status?: number; }; })?.response?.status;
                if (status === 401)
                    throw connectionFailure(error, 'token_refresh');
                if (status === 403)
                    recordConnection('needs_attention', new OAuthConnectionError('gmail_permission_missing', 'permission_check'));
                if (!status)
                    recordConnection('needs_attention', classifyOAuthError(error, 'connectivity'));
                throw new SendError(status ? `Gmail rejected the request (HTTP ${status}).` : 'Sending outcome is unknown. Check Gmail Sent; automatic retry is disabled.', !status || status >= 500, true);
            }
        }
    });
}

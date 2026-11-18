import type {LiveApi} from '../domain/types.js';

export function createLiveApi(fetcher: typeof globalThis.fetch = globalThis.fetch): LiveApi {

    let csrf: string | undefined;

    let sessionRequest: Promise<string> | null | undefined;

    async function request(path: string, value?: unknown) {
        if (!csrf) {
            sessionRequest ??= (async () => { const session = await fetcher('/api/session', { credentials: 'same-origin' }); if (!session.ok)
                throw Error('Start the local Node backend, then reload the app.'); return (await session.json()).csrf; })();
            try {
                csrf = await sessionRequest;
            }
            finally {
                sessionRequest = null;
            }
        }
        const response = await fetcher(path, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: value === undefined ? undefined : JSON.stringify(value) });
        const data = await response.json();
        if (!response.ok) {
            throw Object.assign(Error(data.error || 'Request failed.'), { status: response.status, code: data.code });
        }
        return data;
    }
    return request;
}

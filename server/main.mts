import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { gmailProvider } from './providers/gmail.mjs';
import { createQueue } from './sending.mjs';
import { createApplication } from './http.mjs';
import { acquireServerLock } from './lock.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.OFFICEPANTRY_PORT || 8765);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('Choose a port from 1024 to 65535.');
const origin = `http://127.0.0.1:${port}`;
const unlock = acquireServerLock(join(root, '.local'));
const store = openStore(join(root, '.local'));
const provider = gmailProvider({ store, redirectUri: origin + '/oauth/google/callback' });
const queue = createQueue({ store, provider });
const server = createApplication({ root, origin, store, provider });

let timer: NodeJS.Timeout | undefined;

let inFlight: Promise<unknown> = Promise.resolve();
let stopping = false;
server.on('error', (error: Error) => { console.error('code' in error && error.code === 'EADDRINUSE' ? 'Port already in use. Stop the old server before starting the Gmail backend.' : 'Unable to start local server.'); store.close(); unlock(); process.exitCode = 1; });
function work() {
    inFlight = queue.tick().then((result: { waitMs: number; }) => { if (!stopping)
        timer = setTimeout(work, result?.waitMs ?? 1000); }).catch(() => { console.error('Queue worker could not update its local record.'); if (!stopping)
        timer = setTimeout(work, 1000); });
}
server.listen(port, '127.0.0.1', () => { console.log(`Email Outreach: ${origin}/app/`); work(); });
function stop() { if (stopping)
    return; stopping = true; clearTimeout(timer); server.close(async () => { await inFlight; store.close(); unlock(); process.exit(0); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

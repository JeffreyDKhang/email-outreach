import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquireServerLock(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'server.lock');
    function write() { writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    try {
        write();
    }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
            throw error;
        const pid = Number(readFileSync(path, 'utf8'));
        let running = true;
        if (!Number.isInteger(pid) || pid <= 0)
            throw Error('Invalid local server lock. Check that no OfficePantry backend is running before removing .local/server.lock.');
        try {
            process.kill(pid, 0);
        }
        catch (probe) {
            if (probe instanceof Error && 'code' in probe && probe.code === 'ESRCH')
                running = false;
            else
                throw probe;
        }
        if (running)
            throw Error('An OfficePantry backend is already using this local database.');
        unlinkSync(path);
        write();
    }
    return () => { try {
        if (readFileSync(path, 'utf8') === String(process.pid))
            unlinkSync(path);
    }
    catch { } };
}

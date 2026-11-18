import type {WorkspaceRecord, WorkspaceSaved} from '../app/domain/types.js';
import { validateWorkspace } from '../app/domain/datasets.mjs';
// A missing row means migration has never run; an empty workspace is still saved.

export function createWorkspaceStore({ db, seal, unseal }: { db: import("node:sqlite").DatabaseSync; seal: (value: unknown) => string; unseal: (value: string) => unknown; }) {
    db.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL)');

    function readWorkspace(): WorkspaceRecord {
        const row =  db.prepare('SELECT revision,payload,updated FROM workspace WHERE id=1').get() as { revision: number; payload: string; updated: string; } | undefined;
        return row ? { workspace: validateWorkspace(unseal(row.payload)), revision: row.revision, updated: row.updated } : { workspace: null, revision: 0, updated: null };
    }

    function writeWorkspace(value: unknown, revision: number): WorkspaceSaved {
        validateWorkspace(value);
        if (!Number.isSafeInteger(revision) || revision < 0)
            throw Error('Invalid workspace revision.');
        const payload = seal(value);
        db.exec('BEGIN IMMEDIATE');
        try {
            const current = Number(db.prepare('SELECT revision FROM workspace WHERE id=1').get()?.revision ?? 0);
            if (current !== revision) {
                throw Object.assign(Error('This workspace changed in another tab or browser. Your edits are still here. Reload to load the newer saved workspace before saving again.'), { code: 'workspace_conflict' });
            }
            const updated = new Date().toISOString();
            db.prepare('INSERT INTO workspace(id,revision,payload,updated) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated=excluded.updated').run(current + 1, payload, updated);
            db.exec('COMMIT');
            return { revision: current + 1, updated };
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    return { readWorkspace, writeWorkspace };
}

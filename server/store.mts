import type {SQLOutputValue} from 'node:sqlite';
import type {DeliveryJob, DeliveryPayload, DeliveryResult, DeliveryStatus} from '../app/domain/types.js';
import type {Settings, StoredJobRow} from './types.js';
import { createOutboxStore } from './outbox-store.mjs';
import { createWorkspaceStore } from './workspace-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { requireAllowance, SEND_LIMIT } from './send-policy.mjs';

export function openStore(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = join(directory, 'key');
    if (!existsSync(keyFile))
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    const key = readFileSync(keyFile);
    const db = new DatabaseSync(join(directory, 'officepantry.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, recipient TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(account,recipient));`);
    if (!db.prepare('PRAGMA table_info(jobs)').all().some((column: Record<string, SQLOutputValue>) => column.name === 'attempted_at')) {
        db.exec('ALTER TABLE jobs ADD COLUMN attempted_at TEXT');
        db.exec("UPDATE jobs SET attempted_at=updated WHERE status IN ('sending','accepted','simulated','failed','unknown')");
    }
    // Replace recipient-level uniqueness with immutable message IDs. Preserve every historical row.
    if (String(db.prepare("SELECT sql FROM sqlite_master WHERE name='jobs'").get()?.sql || '').includes('UNIQUE(account,recipient)')) {
        db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE jobs RENAME TO jobs_legacy;
      CREATE TABLE jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,recipient TEXT NOT NULL,payload TEXT NOT NULL,
        status TEXT NOT NULL,result TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,attempted_at TEXT);
      INSERT INTO jobs SELECT id,account,recipient,payload,status,result,created,updated,attempted_at FROM jobs_legacy;
      DROP TABLE jobs_legacy;
      COMMIT;`);
    }
    if (!db.prepare('PRAGMA table_info(jobs)').all().some((column: Record<string, SQLOutputValue>) => column.name === 'history_cleared_at')) {
        db.exec('ALTER TABLE jobs ADD COLUMN history_cleared_at TEXT');
    }
    // An interrupted network operation may already have been accepted: never blindly resend.
    db.prepare("UPDATE jobs SET status='unknown',result=?,updated=? WHERE status='sending'").run(JSON.stringify({ error: 'Server restarted during sending. Check Gmail Sent before taking further action.' }), new Date().toISOString());

    function seal(value: unknown) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); }

    function unseal(value: string): unknown { const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')); }

    function insertJobs(items: DeliveryPayload[]) {
        if (!Array.isArray(items) || !items.length || items.length > SEND_LIMIT)
            throw Error('Queue between 1 and 500 messages.');
        const jobs =  db.prepare('SELECT account,recipient,status,created,attempted_at FROM jobs').all() as Pick<DeliveryJob, "status" | "account" | "recipient" | "created" | "attempted_at">[];
        for (const account of new Set(items.map((item: DeliveryPayload) => item.account)))
            requireAllowance(jobs, account, items.filter((item: DeliveryPayload) => item.account === account).length);
        const legacyRecipients = new Set(jobs.map((job: Pick<DeliveryJob, "status" | "account" | "recipient" | "created" | "attempted_at">) => JSON.stringify([job.account, job.recipient])));
        for (const item of items) {
            const legacyKey = JSON.stringify([item.account, item.recipient]);
            if (!item.outboxId && !item.directId && legacyRecipients.has(legacyKey))
                throw Error('An initial send for this recipient is already recorded.');
            legacyRecipients.add(legacyKey);
            const now = new Date().toISOString();
            db.prepare('INSERT INTO jobs (id,account,recipient,payload,status,result,created,updated) VALUES (?,?,?,?,?,?,?,?)').run(item.id, item.account, item.recipient, seal(item), 'queued', null, now, now);
        }
    }
    const outboxStore = createOutboxStore({ db, seal, unseal, insertJobs });
    return {
        db,
        ...outboxStore,
        ...createWorkspaceStore({ db, seal, unseal }),

        get<K extends keyof Settings>(name: K): Settings[K] | null { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(name); return row ?  unseal(String(row.value)) as Settings[K] : null; },

        set<K extends keyof Settings>(name: K, value: Settings[K]) { db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(name, seal(value)); },

        remove(name: string) { db.prepare('DELETE FROM settings WHERE key=?').run(name); },

        jobs(): DeliveryJob[] { return  (db.prepare('SELECT * FROM jobs ORDER BY created DESC').all() as unknown as StoredJobRow[]).map((row: StoredJobRow) => ({ ...row, payload: unseal(row.payload) as DeliveryPayload, result: row.result ? JSON.parse(row.result) : null })); },

        enqueue(items: DeliveryPayload[]) {
            db.exec('BEGIN IMMEDIATE');
            try {
                insertJobs(items);
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },

        update(id: string, status: DeliveryStatus, result: DeliveryResult | null | undefined = null) { const now = new Date().toISOString(); db.prepare('UPDATE jobs SET status=?,result=?,updated=?,attempted_at=CASE WHEN ?=\'sending\' THEN ? ELSE attempted_at END WHERE id=?').run(status, result ? JSON.stringify(result) : null, now, status, now, id); },
        cancelQueued() { db.prepare("UPDATE jobs SET status='cancelled',updated=? WHERE status='queued'").run(new Date().toISOString()); },

        clearHistory(ids: string[]) {
            if (!Array.isArray(ids) || !ids.length || ids.some((id: string) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
                throw Error('Choose completed history records to clear.');
            db.exec('BEGIN IMMEDIATE');
            try {
                const selected = new Set(ids), rows = db.prepare('SELECT id,status FROM jobs').all().filter((row: Record<string, SQLOutputValue>) => selected.has(String(row.id)));
                if (rows.length !== ids.length || rows.some((row: Record<string, SQLOutputValue>) => !['accepted', 'failed', 'unknown', 'cancelled', 'simulated'].includes(String(row.status))))
                    throw Error('Only completed history can be cleared. Queued or sending messages are kept.');
                const now = new Date().toISOString(), update = db.prepare('UPDATE jobs SET history_cleared_at=? WHERE id=? AND history_cleared_at IS NULL');
                let cleared = 0;
                for (const row of rows)
                    cleared += Number(update.run(now, row.id).changes);
                db.exec('COMMIT');
                return { cleared };
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        close() { db.close(); }
    };
}

import type {CryptoStore, HeldRequest, StoredOutboxRow} from './types.js';
import type {DeliveryPayload, MessageSnapshot} from '../app/domain/types.js';
// Durable holding area. Shares the queue's database and transaction for promotion.

export function createOutboxStore({ db, seal, unseal, insertJobs }: CryptoStore & { insertJobs: (items: import("../app/domain/types.js").DeliveryPayload[]) => void; }) {
    db.exec(`CREATE TABLE IF NOT EXISTS outbox_messages(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,
    batch_id TEXT,batch_name TEXT,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox_requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);`);
    const read = () =>  (db.prepare('SELECT * FROM outbox_messages ORDER BY created DESC,rowid DESC').all() as unknown as StoredOutboxRow[]).map((row: StoredOutboxRow) => ({ ...row, payload: unseal(row.payload) as MessageSnapshot }));

    function transaction<T>(work: () => T): T { db.exec('BEGIN IMMEDIATE'); try {
        const result = work();
        db.exec('COMMIT');
        return result;
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    } }

    function held(ids: string[]) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length)
            throw Error('Select between 1 and 500 messages.');
        const rows = read();
        if (ids.some((id: string) => !rows.some((row: { payload: import("../app/domain/types.js").MessageSnapshot; id: string; status: "held" | "queued"; batch_name?: string | null | undefined; batch_id?: string | null | undefined; created: string; }) => row.id === id && row.status === 'held')))
            throw Error('Only held Outbox messages can be changed. Refresh Outbox.');
    }
    return {
        outbox: read,

        addHeld(request: HeldRequest): { ids: string[]; } {
            return transaction(() => {
                const previous = db.prepare('SELECT * FROM outbox_requests WHERE id=?').get(request.requestId);
                if (previous) {
                    if (previous.digest !== request.digest)
                        throw Error('This request ID was used for different messages.');
                    return  unseal(String(previous.result)) as { ids: string[]; };
                }
                const now = new Date().toISOString();
                for (const message of request.messages)
                    db.prepare("INSERT INTO outbox_messages(id,payload,status,created) VALUES (?,?,'held',?)").run(message.id, seal(message.payload), now);
                const result = { ids: request.messages.map((message: { id: string; payload: MessageSnapshot; }) => message.id) };
                db.prepare('INSERT INTO outbox_requests VALUES (?,?,?)').run(request.requestId, request.digest, seal(result));
                return result;
            });
        },

        assignBatch(ids: string[], id: string, name: string) {
            return transaction(() => {
                held(ids);
                if (typeof name !== 'string' || !name.trim() || name.trim().length > 100)
                    throw Error('Enter a batch name between 1 and 100 characters.');
                for (const messageId of ids)
                    db.prepare('UPDATE outbox_messages SET batch_id=?,batch_name=? WHERE id=?').run(id, name.trim(), messageId);
                return { id, name: name.trim() };
            });
        },

        removeHeld(ids: string[]) { return transaction(() => { held(ids); for (const id of ids)
            db.prepare('DELETE FROM outbox_messages WHERE id=?').run(id); }); },

        enqueueHeld(items: DeliveryPayload[]) {
            return transaction(() => {
                held(items.map((item: DeliveryPayload) => { if (!item.outboxId)
                    throw Error('Only held Outbox messages can be changed. Refresh Outbox.'); return item.outboxId; }));
                // Only the server-prepared immutable snapshots may be promoted.
                insertJobs(items);
                for (const item of items)
                    db.prepare("UPDATE outbox_messages SET status='queued' WHERE id=?").run(item.outboxId ?? '');
            });
        },
    };
}

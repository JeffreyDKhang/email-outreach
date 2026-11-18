import type {Account, DeliveryJob, DeliveryPayload, HeldMessagesRequest, Lead, MessageSnapshot, OutboxMessage, SendPreview} from '../app/domain/types.js';
import { randomUUID, createHash } from 'node:crypto';
import { messageSnapshot } from '../app/domain/outbox.mjs';
import { validateRules } from '../app/domain/scoring.mjs';
import { requireAllowance, SEND_LIMIT } from './send-policy.mjs';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function prepareHeldMessages(input: unknown) {
    const value =  input as HeldMessagesRequest;
    if (!value || !Array.isArray(value.leads) || !value.leads.length || value.leads.length > SEND_LIMIT)
        throw Error('Add between 1 and 500 messages to Outbox.');
    if (typeof value.requestId !== 'string' || !/^[-a-zA-Z0-9]{16,100}$/.test(value.requestId))
        throw Error('Invalid Outbox request ID.');
    if (typeof value.datasetId !== 'string' || typeof value.datasetName !== 'string' || value.datasetName.length > 100)
        throw Error('Invalid dataset.');
    validateRules(value.rules);
    const messages = value.leads.map((lead: Lead) => messageSnapshot(lead, value.rules, value));
    return { requestId: value.requestId, digest: digest(messages), messages: messages.map((payload: MessageSnapshot) => ({ id: randomUUID(), payload })) };
}

export function prepareOutboxSend(messages: Omit<OutboxMessage, "created">[], ids: string[], account: Account | null, jobs: DeliveryJob[]): SendPreview {
    if (!account)
        throw Error('Connect Gmail first.');
    if (!Array.isArray(ids) || !ids.length || ids.length > SEND_LIMIT || new Set(ids).size !== ids.length)
        throw Error('Select between 1 and 500 distinct Outbox messages.');
    requireAllowance(jobs, account.id, ids.length);
    const selected = ids.map((id: string) => {
        const message = messages.find((message: Omit<OutboxMessage, "created">) => message.id === id && message.status === 'held');
        if (!message)
            throw Error('An Outbox message is no longer on hold. Refresh Outbox.');
        return message;
    });
    const items = selected.map((message: Omit<OutboxMessage, "created">) => {
        const payload = message.payload;
        if (payload.synthetic || /(^|@|\.)example\.(com|org|net)$/i.test(payload.recipient))
            throw Error('Synthetic demo contacts cannot receive real emails.');
        return { ...payload, id: message.id, outboxId: message.id, batchId: message.batch_id, batchName: message.batch_name,
            account: account.id, sender: account.email, provider: account.provider };
    });
    return { id: randomUUID(), digest: digest(items), items, expires: Date.now() + 10 * 60 * 1000 };
}
// Uses the same immutable-copy checks as Outbox delivery without creating held rows.

export function prepareInstantSend(value: unknown, account: Account | null, jobs: DeliveryJob[]) {
    const request = prepareHeldMessages(value);
    const messages = request.messages.map((message: { id: `${string}-${string}-${string}-${string}-${string}`; payload: MessageSnapshot; }, index: number) => ({ ...message, id: 'instant-' + digest([request.requestId, index]), status: 'held' as const }));
    const preview = prepareOutboxSend(messages, messages.map((message: { id: string; status: "held"; payload: MessageSnapshot; }) => message.id), account, jobs);
    preview.items = preview.items.map(({ outboxId, ...item }: DeliveryPayload) => ({ ...item, directId: item.id }));
    preview.digest = digest(preview.items);
    preview.kind = 'instant';
    return preview;
}

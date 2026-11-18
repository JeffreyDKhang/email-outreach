import type {Account, DeliveryJob, Lead, Rules, SendPreview} from '../app/domain/types.js';
import { randomUUID, createHash } from 'node:crypto';
import { isApproved } from '../app/domain/outreach.mjs';
import { validateRules } from '../app/domain/scoring.mjs';
import { SEND_LIMIT, requireAllowance } from './send-policy.mjs';

export function prepareLiveBatch(leads: Lead[], rules: Rules, account: Account | null, existing: DeliveryJob[]): SendPreview {
    validateRules(rules);
    if (!account)
        throw Error('Connect Gmail first.');
    if (!Array.isArray(leads) || !leads.length || leads.length > SEND_LIMIT)
        throw Error('Select between 1 and 500 approved drafts.');
    requireAllowance(existing, account.id, leads.length);
    const recipients = new Set(existing.filter((job: DeliveryJob) => job.account === account.id).map((job: DeliveryJob) => job.recipient)), items = [];
    for (const lead of leads) {
        if (lead.data_origin === 'synthetic' || /(^|@|\.)example\.(com|org|net)$/i.test(lead.email || ''))
            throw Error('Synthetic demo contacts cannot receive real emails. Import your real contacts first.');
        if (lead.outbox?.length || lead.live_delivery || lead.reply || !isApproved(lead, rules))
            throw Error('Every real message needs a current eligible approved draft with no prior outreach.');
        const recipient = lead.email.trim().toLowerCase();
        if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient))
            throw Error('Recipient must be a single valid email address.');
        if (recipients.has(recipient))
            throw Error('This sender already has a queued or recorded initial message for a selected recipient.');
        if (/[\r\n]/.test(lead.draft.subject) || lead.draft.subject.length > 500 || lead.draft.body.length > 50000)
            throw Error('Invalid subject or message too large.');
        recipients.add(recipient);
        items.push({ id: randomUUID(), account: account.id, sender: account.email, provider: account.provider, recipient, subject: lead.draft.subject, body: lead.draft.body, leadId: lead.lead_id, version: lead.draft.version, approvedAt: lead.approval.at });
    }
    const digest = createHash('sha256').update(JSON.stringify(items)).digest('hex');
    return { id: randomUUID(), digest, items, expires: Date.now() + 10 * 60 * 1000 };
}

export function createQueue({ store, provider, now = Date.now }: { store: import("./types.js").QueueStore; provider: Pick<import("../app/domain/types.js").EmailProvider, "sendMessage">; now?: () => number; }) {
    let busy = false;
    return { async tick() {
            if (busy)
                return { waitMs: 1000 };
            busy = true;
            try {
                if (store.get?.('sending-pause'))
                    return { waitMs: 1000 };
                const job = store.jobs().filter((r: DeliveryJob) => r.status === 'queued').sort((a: DeliveryJob, b: DeliveryJob) => a.created.localeCompare(b.created))[0];
                if (!job)
                    return { waitMs: 1000 };
                const delay = (store.get?.('sending-settings')?.delaySeconds || 0) * 1000;
                const previous = store.jobs().filter((r: DeliveryJob) => r.account === job.account && r.attempted_at).reduce((latest: number, r: DeliveryJob) => Math.max(latest, Date.parse(r.attempted_at || '')), 0);
                const waitMs = previous + delay - now();
                if (waitMs > 0)
                    return { waitMs: Math.min(waitMs, 1000) };
                store.update(job.id, 'sending');
                let submitted = false;
                try {
                    const result = await provider.sendMessage(job.payload);
                    submitted = true;
                    store.update(job.id, result.status === 'simulated' ? 'simulated' : 'accepted', result);
                }
                catch (cause) {
                    // Provider failures may carry queue/connection flags in addition to Error.
                    const error =  cause as { message?: string; uncertain?: boolean; pauseQueue?: boolean; connectionCode?: string; connectionStage?: string; };
                    store.update(job.id, submitted || error.uncertain ? 'unknown' : 'failed', { error: submitted ? 'Provider returned acceptance but recording it failed. Check Gmail Sent.' : error.message,
                        ...(error.connectionCode ? { code: error.connectionCode, stage: error.connectionStage } : {}) });
                    if (error.pauseQueue || error.uncertain || submitted)
                        store.set?.('sending-pause', { reason: 'Sending paused after a provider or uncertain-outcome error. Check the queue and Gmail Sent before resuming.', at: new Date(now()).toISOString() });
                }
                return { waitMs: 0 };
            }
            finally {
                busy = false;
            }
        } };
}

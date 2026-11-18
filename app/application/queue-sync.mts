import type {DeliveryPayload, DeliveryUpdate, Lead} from '../domain/types.js';
import { recipientEmail } from '../domain/lead-schema.mjs';
const statuses = new Set(['queued', 'sending', 'accepted', 'failed', 'unknown', 'cancelled', 'simulated']);

export function applyDeliveryJobs(leads: Lead[], jobs: DeliveryUpdate[]): Lead[] {

    const latest: Map<string, DeliveryUpdate> = new Map();
    for (const job of jobs) {
        if (!job.payload?.leadId || !statuses.has(job.status))
            continue;
        const old = latest.get(job.payload.leadId);
        if (!old || String(job.updated || job.created || '') > String(old.updated || old.created || '')) {
            latest.set(job.payload.leadId, job);
        }
    }
    let changed = false;
    const next = leads.map((lead: Lead) => {
        const job = latest.get(lead.lead_id);
        if (!job || job.recipient?.toLowerCase() !== recipientEmail(lead).toLowerCase())
            return lead;
        const delivery = { status: job.status, sender: job.payload.sender, messageId: job.result?.messageId };
        const outreachStatus = job.status === 'accepted' ? 'Gmail accepted' : 'Real ' + job.status;
        if (lead.live_delivery?.status === delivery.status && lead.live_delivery?.sender === delivery.sender &&
            lead.live_delivery?.messageId === delivery.messageId && lead.outreach_status === outreachStatus)
            return lead;
        changed = true;
        return { ...lead, live_delivery: delivery, outreach_status: outreachStatus };
    });
    return changed ? next : leads;
}

export function markBatchQueued(leads: Lead[], items: DeliveryPayload[]) {
    return applyDeliveryJobs(leads, items.map((item: DeliveryPayload) => ({ payload: item, recipient: item.recipient, status: 'queued' })));
}

export function createQueueSync({ api, getLeads, save }: { api: import("../domain/types.js").LiveApi; getLeads: () => import("../domain/types.js").Lead[]; save: (leads: import("../domain/types.js").Lead[]) => boolean | Promise<boolean>; }) {
    async function refresh() {
        const { jobs } = await api('/api/live/jobs');
        // Read current state after the response, so a delayed request cannot replace
        // edits or datasets from before the network round trip.
        const leads = getLeads();
        const next = applyDeliveryJobs(leads, jobs);
        if (next !== leads && !await save(next))
            throw Error('Queue status could not be saved. Refresh to try again.');
        return jobs;
    }
    return {
        refresh,

        async clearHistory(ids: string[]) {
            await api('/api/live/history/clear', { ids });
            return refresh();
        },
        async cancel() {
            await api('/api/live/cancel', {});
            return refresh();
        },
    };
}

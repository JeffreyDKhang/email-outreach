import type {Lead, Rules} from './types.js';
import { approveDraft, isApproved } from './outreach.mjs';
import { simulateInitial } from './delivery.mjs';

export function applyBatch(leads: Lead[], preview: (Lead & { draft: import("./types.js").Draft; })[], rules: Rules, action: "approve" | "send") {
    if (!['approve', 'send'].includes(action))
        throw Error('Unsupported batch action.');
    const accepted = [], excluded = [], seen = new Set();
    for (const item of preview) {
        if (seen.has(item.lead_id))
            continue;
        seen.add(item.lead_id);
        const lead = leads.find((r: Lead) => r.lead_id === item.lead_id);
        try {
            if (!lead)
                throw Error('Lead no longer exists.');
            if (!lead.draft || lead.draft.version !== item.draft.version || lead.draft.subject !== item.draft.subject || lead.draft.body !== item.draft.body || lead.email !== item.email)
                throw Error('Draft or recipient changed. Reopen the preview.');
            if (action === 'send' && !isApproved(lead, rules))
                throw Error('Current draft needs approval.');
            accepted.push(action === 'approve' ? approveDraft(lead, rules) : simulateInitial(lead, rules));
        }
        catch (error) {
            excluded.push({ lead: lead || item, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { accepted, excluded };
}

import type {Draft, Lead} from './types.js';
import { fields, recipientEmail, leadTitle } from './lead-schema.mjs';

function entries(value: Record<string, unknown> | undefined = {}) {
    return Object.keys(value).sort().map((key: string) => [key, value[key] ?? '']);
}
// Version 2 covers every supported source field and explicit structural changes.
// Workflow state (drafts, delivery, activity) is deliberately outside this snapshot.

export function sourceSnapshot(lead: Lead) {
    const revision = lead.source_revision ?? 0;
    return JSON.stringify(lead.values
        ? { version: 2, revision, values: entries(lead.values), recipientColumn: lead.recipient_column, email: lead.email }
        : { version: 2, revision, fields: fields.filter((key: string) => key !== 'lead_id').map((key: string) => [key, lead[key] ?? '']), extras: entries(lead.extra_fields) });
}

export function draftSourceIsCurrent(lead: Lead, draft: Draft) {
    if (draft.sourceVersion === 2)
        return draft.sourceKey === sourceSnapshot(lead);
    // Earlier native snapshots already covered all CSV cells. Older legacy
    // snapshots omitted fields, so unsent legacy drafts need regeneration once.
    if (lead.values && !lead.source_revision && draft.sourceVersion == null) {
        return draft.sourceKey === JSON.stringify([lead.values, lead.recipient_column, lead.email]);
    }
    return false;
}

export function assertSourceEditable(lead: Lead) {
    if (lead.messageWorkflow !== 2 && (lead.live_delivery || lead.outbox?.length))
        throw Error('Queued or sent leads are read-only.');
}

export function finalizeSourceChange(lead: Lead, type: string): Lead {
    assertSourceEditable(lead);
    const next = {
        ...lead,
        source_revision: (lead.source_revision ?? 0) + 1,
        approval: null,
        ...(lead.draft ? { outreach_status: 'Drafted' } : {}),
        activity: [...(lead.activity || []), { type, version: lead.draft?.version || 0, at: new Date().toISOString() }],
    };
    next.email = recipientEmail(next);
    if (next.values) {
        next.company = leadTitle(next);
        next.import_fingerprint = JSON.stringify([next.recipient_column, Object.entries(next.values)]);
        if (next.values.data_origin === 'synthetic')
            next.data_origin = 'synthetic';
    }
    else {
        delete next.import_fingerprint;
    }
    return next;
}

import type {Draft, Lead} from './types.js';
// lead.draft remains the selected message for existing review/send workflows.
// Read old single-draft records without changing their content or source snapshot.

export function leadDrafts(lead: Lead): Draft[] {
    const drafts = [...(lead.drafts || [])];
    if (lead.draft) {
        const draft = { ...lead.draft, id: lead.activeDraftId || lead.draft.id || 'initial' };
        const index = drafts.findIndex((item: Draft) => item.id === draft.id);
        if (index < 0)
            drafts.push(draft);
        else
            drafts[index] = draft;
    }
    return drafts;
}

export function saveActiveDraft(lead: Lead, draft: Draft): Lead & { draft: import("./types.js").Draft; } {
    const id = lead.activeDraftId || lead.draft?.id || (lead.draft ? 'initial' : crypto.randomUUID());
    const next = { ...draft, id }, drafts = leadDrafts(lead);
    const index = drafts.findIndex((item: Draft) => item.id === id);
    if (index < 0)
        drafts.push(next);
    else
        drafts[index] = next;
    return { ...lead, draft: next, drafts, activeDraftId: id };
}

export function selectDraft(lead: Lead, id: string): Lead & { draft: import("./types.js").Draft; } {
    const drafts = leadDrafts(lead), draft = drafts.find((item: Draft) => item.id === id);
    if (!draft)
        throw Error('This draft no longer exists. Reopen the message review.');
    return { ...lead, draft, drafts, activeDraftId: id, approval: null, outreach_status: 'Drafted' };
}
// Sending transports need the selected message, not every saved alternative.

export function selectedDraftOnly(lead: Lead) {
    const { drafts, ...selected } = lead;
    return selected;
}

import type {BatchOptions} from './types.js';
import type {Lead} from '../domain/types.js';
import { findById, inputs, byId as $, errorMessage, eventElement } from './dom.mjs';
import { sourceSnapshot } from '../domain/source-state.mjs';
import { generateDraft, messageIssues } from '../domain/outreach.mjs';

export function mountBatch({ getLeads, getVisibleIds, getRules, getTemplates, outboxService, liveSender, save, escape: e }: BatchOptions) {

    let selected: Set<string> = new Set();

    let preview: (Lead & { draft: import("../domain/types.js").Draft; })[] = [];
    let busy = false, reviewRules = '';
    const dialog = document.createElement('dialog');
    dialog.id = 'batch-dialog';
    dialog.innerHTML = '<div class="dialog-heading"><h2>Review selected messages</h2><button id="close-batch">Close</button></div><p>Choose Send to outbox to hold these messages, or Instant send Email to skip holding and review a real-send confirmation.</p><div id="batch-content"></div><div class="actions"><button id="batch-to-outbox">Send to outbox</button><button id="batch-instant-send" class="primary">Instant send Email</button></div><p id="batch-message" role="status"></p>';
    document.body.append(dialog);
    function selectionState() {
        const ids = getVisibleIds();
        $('batch').disabled = !selected.size;
        $('batch').textContent = `Selected lead(s) message (${selected.size})`;
        const all = findById('select-all');
        if (all) {
            all.checked = ids.length > 0 && ids.every((id: string) => selected.has(id));
            all.indeterminate = selected.size > 0 && !all.checked;
        }
        for (const input of inputs($('leads'), '[data-select]'))
            input.checked = selected.has(input.dataset.select || '');
    }
    $('leads').addEventListener('change', (event: Event) => { const id = eventElement(event).dataset.select; if (!id)
        return;   (eventElement(event) as HTMLInputElement).checked ? selected.add(id) : selected.delete(id); selectionState(); });
    $('table-head').addEventListener('change', (event: Event) => { if (eventElement(event).id !== 'select-all')
        return; selected =  (eventElement(event) as HTMLInputElement).checked ? new Set(getVisibleIds()) : new Set(); selectionState(); });
    function draw() {
        $('batch-content').innerHTML = preview.map((row: Lead & { draft: import("../domain/types.js").Draft; }) => `<article class="score-card"><h3>${e(row.company)}</h3><p>To: ${e(row.email)}</p><strong>${e(row.draft.subject)}</strong><pre>${e(row.draft.body)}</pre>${messageIssues(row, getRules()).map((issue: string) => `<p class="warning">${e(issue)}</p>`).join('')}</article>`).join('');
        const invalid = preview.some((row: Lead & { draft: import("../domain/types.js").Draft; }) => messageIssues(row, getRules()).length);
        $('batch-to-outbox').disabled = busy || !preview.length || invalid;
        $('batch-instant-send').disabled = busy || !preview.length || invalid;
    }
    $('batch').onclick = () => {
        preview = [];
        reviewRules = JSON.stringify(getRules());
        const errors = [];
        for (const lead of getLeads().filter((row: Lead) => selected.has(row.lead_id)))
            try {
                preview.push(lead.draft ? { ...lead, draft: lead.draft } : generateDraft(lead, getTemplates(), 'merge', getRules()));
            }
            catch (error) {
                errors.push(errorMessage(error));
            }
        $('batch-message').textContent = errors.join(' ');
        draw();
        dialog.showModal();
    };
    $('close-batch').onclick = () => dialog.close();
    async function saveReviewedDrafts() {
        if (JSON.stringify(getRules()) !== reviewRules)
            throw Error('Settings changed. Reopen selected messages to review again.');
        const current = getLeads(), updates = new Map();
        for (const row of preview) {
            const lead = current.find((lead: Lead) => lead.lead_id === row.lead_id);
            if (!lead || sourceSnapshot(lead) !== sourceSnapshot(row) || (lead.draft && JSON.stringify(lead.draft) !== JSON.stringify(row.draft)))
                throw Error('A selected lead or message changed. Reopen the review.');
            const issues = messageIssues(row, getRules());
            if (issues.length)
                throw Error(issues.join(' '));
            if (!lead.draft)
                updates.set(row.lead_id, row);
        }
        if (updates.size && !await save(current.map((row: Lead) => updates.get(row.lead_id) || row)))
            throw Error('Messages could not be saved. Nothing was sent or added to Outbox.');
        return preview;
    }

    async function act(instant: boolean) {
        if (busy)
            return;
        busy = true;
        draw();
        try {
            const rows = await saveReviewedDrafts();
            if (instant) {
                await liveSender.openInstant(rows);
            }
            else {
                await outboxService.add(rows);
                $('batch-message').textContent = `${rows.length} copies added to Outbox and held. No emails sent.`;
            }
        }
        catch (error) {
            $('batch-message').textContent = errorMessage(error);
        }
        finally {
            busy = false;
            draw();
        }
    }
    $('batch-to-outbox').onclick = () => act(false);
    $('batch-instant-send').onclick = () => act(true);
    return { getSelectedIds: () => [...selected], clearSelection() { selected.clear(); selectionState(); } };
}

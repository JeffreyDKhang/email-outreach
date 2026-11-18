import type {OutreachOptions} from './types.js';
import type {Activity, Draft, Lead} from '../domain/types.js';
import { byId as $, errorMessage } from './dom.mjs';
import { mountBatch } from './batch-ui.mjs';
import { mountTemplates } from './templates-ui.mjs';
import { generateDraft, createAdditionalDraft, editDraft, messageIssues, templateNames, defaultTemplateName, manualTemplate } from '../domain/outreach.mjs';
import { leadDrafts, selectDraft } from '../domain/draft-state.mjs';
import { scoreLead } from '../domain/scoring.mjs';

export function mountOutreach({ unsavedChanges, getLeads, getColumns, getVisibleIds, getRules, save, repository, liveSender, outboxService, escape: e, notice }: OutreachOptions) {

    let activeId: string | null = null;
    const templateEditor = mountTemplates({ unsavedChanges, repository, getLeads, getColumns, getRules, escape: e, notice });
    const batch = mountBatch({ getLeads, getVisibleIds, getRules, getTemplates: templateEditor.getTemplates, outboxService, liveSender, save, escape: e });
    const dialog = document.createElement('dialog');
    dialog.id = 'outreach-review';
    dialog.innerHTML = '<div class="dialog-heading"><h2>Review Message</h2><button id="close-review">Close</button></div><div id="review-content"></div>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog, { selector: '#draft-subject,#draft-body' });
    function current() { const lead = getLeads().find((r: Lead) => r.lead_id === activeId); if (!lead)
        throw Error('This lead no longer exists. Reopen the review.'); return lead; }

    function persistLead(next: Lead) { return save(getLeads().map((r: Lead) => r.lead_id === next.lead_id ? next : r)); }
    function review() {
        const lead = current();
        if (!lead)
            return;
        const rules = getRules(), config = templateEditor.getTemplates(), result = scoreLead(lead, rules), draft = lead.draft;
        const drafts = leadDrafts(lead), draftId = lead.activeDraftId || draft?.id || 'initial';
        const locked = false;
        const selected = draft?.templateName ?? defaultTemplateName(lead, config, rules);
        const names = templateNames(config);
        if (selected !== manualTemplate && !names.includes(selected))
            names.push(selected);
        $('review-content').innerHTML = `<h3>${e(lead.company)}</h3><p>To: ${e(lead.email || 'No email supplied')}<br>${e(result.segment)} &middot; ${result.score}/${result.maximum} &middot; ${e(result.eligibility)}</p>
      ${draft ? `<label>Saved drafts for this lead<select id="lead-draft">${drafts.map((item: Draft, index: number) => `<option value="${e(item.id)}" ${item.id === draftId ? 'selected' : ''}>Draft ${index + 1} &middot; ${e(item.templateName === manualTemplate ? 'Manually from scratch' : item.templateName || 'General')}${item.subject ? ' · ' + e(item.subject) : ''}</option>`).join('')}</select></label>` : ''}
      <button id="additional-draft">Create additional draft</button>
      <label>Template for this draft<select id="lead-template" ${locked ? 'disabled' : ''}>${names.map((name: string) => `<option value="${e(name)}" ${name === selected ? 'selected' : ''}>${e(name)}${Object.hasOwn(config, name) ? '' : ' (removed)'}</option>`).join('')}<option value="${manualTemplate}" ${selected === manualTemplate ? 'selected' : ''}>Manually from scratch</option></select></label>
      <p>Each draft keeps its own template and saved edits. Create an additional draft, then choose its template. Reset draft restores only the selected draft with current lead values; manually written drafts reset to blank.</p>
      <button id="generate-draft" ${locked ? 'disabled' : ''}>${draft ? 'Reset draft' : 'Create draft'}</button>
      ${draft ? `<p>Version ${draft.version} &middot; <strong id="draft-save-state">${locked ? 'Read-only: delivery recorded' : 'Saved draft'}</strong></p><label>Subject<input id="draft-subject" value="${e(draft.subject)}" ${locked ? 'readonly' : ''}></label><label>Message<textarea id="draft-body" rows="11" ${locked ? 'readonly' : ''}>${e(draft.body)}</textarea></label><div class="actions"><button id="save-draft" ${locked ? 'disabled' : ''}>Save edits</button><button id="send-to-outbox" class="primary">Send to Outbox</button></div>` : ''}
      <p id="review-message" role="status">${draft && !locked ? e(messageIssues(lead, rules).join(' ').replaceAll('before approval', 'before adding to Outbox').replaceAll('Regenerate the draft', 'Reset the draft')) : ''}</p><h3>Activity</h3><ul>${(lead.activity || []).map((event: Activity) => `<li>${e(event.type)} &middot; v${event.version} &middot; ${e(event.at)}</li>`).join('') || '<li>No outreach activity yet.</li>'}</ul><p>Send to Outbox holds a frozen message copy; it does not send email. You can edit this draft and add another variation. Actual delivery starts only from Outbox after a sender/message confirmation.</p>`;

        async function reset(selection: string) {
            try {
                if (draft && !confirm('Reset this draft to the selected template? Unsaved and saved edits will be replaced. Existing Outbox copies are kept.')) {
                    $('lead-template').value = selected;
                    return;
                }
                if (await persistLead(generateDraft(current(), templateEditor.getTemplates(), 'merge', getRules(), selection)))
                    review();
                else {
                    $('lead-template').value = selected;
                    $('review-message').textContent = 'Draft could not be saved. Your saved draft is unchanged.';
                }
            }
            catch (error) {
                $('lead-template').value = selected;
                $('review-message').textContent = errorMessage(error);
            }
        }
        unsaved?.reset();
        $('generate-draft').onclick = () => reset($('lead-template').value);
        $('lead-template').onchange = () => reset($('lead-template').value);
        function requireSaved() {
            if (draft && ($('draft-subject').value !== current().draft?.subject || $('draft-body').value !== current().draft?.body)) {
                $('review-message').textContent = 'Save edits before switching drafts or creating an additional draft.';
                return false;
            }
            return true;
        }
        $('additional-draft').onclick = async () => {
            if (!requireSaved())
                return;
            try {
                if (await persistLead(createAdditionalDraft(current(), templateEditor.getTemplates(), getRules(), $('lead-template').value)))
                    review();
                else
                    $('review-message').textContent = 'Additional draft could not be saved. Your existing drafts are unchanged.';
            }
            catch (error) {
                $('review-message').textContent = errorMessage(error);
            }
        };
        if (draft) {
            $('lead-draft').onchange = async () => {
                if (!requireSaved()) {
                    $('lead-draft').value = draftId;
                    return;
                }
                try {
                    if (await persistLead(selectDraft(current(), $('lead-draft').value)))
                        review();
                    else {
                        $('lead-draft').value = draftId;
                        $('review-message').textContent = 'Draft selection could not be saved.';
                    }
                }
                catch (error) {
                    $('lead-draft').value = draftId;
                    $('review-message').textContent = errorMessage(error);
                }
            };
            const changed = () => { $('draft-save-state').textContent = 'Unsaved edits'; $('review-message').textContent = 'Save edits before adding to Outbox. Closing discards unsaved edits.'; };
            $('draft-subject').oninput = changed;
            $('draft-body').oninput = changed;
            $('save-draft').onclick = async () => { try {
                if (await persistLead(editDraft(current(), $('draft-subject').value, $('draft-body').value)))
                    review();
            }
            catch (error) {
                $('review-message').textContent = errorMessage(error);
            } };
            $('send-to-outbox').onclick = async () => {
                const button = $('send-to-outbox');
                button.disabled = true;
                try {
                    const lead = current();
                    if ($('draft-subject').value !== lead.draft?.subject || $('draft-body').value !== lead.draft?.body)
                        throw Error('Save your edits before adding this message to Outbox.');
                    await outboxService.add([lead]);
                    $('review-message').textContent = 'Message copy added to Outbox and held. No email sent. Edit this draft to prepare another variation.';
                }
                catch (error) {
                    $('review-message').textContent = errorMessage(error);
                }
                finally {
                    button.disabled = false;
                }
            };
        }
    }
    $('close-review').onclick = () => $('outreach-review').close();
    return {

        async open(lead: Lead) { activeId = lead.lead_id; if (!current().draft) {
            try {
                await persistLead(generateDraft(current(), templateEditor.getTemplates(), 'merge', getRules()));
            }
            catch (error) {
                notice(errorMessage(error));
            }
        } review(); $('outreach-review').showModal(); }, clearSelection: batch.clearSelection, getSelectedIds: batch.getSelectedIds
    };
}

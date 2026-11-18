import type {LeadEditOptions} from './types.js';
import type {Column, Lead} from '../domain/types.js';
import { closest, byId as $, errorMessage, eventElement } from './dom.mjs';
import { editableColumns, editLeadField } from '../domain/lead-edit.mjs';
import { sourceValue } from '../domain/lead-schema.mjs';

export function mountLeadEdit({ unsavedChanges, getDataset, save, escape: e, notice }: LeadEditOptions) {

    let editing: { datasetId: string; id: string; key: string; original: string; } | null = null;
    const dialog = document.createElement('dialog');
    dialog.id = 'edit-field-dialog';
    dialog.innerHTML = '<form id="edit-field-form"><div class="dialog-heading"><h2 id="edit-field-title">Edit field</h2></div><p>Changes are saved only when you confirm. Reset existing working drafts after a source change. Outbox and delivery copies stay unchanged.</p><label for="field-edit-value">New value</label><textarea id="field-edit-value" rows="4"></textarea><p id="field-edit-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save change</button><button type="button" id="discard-field-edit">Cancel</button></div></form>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog);
    $('discard-field-edit').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { editing = null; $('field-edit-value').value = ''; });
    $('edit-field-form').onsubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        try {
            const dataset = getDataset();
            if (!editing || !dataset || dataset.id !== editing.datasetId)
                throw Error('The dataset changed. Cancel and reopen the field.');
            const current = dataset.leads.find((row: Lead) => row.lead_id === editing?.id);
            if (!current || String(sourceValue(current, editing.key)) !== editing.original)
                throw Error('This field changed since you opened it. Cancel and reopen it.');
            const next = editLeadField(current, editing.key, $('field-edit-value').value, dataset.leads);
            if (next === current) {
                dialog.close();
                return;
            }
            if (!await save(dataset.leads.map((row: Lead) => row.lead_id === next.lead_id ? next : row)))
                throw Error('Unable to save this change. Your saved value is unchanged.');
            dialog.close();
            notice('Field updated. Scores and data quality refreshed; reset any existing working draft before adding it to Outbox.');
        }
        catch (error) {
            $('field-edit-error').textContent = errorMessage(error);
        }
    };

    function open(id: string, key: string) {
        const dataset = getDataset(), lead = dataset?.leads.find((row: Lead) => row.lead_id === id);
        const column = lead && editableColumns(lead).find((column: Column) => column.key === key);
        if (!column || !lead || !dataset)
            return;
        editing = { id, key, datasetId: dataset.id, original: String(sourceValue(lead, key)) };
        $('edit-field-title').textContent = 'Edit ' + column.label;
        $('field-edit-value').value = editing.original;
        $('field-edit-error').textContent = '';
        unsaved?.reset();
        dialog.showModal();
        $('field-edit-value').focus();
    }
    $('leads').addEventListener('click', (event: PointerEvent) => { const button = closest(eventElement(event), '[data-edit-field]'); if (button)
        open(button.dataset.editLead || '', button.dataset.editField || ''); });
}

import type {DatasetToolsOptions} from './types.js';
import type {Column, Dataset, Lead} from '../domain/types.js';
import { closest } from './dom.mjs';
import { byId as $, errorMessage, eventElement } from './dom.mjs';
import { datasetColumns, datasetRecipientKey } from '../domain/lead-schema.mjs';
import { addDatasetRow, deleteDatasetRows, addDatasetColumn, deleteDatasetColumn, columnDependencies, exportDatasetCSV } from '../domain/dataset-tools.mjs';

export function mountDatasetTools({ unsavedChanges, getDataset, getSelectedIds, onSave, escape: e, notice }: DatasetToolsOptions) {

    let snapshot: Dataset | null | undefined;

    let action: string | null | undefined;

    let selected: string[] = [];
    const dialog = document.createElement('dialog');
    dialog.id = 'dataset-tools-dialog';
    dialog.innerHTML = '<div class="dialog-heading"><h2 id="data-tools-title">Data tools</h2><button id="close-data-tools">Close</button></div><p>For quick, small corrections. Prepare and clean larger datasets outside this app.</p><div id="data-tools-menu" class="actions"><button data-tool="row-add">Add row</button><button data-tool="row-delete">Delete selected rows</button><button data-tool="column-add">Add column</button><button data-tool="column-delete">Delete column</button><button data-tool="export-source">Export source data CSV</button><button data-tool="export-report">Export outreach report CSV</button></div><p>Source data includes your contact fields and saved corrections. Outreach report also includes current scores and tracked statuses; it is a snapshot, not a restorable backup. Both exports include all rows.</p><form id="data-tools-form" hidden><div id="data-tools-fields"></div><p id="data-tools-error" role="alert"></p><div class="actions"><button id="confirm-data-tool" class="primary" type="submit">Confirm</button><button id="cancel-data-tool" type="button">Cancel</button></div></form>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog, { active: () => dialog.open && !$('data-tools-form').hidden });
    function menu() { action = null; $('data-tools-title').textContent = 'Data tools'; $('data-tools-menu').hidden = false; $('data-tools-form').hidden = true; $('close-data-tools').hidden = false; }
    $('open-data-tools').onclick = () => { snapshot = getDataset(); if (!snapshot)
        return; menu(); dialog.showModal(); };
    $('close-data-tools').onclick = () => dialog.close();
    $('cancel-data-tool').onclick = menu;
    function current() { const dataset = getDataset(); if (!dataset || dataset.id !== snapshot?.id)
        throw Error('The dataset changed. Close and reopen Data tools.'); return dataset; }
    $('data-tools-menu').onclick = (event: PointerEvent) => {
        const button = closest(eventElement(event), '[data-tool]');
        if (!button)
            return;
        try {
            const dataset = current(), columns = datasetColumns(dataset);
            action = button.dataset.tool;
            if (action === 'export-source' || action === 'export-report') {
                const mode = action === 'export-report' ? 'report' : 'source';
                const csv = exportDatasetCSV(dataset, mode), url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
                const link = document.createElement('a');
                link.href = url;
                link.download = dataset.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') + (mode === 'report' ? '-outreach-report' : '-source-data') + '.csv';
                document.body.append(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                dialog.close();
                notice(`Exported all ${dataset.leads.length} rows from ${dataset.name} as ${mode === 'report' ? 'an outreach report snapshot' : 'source data'}.`);
                return;
            }
            selected = getSelectedIds();

            const titles: Record<string, string> = { 'row-add': 'Add one row', 'row-delete': 'Delete selected rows', 'column-add': 'Add column', 'column-delete': 'Delete column' };
            $('data-tools-title').textContent = titles[action || ''];
            $('data-tools-menu').hidden = true;
            $('data-tools-form').hidden = false;
            $('close-data-tools').hidden = true;
            $('data-tools-error').textContent = '';
            $('confirm-data-tool').textContent = 'Confirm ' + ( { 'row-add': 'add row', 'row-delete': 'delete rows', 'column-add': 'add column', 'column-delete': 'delete column' } as Record<string, string>)[action || ''];
            if (action === 'row-add')
                $('data-tools-fields').innerHTML = '<p>Enter the new lead below. Confirm to save; Cancel discards these entries.</p><div class="data-tool-grid">' + columns.filter((column: Column) => column.key !== 'lead_id').map((column: Column, i: number) => `<label>${e(column.label)}<textarea rows="2" data-new-field="${e(column.key)}"></textarea></label>`).join('') + '</div>';
            if (action === 'row-delete')
                $('data-tools-fields').innerHTML = `<p>Delete ${selected.length} selected row(s) from <strong>${e(dataset.name)}</strong>? This removes their local drafts and history and cannot be undone here. It does not cancel or remove real queued/sent emails.</p>${!selected.length ? '<p>Select rows using their checkboxes, then reopen Data tools.</p>' : ''}<ul>${dataset.leads.filter((lead: Lead) => selected.includes(lead.lead_id)).slice(0, 10).map((lead: Lead) => `<li>${e(lead.company)} &middot; ${e(lead.email || 'No email')}</li>`).join('')}</ul>`;
            if (action === 'column-add')
                $('data-tools-fields').innerHTML = '<label>Column name<input id="new-column-name" maxlength="100" required></label><p>Adds an empty source column to this dataset. Existing working drafts must be reset after source changes; held and sent copies are unchanged.</p>';
            if (action === 'column-delete') {
                const recipient = datasetRecipientKey(dataset);
                $('data-tools-fields').innerHTML = '<label>Column<select id="remove-column-key">' + columns.map((column: Column) => `<option value="${e(column.key)}" ${column.key === recipient || column.key === 'lead_id' ? 'disabled' : ''}>${e(column.label)}${column.key === recipient ? ' (recipient; required)' : ''}</option>`).join('') + '</select></label><p id="column-dependencies"></p><p>Confirm permanently removes this source column and its values. Existing working drafts must be reset after source changes; held and sent copies are unchanged. Update any ICP/template references first.</p>';
                const check = () => { const refs = columnDependencies(current(), $('remove-column-key').value); $('column-dependencies').textContent = refs.length ? 'Used by: ' + refs.join(', ') : 'No active ICP or template references.'; };
                $('remove-column-key').onchange = check;
                check();
            }
            unsaved?.reset();
        }
        catch (error) {
            notice(errorMessage(error));
        }
    };
    $('data-tools-form').onsubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        try {
            const dataset = current();
            let next;
            if (action === 'row-add') {
                const values = Object.fromEntries([... $('data-tools-fields').querySelectorAll('[data-new-field]') as NodeListOf<HTMLTextAreaElement>].map((input: HTMLTextAreaElement) => [input.dataset.newField, input.value]));
                next = addDatasetRow(dataset, values);
            }
            if (action === 'row-delete')
                next = deleteDatasetRows(dataset, selected);
            if (action === 'column-add')
                next = addDatasetColumn(dataset, $('new-column-name').value);
            if (action === 'column-delete')
                next = deleteDatasetColumn(dataset, $('remove-column-key').value);
            if (!next)
                return;
            if (!await onSave(next))
                throw Error('Unable to save. The dataset is unchanged.');
            dialog.close();
            notice('Dataset updated. Regenerate any drafts affected by source changes.');
        }
        catch (error) {
            $('data-tools-error').textContent = errorMessage(error);
        }
    };
}

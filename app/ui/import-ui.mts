import type {ImportOptions} from './types.js';
import type {Column, ImportResult, Lead, ParsedCSV} from '../domain/types.js';
import { byId as $, errorMessage, eventControl, field } from './dom.mjs';
import { parseCSV, importCSV, warnings } from '../domain/leads.mjs';
import { sourceValue } from '../domain/lead-schema.mjs';
import { suggestAppendMapping, prepareAppend } from '../domain/append-import.mjs';

export function mountImport({ unsavedChanges, getDataset, onImport, onAppend, escape: e, notice }: ImportOptions) {

    let parsed: ParsedCSV;

    let ready: ImportResult | null = null;
    let sourceName = '', mode = 'new';

    let targetId: string | null | undefined = null;

    let layout: { mapping: { [k: string]: string; }; exact: boolean; native: boolean; columns: Column[]; recipient: string; } | null = null;
    function layoutValue() { if (!layout)
        throw Error('Choose CSV columns before previewing.'); return layout; }
    unsavedChanges?.register(() => $('import-dialog').open && !!parsed);

    function start(nextMode: "new" | "append") { mode = nextMode; targetId = mode === 'append' ? getDataset()?.id : null; $('file').click(); }
    function target() { const dataset = getDataset(); if (!dataset || dataset.id !== targetId)
        throw Error('The destination dataset changed. Close and start Add leads again.'); return dataset; }
    function invalidate() { ready = null; $('commit').hidden = true; $('preview-result').textContent = 'Column selection changed. Preview again.'; }
    $('upload').onclick = () => start('new');
    $('add-leads').onclick = () => start('append');
    $('file').onchange = async (event: Event) => {
        const file = $('file').files?.[0];
        if (!file)
            return;
        try {
            if (file.size > 2000000)
                throw Error('Choose a CSV smaller than 2 MB.');
            sourceName = file.name;
            parsed = parseCSV(await file.text());
            ready = null;
            layout = null;
            $('commit').hidden = true;
            $('preview-result').textContent = '';
            $('dataset-name-label').hidden = mode === 'append';
            $('dataset-name').value = file.name.replace(/\.csv$/i, '').slice(0, 100);
            $('import-title').textContent = mode === 'append' ? 'Add leads to ' + target().name : 'Create a dataset';
            $('import-description').textContent = mode === 'append' ? 'Add new rows to this dataset without changing its columns, rules, templates or existing leads. Maximum 500 rows per file.' : 'Choose the CSV column containing recipient emails. All other columns are imported as-is. Maximum 500 rows.';
            $('commit').textContent = mode === 'append' ? 'Add valid leads' : 'Create dataset';
            if (mode === 'append') {
                layout = suggestAppendMapping(parsed, target());
                $('mapping').innerHTML = layoutValue().exact ? '<p>Columns match this dataset. They have been aligned automatically, including its recipient email column.</p>' :
                    '<p class="mapping-help">Match incoming CSV columns to the existing dataset columns. Unmapped destination fields stay blank; unused incoming columns are not added. The recipient column must be mapped.</p>' + layoutValue().columns.map((column: Column, i: number) => `<label>${e(column.label)}${column.key === layoutValue().recipient ? ' (recipient email)' : ''}<select data-append-column="${i}"><option value="">${column.key === layoutValue().recipient ? 'Choose a column' : 'Leave blank'}</option>${parsed.headers.map((header: string) => `<option value="${e(header)}" ${layoutValue().mapping[column.key] === header ? 'selected' : ''}>${e(header)}</option>`).join('')}</select></label>`).join('');
            }
            else {
                const suggestion = parsed.headers.find((header: string) => /email|e-mail/i.test(header));
                $('mapping').innerHTML = `<label>Recipient email column<select id="recipient-column"><option value="">Choose a column</option>${parsed.headers.map((header: string) => `<option value="${e(header)}" ${header === suggestion ? 'selected' : ''}>${e(header)}</option>`).join('')}</select></label><p>All ${parsed.headers.length} columns will be kept as they appear in your CSV. Blank emails are allowed for preparation, but cannot be sent.</p>`;
            }
            $('import-dialog').showModal();
            if (mode === 'append' && layoutValue().exact)
                preview();
        }
        catch (error) {
            notice(errorMessage(error));
        }
        eventControl(event).value = '';
    };
    $('mapping').onchange = invalidate;
    function currentMapping() { return layoutValue().exact ? layoutValue().mapping : Object.fromEntries(layoutValue().columns.map((column: Column, i: number) => [column.key, field(document, `[data-append-column="${i}"]`).value])); }
    function preview() {
        try {
            ready = mode === 'append' ? prepareAppend(parsed, target(), currentMapping()) : importCSV(parsed, $('recipient-column').value);
            const columns = mode === 'append' ? layoutValue().columns : parsed.headers.map((header: string) => ({ key: 'csv:' + encodeURIComponent(header), label: header }));
            $('preview-result').innerHTML = `<h3>${ready.accepted.length} ready &middot; ${ready.rejected.length} skipped</h3><p>${mode === 'append' ? 'These rows will be added using the existing dataset columns. Existing rows stay unchanged.' : 'Headers and source values are preserved. You can use these columns in ICP rules and email templates.'}</p>${ready.rejected.map((row: { row: number; error: string; }) => `<p>Row ${row.row}: ${e(row.error)}</p>`).join('')}<div class="table-wrap"><table><thead><tr>${columns.map((column: Column) => `<th>${e(column.label)}</th>`).join('')}</tr></thead><tbody>${ready.accepted.map((lead: Lead) => `<tr>${columns.map((column: Column) => `<td>${e(sourceValue(lead, column.key))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p>${ready.accepted.filter((lead: Lead) => warnings(lead).length).length} records contain blank fields.</p>`;
            $('commit').hidden = !ready.accepted.length;
        }
        catch (error) {
            ready = null;
            $('preview-result').textContent = errorMessage(error);
            $('commit').hidden = true;
        }
    }
    $('preview').onclick = preview;
    $('commit').onclick = async () => {
        try {
            if (!ready)
                return;
            // Recheck duplicates against the current destination at commit time.
            if (mode === 'append')
                ready = prepareAppend(parsed, target(), currentMapping());
            const count = ready.accepted.length;
            if (!count) {
                preview();
                return;
            }
            const saved = await (mode === 'append' ? onAppend(target().id, ready.accepted) : onImport($('dataset-name').value, ready.accepted, sourceName));
            if (saved) {
                notice(mode === 'append' ? `${count} leads added to this dataset. ${ready.rejected.length} rows skipped.` : `${count} leads imported into a new dataset. Configure its ICP settings and templates.`);
                $('import-dialog').close();
                ready = null;
            }
        }
        catch (error) {
            $('preview-result').textContent = errorMessage(error);
        }
    };
    $('cancel').onclick = () => $('import-dialog').close();
}

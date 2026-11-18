import type {ColumnFilter, TableOptions} from './types.js';
import type {Column, Lead} from '../domain/types.js';
import { byId as $, eventElement, closest } from './dom.mjs';
import { inferColumnType } from '../domain/column-types.mjs';
import { sourceColumns } from '../domain/lead-schema.mjs';
import { editableColumns } from '../domain/lead-edit.mjs';
import { tableColumns, columnValue, matchesColumns } from './columns.mjs';

export function mountTable({ getLeads, getColumns = () => sourceColumns(getLeads()), score, getTypes = () => ({}), escape: e, onChange }: TableOptions) {

    let filters: Record<string, ColumnFilter> = {};
    let sort = { key: 'score', direction: -1 };
    let active = '';
    const popup = document.createElement('dialog');
    popup.id = 'column-dialog';
    popup.innerHTML = '<div class="dialog-heading"><h2 id="column-title"></h2><button id="close-column">Cancel</button></div><label>Find values<input id="find-values" type="search"></label><div class="actions"><button id="all-values">Select all values</button><button id="none-values">Clear values</button></div><div id="column-values"></div><div class="filters" id="column-range"><label>Minimum<input id="column-min" type="number" step="any"></label><label>Maximum<input id="column-max" type="number" step="any"></label></div><div class="actions"><button id="column-asc">Sort ascending</button><button id="column-desc">Sort descending</button><button id="column-clear">Clear this filter</button><button id="column-apply" class="primary">Apply filter</button></div><p id="column-error" role="alert"></p>';
    document.body.append(popup);

    function open(key: string, button: HTMLElement) {
        active = key;
        const columns = tableColumns(getLeads(), getColumns()), column = columns.find((c: Column) => c.key === key);
        if (!column)
            return;
        $('column-title').textContent = column.label;
        const values = [...new Set(getLeads().map((r: Lead) => String(columnValue(r, score(r), key, getColumns()))))].sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
        const type = getTypes()[key] || (key === 'score' ? 'number' : inferColumnType(getLeads().map((r: Lead) => columnValue(r, score(r), key, getColumns()))));
        $('column-range').hidden = type !== 'number';
        const saved = filters[key];
        $('column-values').innerHTML = values.map((value: string, i: number) => `<label><input type="checkbox" data-value-index="${i}" value="${e(value)}" ${!saved?.values || saved.values.includes(value) ? 'checked' : ''}>${e(value || '(Blanks)')}</label>`).join('');
        $('find-values').value = '';
        $('column-min').value = String(saved?.min ?? '');
        $('column-max').value = String(saved?.max ?? '');
        $('column-error').textContent = type === 'text' && (saved?.min || saved?.max) ? 'This filter has numeric bounds but the column is now Text. Clear this filter or change the column type in ICP Settings.' : '';
        popup.showModal();
        const anchor = button.getBoundingClientRect();
        popup.style.margin = '0';
        popup.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - 8)) + 'px';
        popup.style.top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - popup.offsetHeight - 8)) + 'px';
    }
    $('table-head').onclick = (event: PointerEvent) => { const button = closest(eventElement(event), '[data-column]'); if (button)
        open(button.dataset.column || '', button); };
    $('close-column').onclick = () => popup.close();
    $('find-values').oninput = () => { const q = $('find-values').value.toLowerCase(); for (const label of $('column-values').querySelectorAll('label'))
        label.hidden = !(label.textContent || '').toLowerCase().includes(q); };
    for (const [id, checked] of  [['all-values', true], ['none-values', false]] as const)
        $(id).onclick = () => { for (const input of $('column-values').querySelectorAll('input'))
            if (!input.parentElement?.hidden)
                input.checked = checked; };
    $('column-apply').onclick = () => {
        if ($('column-range').hidden && (filters[active]?.min || filters[active]?.max)) {
            $('column-error').textContent = 'Clear this incompatible numeric filter first, or change the column type in ICP Settings.';
            return;
        }
        const min = $('column-range').hidden ? '' : $('column-min').value, max = $('column-range').hidden ? '' : $('column-max').value;
        if (!$('column-range').hidden && (!$('column-min').checkValidity() || !$('column-max').checkValidity())) {
            $('column-error').textContent = 'Enter valid numeric bounds.';
            return;
        }
        if (min !== '' && max !== '' && Number(min) > Number(max)) {
            $('column-error').textContent = 'Minimum must not exceed maximum.';
            return;
        }
        const inputs = [...$('column-values').querySelectorAll('input')], values = inputs.filter((i: HTMLInputElement) => i.checked).map((i: HTMLInputElement) => i.value);
        if (values.length === inputs.length && min === '' && max === '')
            delete filters[active];
        else
            filters[active] = { values: values.length === inputs.length ? undefined : values, min, max };
        popup.close();
        onChange();
    };
    $('column-clear').onclick = () => { delete filters[active]; popup.close(); onChange(); };
    for (const [id, direction] of  [['column-asc', 1], ['column-desc', -1]] as const)
        $(id).onclick = () => { sort = { key: active, direction }; popup.close(); onChange(); };
    return {
        clear() { filters = {}; sort = { key: 'score', direction: -1 }; },
        showMissing() { filters = { data: { values: ['Needs attention'] } }; },
        missingActive() { return filters.data?.values?.length === 1 && filters.data.values[0] === 'Needs attention'; },

        rows(query: string) { const scored = new Map(getLeads().map((r: Lead) => [r.lead_id, score(r)])); return getLeads().filter((r: Lead) => [...Object.values(r).filter((v: unknown) => typeof v !== 'object'), ...Object.values(r.values || {})].join(' ').toLowerCase().includes(query.toLowerCase()) && matchesColumns(r, scored.get(r.lead_id) || score(r), filters, getColumns())).sort((a: Lead, b: Lead) => { const av = columnValue(a, scored.get(a.lead_id) || score(a), sort.key, getColumns()), bv = columnValue(b, scored.get(b.lead_id) || score(b), sort.key, getColumns()); return sort.direction * (String(av).localeCompare(String(bv), undefined, { numeric: true })); }); },

        render(rows: Lead[]) {
            const columns = tableColumns(getLeads(), getColumns());
            $('table-head').innerHTML = '<tr><th><label class="select-all"><input id="select-all" type="checkbox">Select All</label></th><th scope="col">Lead actions</th>' + columns.map((c: Column) => `<th><button data-column="${e(c.key)}" aria-label="Filter ${e(c.label)}" class="column-button ${filters[c.key] ? 'filtered' : ''}">${e(c.label)} <span aria-hidden="true">${filters[c.key] ? '●' : '▾'}</span></button></th>`).join('') + '</tr>';
            $('leads').innerHTML = rows.map((r: Lead) => {
                const result = score(r), editable = new Set(editableColumns(r).map((column: Column) => column.key));
                const locked = r.messageWorkflow === 2 ? '' : r.live_delivery ? 'Read-only: real delivery record' : r.outbox?.length ? 'Read-only: previously simulated sent' : '';
                return `<tr><td><input type="checkbox" data-select="${e(r.lead_id)}" aria-label="Select ${e(r.company)}"></td><td class="lead-actions"><button data-id="${e(r.lead_id)}" aria-label="View Lead: ${e(r.company)}">View Lead</button>${locked ? `<small class="read-only-note">${e(locked)}</small>` : ''}</td>${columns.map((c: Column) => {
                    const value = columnValue(r, result, c.key, getColumns()), display = value === '' ? '&mdash;' : e(value);
                    const edit = editable.has(c.key) && !locked;
                    return `<td>${edit ? `<button class="cell-edit" data-edit-lead="${e(r.lead_id)}" data-edit-field="${e(c.key)}" aria-label="Edit ${e(c.label)} for ${e(r.company)}" title="Edit ${e(c.label)}">${display}</button>` : display}</td>`;
                }).join('')}</tr>`;
            }).join('');
            $('select-all').disabled = !rows.length;
            $('filter-summary').textContent = Object.keys(filters).length ? `${Object.keys(filters).length} column filter(s) active` : 'Use column dropdowns to filter or sort.';
        }
    };
}

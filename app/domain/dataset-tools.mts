import type {Column, Condition, Criterion, Dataset, Lead, Segment} from './types.js';
import { finalizeSourceChange } from './source-state.mjs';
import { datasetColumns, datasetRecipientKey, nativeDataset, sourceValue } from './lead-schema.mjs';
import { prepareAppend } from './append-import.mjs';
import { toCriteria, scoreLead } from './scoring.mjs';
import { outreachColumns, outreachValues } from './outreach-report.mjs';
import { templateAt } from './outreach.mjs';

function schema(dataset: Dataset) { return { ...dataset, columns: datasetColumns(dataset), native: nativeDataset(dataset), recipientKey: datasetRecipientKey(dataset) }; }

function editableSchema(dataset: Dataset) { if (dataset.leads.some((row: Lead) => row.messageWorkflow !== 2 && (row.live_delivery || row.outbox?.length)))
    throw Error('Columns on queued or sent leads are read-only. Make structural changes in a separate dataset.'); }

export function addDatasetRow(dataset: Dataset, values: Record<string, unknown>) {
    const next = schema(dataset), columns = next.columns;
    if (!columns.length)
        throw Error('Import a CSV first to define the columns.');
    const row = columns.map((column: Column) => String(Object.hasOwn(values, column.key) ? values[column.key] : ''));
    if (!row.some((value: string) => value.trim()))
        throw Error('Enter at least one field before adding a row.');
    const headers = columns.map((column: Column) => column.key), mapping = Object.fromEntries(columns.map((column: Column) => [column.key, column.key]));
    const result = prepareAppend({ headers, rows: [row] }, next, mapping);
    if (!result.accepted.length)
        throw Error(result.rejected[0]?.error || 'Unable to add row.');
    return { ...next, leads: [...dataset.leads, ...result.accepted] };
}

export function deleteDatasetRows(dataset: Dataset, ids: string[]) {
    const selected = new Set(ids);
    if (!selected.size)
        throw Error('Select at least one row first.');
    if ([...selected].some((id: string) => !dataset.leads.some((lead: Lead) => lead.lead_id === id)))
        throw Error('The selected rows changed. Select them again.');
    return { ...schema(dataset), leads: dataset.leads.filter((lead: Lead) => !selected.has(lead.lead_id)) };
}

export function addDatasetColumn(dataset: Dataset, name: string) {
    editableSchema(dataset);
    const next = schema(dataset), label = String(name ?? '').trim();
    if (!label || label.length > 100)
        throw Error('Enter a column name between 1 and 100 characters.');
    if (next.columns.some((column: Column) => column.label === label))
        throw Error('A column with that name already exists.');
    const key = next.native ? 'csv:' + encodeURIComponent(label) : 'custom:' + label;
    return { ...next, columns: [...next.columns, { key, label }], leads: dataset.leads.map((lead: Lead) => finalizeSourceChange(next.native ? { ...lead, values: { ...lead.values, [label]: '' } } : { ...lead, extra_fields: { ...lead.extra_fields, [label]: '' } }, 'Column added: ' + label)) };
}

export function columnDependencies(dataset: Dataset, key: string) {
    const column = datasetColumns(dataset).find((column: Column) => column.key === key);
    if (!column)
        return [];
    const rules = dataset.rules, dependencies = [];
    const conditions = [...toCriteria(rules), ...(rules.eligibility || []), ...(rules.segments || []).flatMap((segment: Segment) => segment.conditions)];
    if (conditions.some((item: Condition | Criterion) => item.field === key) || (rules.version !== 2 && ['city', 'avg_daily_onsite', 'job_title'].includes(key)))
        dependencies.push('ICP rules or segments');
    for (const name of Object.keys(dataset.templates)) {
        if (name.startsWith('_'))
            continue;
        const template = templateAt(dataset.templates, name);
        if (!template)
            throw Error('Both segments need a subject and body.');
        const tokens = [...(template.subject + '\n' + template.body).matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match: RegExpExecArray) => match[1]);
        if (tokens.includes(key) || (nativeDataset(dataset) && tokens.includes(column.label)))
            dependencies.push('template ' + name);
    }
    return dependencies;
}

export function deleteDatasetColumn(dataset: Dataset, key: string) {
    const next = schema(dataset), column = next.columns.find((column: Column) => column.key === key);
    if (!column)
        throw Error('Choose an existing source column.');
    if (key === next.recipientKey)
        throw Error('The recipient email column is required and cannot be deleted.');
    const dependencies = columnDependencies(dataset, key);
    if (dependencies.length)
        throw Error('Update these references before deleting the column: ' + dependencies.join(', ') + '.');
    editableSchema(dataset);
    if (!next.native && !key.startsWith('custom:') && key === 'lead_id')
        throw Error('Internal lead IDs cannot be deleted.');
    const columns = next.columns.filter((column: Column) => column.key !== key);
    return { ...next, columns, templates: { ...next.templates, _columns: columns.flatMap((column: Column) => [column.key, column.label]) }, leads: dataset.leads.map((lead: Lead) => {
            let row;
            if (next.native) {
                const values = { ...lead.values };
                delete values[column.label];
                row = { ...lead, values };
            }
            else if (key.startsWith('custom:')) {
                const extra_fields = { ...lead.extra_fields };
                delete extra_fields[key.slice(7)];
                row = { ...lead, extra_fields };
            }
            else
                row = { ...lead, [key]: '' };
            return finalizeSourceChange(row, 'Column deleted: ' + column.label);
        }) };
}

export function exportDatasetCSV(dataset: Dataset, mode: string | undefined = 'source') {
    if (!['source', 'report'].includes(mode))
        throw Error('Choose source data or outreach report export.');
    const columns = datasetColumns(dataset);
    if (!columns.length)
        throw Error('This dataset has no source columns to export.');
    const used = new Set(columns.map((column: Column) => column.label));
    const report = mode === 'report' ? outreachColumns.map((column: { key: string; label: string; }) => {
        let label = column.label, index = 1;
        while (used.has(label)) {
            label = column.label + ' (outreach' + (index === 1 ? '' : ' ' + index) + ')';
            index++;
        }
        used.add(label);
        return { ...column, label };
    }) : [];

    const quote = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const headers = [...columns, ...report].map((column: Column) => column.label);
    const rows = dataset.leads.map((lead: Lead) => {
        const values = columns.map((column: Column) => sourceValue(lead, column.key));
        if (report.length) {
            const derived = outreachValues(lead, scoreLead(lead, dataset.rules), columns);
            values.push(...report.map((column: { label: string; key: string; }) => derived[column.key]));
        }
        return values;
    });
    return '\uFEFF' + [headers, ...rows].map((row: unknown[]) => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

import type {Column, Dataset, ImportResult, Lead, ParsedCSV} from './types.js';
import { importCSV } from './leads.mjs';
import { datasetColumns, nativeDataset, datasetRecipientKey } from './lead-schema.mjs';

export function appendLayout(dataset: Dataset) {
    const columns = datasetColumns(dataset);
    if (!columns.length)
        throw Error('This dataset has no columns. Import a new dataset instead.');
    const native = nativeDataset(dataset);
    const recipient = datasetRecipientKey(dataset);
    return { native, columns, recipient };
}

export function suggestAppendMapping(parsed: ParsedCSV, dataset: Dataset) {
    const layout = appendLayout(dataset);
    const mapping = Object.fromEntries(layout.columns.map((column: Column) => [column.key,
        parsed.headers.find((header: string) => header === column.label || (!layout.native && header === column.key)) ?? '']));
    const exact = parsed.headers.length === layout.columns.length && layout.columns.every((column: Column) => mapping[column.key]);
    return { ...layout, mapping, exact };
}
// Align incoming values to the destination schema before using normal recipient
// validation/deduplication. Existing records and dataset settings never change.

export function prepareAppend(parsed: ParsedCSV, dataset: Dataset, mapping: Record<string, string>): ImportResult {
    const { native, columns, recipient } = appendLayout(dataset);
    const selected = columns.map((column: Column) => Object.hasOwn(mapping, column.key) ? mapping[column.key] : '');
    if (!mapping[recipient])
        throw Error('Map the recipient email column before adding leads.');
    if (selected.some((header: string) => header && !parsed.headers.includes(header)))
        throw Error('Choose columns from the imported CSV.');
    const used = selected.filter(Boolean);
    if (new Set(used).size !== used.length)
        throw Error('Map each incoming column only once.');
    const headers = columns.map((column: Column) => native ? column.label : column.key);
    const aligned = { headers, rows: parsed.rows.map((row: string[]) => selected.map((header: string) => header ? row[parsed.headers.indexOf(header)] : '')) };
    const emailHeader = headers[columns.findIndex((column: Column) => column.key === recipient)];
    const result = importCSV(aligned, emailHeader, dataset.leads);
    if (!native)
        return { ...result, accepted: result.accepted.map((lead: Lead & { values: Record<string, string>; }) => {
                const values = Object.fromEntries(columns.filter((column: Column) => !column.key.startsWith('custom:')).map((column: Column) => [column.key, lead.values[column.key]]));
                const extras = Object.fromEntries(columns.filter((column: Column) => column.key.startsWith('custom:')).map((column: Column) => [column.key.slice(7), lead.values[column.key]]));
                return { ...values, lead_id: lead.lead_id, email: lead.email, company: String(values.company || ''),
                    extra_fields: extras, import_fingerprint: lead.import_fingerprint, outreach_status: 'Not contacted' };
            }) };
    return result;
}

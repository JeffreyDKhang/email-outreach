import type {Column, Dataset, Lead} from './types.js';
export const fields = ['lead_id', 'first_name', 'last_name', 'email', 'company', 'job_title', 'city', 'industry', 'office_employees', 'avg_daily_onsite', 'purchasing_method', 'company_fact', 'fact_source', 'data_origin'];

export const label = (key: string) => key.replaceAll('_', ' ').replace(/^./, (c: string) => c.toUpperCase());

export function warnings(lead: Lead, columns?: Column[] | undefined) {
    if (lead.values && columns)
        return columns.filter((column: Column) => !String(sourceValue(lead, column.key) ?? '').trim()).map((column: Column) => column.label);
    const values = lead.values;
    if (values)
        return Object.keys(values).filter((key: string) => values[key] == null || String(values[key]).trim() === '');
    return ['first_name', 'email', 'job_title', 'city', 'office_employees', 'avg_daily_onsite']
        .filter((key: string) => (!columns || columns.some((column: Column) => column.key === key)) && (lead[key] === '' || lead[key] == null));
}

export function sourceColumns(leads: Lead[] | undefined = []): Column[] {
    const raw = [...new Set(leads.flatMap((lead: Lead) => lead.values ? Object.keys(lead.values) : []))].map((key: string) => ({ key: 'csv:' + encodeURIComponent(key), label: key }));
    if (leads.length && leads.every((lead: Lead) => lead.values))
        return raw;
    const custom = [...new Set(leads.flatMap((lead: Lead) => Object.keys(lead.extra_fields || {})))];
    return [
        ...fields.map((key: string) => ({ key, label: label(key) })),
        ...custom.map((key: string) => ({ key: 'custom:' + key, label: key })), ...raw,
    ];
}

export function sourceValue(lead: Lead, key: string): unknown {
    if (key.startsWith('csv:')) {
        try {
            const header = decodeURIComponent(key.slice(4));
            return lead.values && Object.hasOwn(lead.values, header) ? lead.values[header] : '';
        }
        catch {
            return '';
        }
    }
    return key.startsWith('custom:') ? lead.extra_fields?.[key.slice(7)] ?? '' : lead[key] ?? '';
}

export function recipientEmail(lead: Lead) { return lead.values ? String(lead.values[lead.recipient_column ?? ''] ?? '').trim() : String(lead.email ?? '').trim(); }

export function leadTitle(lead: Lead) { return lead.values ? String(Object.entries(lead.values).find(([key, value]: [string, string]) => key !== lead.recipient_column && String(value).trim())?.[1] || recipientEmail(lead) || 'Imported lead') : lead.company || lead.lead_id; }

export function datasetColumns(dataset: Dataset | null | undefined): Column[] { return dataset?.columns ? dataset.columns.map((column: Column) => ({ ...column })) : dataset?.leads?.length ? sourceColumns(dataset.leads) : []; }

export function nativeDataset(dataset: Dataset | null | undefined) { return dataset?.native ?? !!dataset?.leads?.[0]?.values; }

export function datasetRecipientKey(dataset: Dataset) { return dataset?.recipientKey || (nativeDataset(dataset) ? 'csv:' + encodeURIComponent(dataset.leads[0].recipient_column ?? '') : 'email'); }

import type {Column, Lead} from './types.js';
import { sourceColumns, sourceValue, recipientEmail } from './lead-schema.mjs';
import { assertSourceEditable, finalizeSourceChange } from './source-state.mjs';

export function editableColumns(lead: Lead) {
    return sourceColumns([lead]).filter((column: Column) => lead.values || column.key !== 'lead_id');
}

export function editLeadField(lead: Lead, key: string, value: string, existing: Lead[] | undefined = []): Lead {
    if (!editableColumns(lead).some((column: Column) => column.key === key)) {
        throw Error('Only source fields can be edited.');
    }
    assertSourceEditable(lead);
    if (typeof value !== 'string')
        throw Error('Enter a text value.');
    if (String(sourceValue(lead, key)) === value)
        return lead;
    let next;
    if (lead.values) {
        const header = decodeURIComponent(key.slice(4));
        next = { ...lead, values: { ...lead.values, [header]: value } };
    }
    else {
        if (key === 'data_origin' && lead.data_origin === 'synthetic' && value !== 'synthetic') {
            throw Error('Synthetic records must keep their origin marker.');
        }
        if (['office_employees', 'avg_daily_onsite'].includes(key) && value !== '' &&
            (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
            throw Error('Enter a nonnegative whole number or leave blank.');
        }
        next = key.startsWith('custom:')
            ? { ...lead, extra_fields: { ...lead.extra_fields, [key.slice(7)]: value } }
            : { ...lead, [key]: value };
    }
    const email = recipientEmail(next);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw Error('Enter a valid recipient email address or leave it blank.');
    }
    const changedEmail = email.toLowerCase() !== recipientEmail(lead).toLowerCase();
    if (changedEmail && email && existing.some((row: Lead) => row.lead_id !== lead.lead_id && recipientEmail(row).toLowerCase() === email.toLowerCase())) {
        throw Error('This recipient email already exists in this dataset.');
    }
    return finalizeSourceChange(next, 'Source field updated: ' + key);
}

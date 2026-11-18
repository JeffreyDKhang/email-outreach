import type {ImportResult, Lead, ParsedCSV} from './types.js';
import { fields, label, recipientEmail, leadTitle } from './lead-schema.mjs';
export { fields, label, warnings } from './lead-schema.mjs';

export function parseCSV(text: string): ParsedCSV {
    const rows = [];
    let row = [], value = '', quoted = false, closed = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                value += '"';
                i++;
            }
            else if (c === '"') {
                quoted = false;
                closed = true;
            }
            else
                value += c;
        }
        else if (c === '"') {
            if (value || closed)
                throw Error('Unexpected quote in CSV.');
            quoted = true;
        }
        else if (c === ',') {
            row.push(value);
            value = '';
            closed = false;
        }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n')
                i++;
            row.push(value);
            if (row.some((v: string) => v.trim()))
                rows.push(row);
            row = [];
            value = '';
            closed = false;
        }
        else {
            if (closed && c.trim())
                throw Error('Unexpected text after a closing quote.');
            if (!closed)
                value += c;
        }
    }
    if (quoted)
        throw Error('Unclosed quoted field in CSV.');
    row.push(value);
    if (row.some((v: string) => v.trim()))
        rows.push(row);
    if (rows.length < 2)
        throw Error('Include a header row and at least one lead.');
    const headers = rows.splice(0, 1)[0];
    if (headers.some((v: string) => !v.trim()) || new Set(headers).size !== headers.length)
        throw Error('Headers must be nonempty and unique.');
    if (rows.length > 500)
        throw Error('Up to 500 leads are supported per import.');
    if (rows.some((r: string[]) => r.length !== headers.length))
        throw Error('Each row must have the same number of columns as the header.');
    return { headers, rows };
}

export function prepareImport(parsed: ParsedCSV, mapping: Record<string, string>, existing: Lead[] | undefined = []): ImportResult {
    if (!mapping.company || (!mapping.email && !mapping.lead_id))
        throw Error('Map company and either email or lead ID.');
    const mapped = Object.values(mapping).filter(Boolean);
    if (new Set(mapped).size !== mapped.length)
        throw Error('Map each source column only once.');
    const emails = new Set(existing.map((r: Lead) => r.email?.toLowerCase()).filter(Boolean));
    const ids = new Set(existing.map((r: Lead) => r.lead_id).filter(Boolean));

    const accepted: Lead[] = [];

    const rejected: { row: number; error: string; }[] = [];
    parsed.rows.forEach((row: string[], index: number) => {
        const lead =  Object.fromEntries(fields.map((k: string) => [k, mapping[k] ? row[parsed.headers.indexOf(mapping[k])]?.trim() ?? '' : ''])) as Lead;
        const extras = parsed.headers.map((header: string, i: number) => [header, row[i].trim()]).filter(([header]: string[]) => !mapped.includes(header));
        if (extras.length)
            lead.extra_fields = Object.fromEntries(extras);
        let error = '';
        if (!lead.company || (!lead.email && !lead.lead_id))
            error = 'Company and either email or lead ID are required.';
        if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))
            error = 'Invalid email address.';
        for (const k of ['office_employees', 'avg_daily_onsite']) {
            if (lead[k] !== '' && (!/^\d+$/.test(String(lead[k])) || !Number.isSafeInteger(Number(lead[k]))))
                error = `${label(k)} must be a nonnegative whole number.`;
            else if (lead[k] !== '')
                lead[k] = Number(lead[k]);
        }
        if (lead.office_employees !== '' && lead.avg_daily_onsite !== '' && Number(lead.avg_daily_onsite) > Number(lead.office_employees))
            error = 'Daily attendance cannot exceed office employees.';
        if ((lead.email && emails.has(lead.email.toLowerCase())) || (lead.lead_id && ids.has(lead.lead_id)))
            error = 'Duplicate email or lead ID; existing records are preserved.';
        if (error)
            rejected.push({ row: index + 2, error });
        else {
            if (!lead.lead_id)
                lead.lead_id = globalThis.crypto.randomUUID();
            ids.add(lead.lead_id);
            if (lead.email)
                emails.add(lead.email.toLowerCase());
            accepted.push(lead);
        }
    });
    return { accepted, rejected };
}

export function importCSV(parsed: ParsedCSV, recipientColumn: string, existing: Lead[] | undefined = []) {
    if (!parsed.headers.includes(recipientColumn))
        throw Error('Select the column containing recipient email addresses.');
    const emails = new Set(existing.map(recipientEmail).map((email: string) => email.toLowerCase()).filter(Boolean));
    const fingerprints = new Set(existing.map((lead: Lead) => lead.import_fingerprint).filter(Boolean));

    const accepted: (Lead & { values: Record<string, string>; })[] = [];

    const rejected: { row: number; error: string; }[] = [];
    parsed.rows.forEach((row: string[], index: number) => {
        const values = Object.fromEntries(parsed.headers.map((header: string, i: number) => [header, row[i]]));
        const fingerprint = JSON.stringify([recipientColumn, Object.entries(values)]);
        const lead = { lead_id: crypto.randomUUID(), values, recipient_column: recipientColumn, import_fingerprint: fingerprint, email: String(values[recipientColumn]).trim(), company: '', outreach_status: 'Not contacted', ...(values.data_origin === 'synthetic' ? { data_origin: 'synthetic' } : {}) };
        lead.company = leadTitle(lead);
        if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))
            rejected.push({ row: index + 2, error: 'Invalid recipient email address.' });
        else if ((lead.email && emails.has(lead.email.toLowerCase())) || fingerprints.has(fingerprint))
            rejected.push({ row: index + 2, error: 'Duplicate recipient or previously imported row.' });
        else {
            accepted.push(lead);
            if (lead.email)
                emails.add(lead.email.toLowerCase());
            fingerprints.add(fingerprint);
        }
    });
    return { accepted, rejected };
}

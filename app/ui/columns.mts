import type {Column, Lead, ScoreResult} from '../domain/types.js';
import type {ColumnFilter} from './types.js';
import { sourceColumns, sourceValue } from '../domain/lead-schema.mjs';
import { outreachColumns, outreachValues } from '../domain/outreach-report.mjs';
export { sourceColumns, sourceValue } from '../domain/lead-schema.mjs';

export function tableColumns(leads: Lead[], columns: Column[] | undefined = sourceColumns(leads)) { if (!leads.length && !columns.length)
    return []; return [...columns, ...outreachColumns]; }

export function columnValue(lead: Lead, result: ScoreResult, key: string, columns: Column[]) {
    const derived = outreachValues(lead, result, columns);
    return Object.hasOwn(derived, key) ? derived[key] : sourceValue(lead, key);
}

export function matchesColumns(lead: Lead, result: ScoreResult, filters: Record<string, ColumnFilter>, columns: Column[]) {
    return Object.entries(filters).every(([key, filter]: [string, ColumnFilter]) => {
        const raw = columnValue(lead, result, key, columns), value = String(raw);
        if (filter.values && !filter.values.includes(value))
            return false;
        if (filter.min !== '' && filter.min != null && (value === '' || !Number.isFinite(Number(raw)) || Number(raw) < Number(filter.min)))
            return false;
        if (filter.max !== '' && filter.max != null && (value === '' || !Number.isFinite(Number(raw)) || Number(raw) > Number(filter.max)))
            return false;
        return true;
    });
}

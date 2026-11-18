import type {ColumnType, Condition, Lead, RuleProfile} from './types.js';
import { sourceValue } from './lead-schema.mjs';
export const textOperators = ['equals', 'not_equals', 'contains', 'in', 'present', 'missing'];
export const numericOperators = ['gte', 'lte', 'between'];

export function inferColumnType(values: unknown[]): ColumnType {
    const present = values.filter((value: unknown) => value != null && String(value).trim() !== '').map((value: unknown) => String(value).trim());
    return present.length && present.every((value: string) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number.isFinite(Number(value)) && !/^[+-]?0\d/.test(value)) ? 'number' : 'text';
}

export function columnType(leads: Lead[], key: string, overrides: Record<string, ColumnType> | undefined = {}) {
    return Object.hasOwn(overrides, key) ? overrides[key] : inferColumnType(leads.map((lead: Lead) => sourceValue(lead, key)));
}

export function allowedOperators(type: ColumnType) {
    return type === 'number' ? [...textOperators, ...numericOperators] : [...textOperators];
}

export function conditionTypeError(condition: { operator: string; }, type: ColumnType) {
    return allowedOperators(type).includes(condition.operator) ? '' : 'This numeric condition is incompatible with Text. Choose another condition or treat the column as Number.';
}

export function pointsError(points: unknown, maximum: number) {
    return String(points).trim() !== '' && Number.isFinite(Number(points)) && Number(points) >= 0 && Number(points) <= maximum ? '' : `Points must be between 0 and ${maximum}.`;
}

export function validateConditionTypes(rules: RuleProfile, leads: Lead[]) {

    const check = (condition: Condition) => {
        const message = conditionTypeError(condition, columnType(leads, condition.field, rules.columnTypes));
        if (message)
            throw Error(`${condition.field}: ${message}`);
    };
    for (const criterion of rules.criteria)
        for (const condition of criterion.cases)
            check({ ...condition, field: criterion.field });
    rules.eligibility.forEach(check);
    for (const segment of rules.segments)
        segment.conditions.forEach(check);
}

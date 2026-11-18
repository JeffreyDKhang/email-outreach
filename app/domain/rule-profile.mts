import type {Lead, RuleProfile, Rules} from './types.js';
import { genericDefaults, toCriteria } from './scoring.mjs';

export function editableRuleProfile(value: Rules, leads: Lead[] | undefined = []): RuleProfile {
    if (value.version === 2)
        return structuredClone(value);
    if (leads.some((row: Lead) => row.values))
        return { ...structuredClone(genericDefaults), columnTypes: value.columnTypes };
    return { version: 2, criteria: toCriteria(value), medium: value.medium, high: value.high, eligibility: [{ field: 'city', operator: 'in', value: value.cities.join(', ') }, { field: 'avg_daily_onsite', operator: 'gte', value: 5 }], segments: [{ name: 'Office operations', conditions: [{ field: 'job_title', operator: 'in', value: 'Office Manager, Workplace Manager, Operations Manager' }] }, { name: 'People and HR', conditions: [{ field: 'job_title', operator: 'in', value: 'People Manager, HR Manager, People Operations Manager' }] }] };
}

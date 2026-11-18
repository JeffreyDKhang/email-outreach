import type {ColumnType, Comparison, Condition, Criterion, Lead, LegacyRules, RuleProfile, Rules, ScoreResult, Segment, WeightKey} from './types.js';
import { pointsError } from './column-types.mjs';
import { sourceValue } from './lead-schema.mjs';

export const defaults: LegacyRules = { cities: ['Toronto', 'Mississauga', 'Markham'], weights: { city: 25, size: 20, onsite: 25, role: 20, purchasing: 10 }, medium: 50, high: 80 };

export const genericDefaults: RuleProfile = { version: 2, criteria: [], eligibility: [], segments: [], medium: 50, high: 80 };
export const operators = ['equals', 'not_equals', 'contains', 'in', 'gte', 'lte', 'between', 'present', 'missing'];

export function conditionMatches(raw: unknown, condition: Comparison) {
    if (condition.operator === 'missing')
        return unknown(raw);
    if (condition.operator === 'present')
        return !unknown(raw);
    if (unknown(raw))
        return false;
    const value = condition.value ?? '';
    switch (condition.operator) {
        case 'equals': return norm(raw) === norm(value);
        case 'not_equals': return norm(raw) !== norm(value);
        case 'contains': return norm(raw).includes(norm(value));
        case 'in': return String(value).split(',').some((v: string) => norm(v) === norm(raw));
        case 'gte': return Number.isFinite(Number(raw)) && Number(raw) >= Number(value);
        case 'lte': return Number.isFinite(Number(raw)) && Number(raw) <= Number(value);
        case 'between': return Number.isFinite(Number(raw)) && Number(raw) >= Number(value) && Number(raw) <= Number(condition.to);
        default: return false;
    }
}

export function toCriteria(rules: Rules): Criterion[] {
    if (rules.criteria)
        return structuredClone(rules.criteria);
    const legacy =  rules as LegacyRules;
    const w = legacy.weights || defaults.weights;
    return [
        { name: 'Service area', field: 'city', weight: w.city, cases: [{ operator: 'in', value: legacy.cities.join(', '), points: w.city }] },
        { name: 'Office size', field: 'office_employees', weight: w.size, cases: [{ operator: 'between', value: 20, to: 150, points: w.size }, { operator: 'between', value: 10, to: 19, points: w.size * .5 }, { operator: 'between', value: 151, to: 250, points: w.size * .5 }] },
        { name: 'Daily attendance', field: 'avg_daily_onsite', weight: w.onsite, cases: [{ operator: 'gte', value: 15, points: w.onsite }, { operator: 'between', value: 5, to: 14, points: w.onsite * .4 }] },
        { name: 'Contact role', field: 'job_title', weight: w.role, cases: [{ operator: 'in', value: 'Office Manager, Workplace Manager, Operations Manager, People Manager, HR Manager, People Operations Manager', points: w.role }] },
        { name: 'Purchasing method', field: 'purchasing_method', weight: w.purchasing, cases: [{ operator: 'in', value: 'manual shopping, ad hoc orders', points: w.purchasing }] }
    ];
}

const norm = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const unknown = (value: unknown) => value == null || String(value).trim() === '';

export function segmentFor(title: unknown) {
    const role = norm(title);
    if (['office manager', 'workplace manager', 'operations manager'].includes(role))
        return 'Office operations';
    if (['people manager', 'hr manager', 'people operations manager'].includes(role))
        return 'People and HR';
    return 'Unassigned';
}

export function validateRules(value: unknown): number {
    // This is the runtime trust boundary; retain validation for untyped saved/API input.
    const rules =  value as Rules;
    if (rules?.version === 2) {
        if (rules.columnTypes !== undefined && (!rules.columnTypes || typeof rules.columnTypes !== 'object' || Array.isArray(rules.columnTypes) || Object.values(rules.columnTypes).some((type: ColumnType) => !['text', 'number'].includes(type))))
            throw Error('Column types must be Text or Number.');
        if (!Array.isArray(rules.criteria) || !Array.isArray(rules.eligibility) || !Array.isArray(rules.segments))
            throw Error('Scoring, eligibility and segment rules must be lists.');

        const validateCondition = (c: Condition) => {
            if (!c || typeof c.field !== 'string' || !c.field || !operators.includes(c.operator))
                throw Error('Choose a dataset column and valid condition.');
            if (!['missing', 'present'].includes(c.operator) && (c.value == null || String(c.value).trim() === ''))
                throw Error('Enter a condition value.');
            if (['gte', 'lte', 'between'].includes(c.operator) && !Number.isFinite(Number(c.value)))
                throw Error('Numeric conditions need numeric values.');
            if (c.operator === 'between' && (c.to == null || String(c.to).trim() === '' || !Number.isFinite(Number(c.to)) || Number(c.to) < Number(c.value)))
                throw Error('Enter a valid upper bound.');
        };
        for (const condition of rules.eligibility)
            validateCondition(condition);
        const names = new Set(['General']);
        for (const segment of rules.segments) {
            if (!segment.name?.trim() || segment.name.startsWith('_') || names.has(segment.name) || !segment.conditions?.length)
                throw Error('Segments need unique non-reserved names (other than General) and at least one condition.');
            names.add(segment.name);
            segment.conditions.forEach(validateCondition);
        }
        for (const criterion of rules.criteria) {
            if (!criterion.name?.trim() || !Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 1000 || !criterion.cases?.length)
                throw Error('Each criterion needs a name, weight and conditions.');
            for (const c of criterion.cases) {
                validateCondition({ ...c, field: criterion.field });
                if (pointsError(c.points, criterion.weight))
                    throw Error('Condition points must fit within the criterion weight.');
            }
        }
        const maximum = rules.criteria.length ? rules.criteria.reduce((sum: number, c: Criterion) => sum + c.weight, 0) : 100;
        if (!Number.isInteger(rules.medium) || !Number.isInteger(rules.high) || rules.medium < 1 || rules.medium >= rules.high || rules.high > maximum)
            throw Error(`Thresholds must satisfy 1 <= Medium < High <= ${maximum}.`);
        return maximum;
    }
    if (!rules || !Array.isArray(rules.cities) || !rules.cities.length || rules.cities.some((c: string) => typeof c !== 'string' || !c.trim()))
        throw Error('Enter at least one service city.');
    if (new Set(rules.cities.map(norm)).size !== rules.cities.length)
        throw Error('Service cities must be unique.');
    let maximum;
    if (rules.criteria) {
        if (!Array.isArray(rules.criteria) || !rules.criteria.length)
            throw Error('Add at least one scoring criterion.');
        for (const criterion of rules.criteria) {
            if (typeof criterion.name !== 'string' || !criterion.name.trim() || typeof criterion.field !== 'string' || !criterion.field.trim())
                throw Error('Every criterion needs a name and dataset column.');
            if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 1000)
                throw Error('Criterion weights must be between 0 and 1000.');
            if (!Array.isArray(criterion.cases) || !criterion.cases.length)
                throw Error('Each criterion needs at least one condition.');
            for (const condition of criterion.cases) {
                if (!operators.includes(condition.operator))
                    throw Error('Choose a supported condition.');
                if (!Number.isFinite(condition.points) || condition.points < 0 || condition.points > criterion.weight)
                    throw Error('Condition points must be between zero and the criterion weight.');
                if (!['missing', 'present'].includes(condition.operator) && (condition.value == null || String(condition.value).trim() === ''))
                    throw Error('Enter a condition value.');
                if (['gte', 'lte', 'between'].includes(condition.operator) && !Number.isFinite(Number(condition.value)))
                    throw Error('Numeric comparisons need a numeric value.');
                if (condition.operator === 'between' && (condition.to == null || String(condition.to).trim() === '' || !Number.isFinite(Number(condition.to)) || Number(condition.to) < Number(condition.value)))
                    throw Error('Enter an upper bound greater than or equal to the lower bound.');
            }
        }
        maximum = rules.criteria.reduce((sum: number, c: Criterion) => sum + c.weight, 0);
    }
    else {
        const keys =  Object.keys(defaults.weights) as WeightKey[];
        for (const key of keys)
            if (!Number.isInteger(rules.weights?.[key]) || rules.weights[key] < 0 || rules.weights[key] > 100)
                throw Error('Each weight must be a whole number from 0 to 100.');
        maximum = keys.reduce((n: number, k: WeightKey) => n + rules.weights[k], 0);
    }
    if (!Number.isInteger(rules.medium) || !Number.isInteger(rules.high) || rules.medium < 1 || rules.medium >= rules.high || rules.high > maximum)
        throw Error(`Thresholds must satisfy 1 <= Medium < High <= maximum (${maximum}).`);
    return maximum;
}

export function scoreLead(lead: Lead, rules: Rules | undefined = defaults): ScoreResult {
    if (lead.values || rules.version === 2) {
        const active = rules.version === 2 ? rules : genericDefaults, maximum = validateRules(active);
        const breakdown = active.criteria.map((criterion: Criterion) => { const raw = sourceValue(lead, criterion.field), matches = criterion.cases.filter((c: Comparison & { points: number; }) => conditionMatches(raw, c)); return { name: criterion.name, maximum: criterion.weight, points: matches.length ? Math.max(...matches.map((c: Comparison & { points: number; }) => c.points)) : 0, reason: unknown(raw) ? 'Unknown' : `${criterion.field}: ${raw}${matches.length ? ' (matched)' : ' (no match)'}` }; });

        let eligibility: "Eligible" | "Ineligible" | "Needs data" = 'Eligible';
        const reasons = [];
        for (const condition of active.eligibility) {
            const raw = sourceValue(lead, condition.field);
            if (!conditionMatches(raw, condition)) {
                const missing = unknown(raw) && !['missing', 'present'].includes(condition.operator);
                if (!missing)
                    eligibility = 'Ineligible';
                else if (eligibility !== 'Ineligible')
                    eligibility = 'Needs data';
                reasons.push(`${condition.field}: ${missing ? 'Missing data' : 'Eligibility condition not met'}`);
            }
        }
        const segment = active.segments.find((s: Segment) => s.conditions.every((c: Condition) => conditionMatches(sourceValue(lead, c.field), c)))?.name || 'General';
        const score = Math.round(breakdown.reduce((sum: number, c: { name: string; maximum: number; points: number; reason: string; }) => sum + c.points, 0) * 100) / 100, band = !active.criteria.length ? 'Unscored' : score >= active.high ? 'High' : score >= active.medium ? 'Medium' : 'Low';
        return { score, maximum, band, segment, eligibility, reasons, qualified: eligibility === 'Eligible' && band === 'High', breakdown };
    }
    const maximum = validateRules(rules), segment = segmentFor(lead.job_title), w = rules.weights || defaults.weights;
    const inArea = rules.cities.some((c: string) => norm(c) === norm(lead.city));
    const size = lead.office_employees, onsite = lead.avg_daily_onsite;
    const breakdown = [];

    const add = (name: string, key: WeightKey, missing: boolean, fraction: number, reason: string) => breakdown.push({ name, maximum: w[key], points: missing ? 0 : w[key] * fraction, reason: missing ? 'Unknown' : reason });
    add('Service area', 'city', unknown(lead.city), inArea ? 1 : 0, inArea ? 'Inside service area' : 'Outside service area');
    add('Office size', 'size', unknown(size), Number(size) >= 20 && Number(size) <= 150 ? 1 : ((Number(size) >= 10 && Number(size) <= 19) || (Number(size) >= 151 && Number(size) <= 250)) ? .5 : 0, `${size} office employees`);
    add('Daily attendance', 'onsite', unknown(onsite), Number(onsite) >= 15 ? 1 : Number(onsite) >= 5 ? .4 : 0, `${onsite} people onsite daily`);
    add('Contact role', 'role', unknown(lead.job_title), segment === 'Unassigned' ? 0 : 1, segment === 'Unassigned' ? 'Role not in target segments' : segment);
    const method = norm(lead.purchasing_method);
    add('Purchasing method', 'purchasing', unknown(lead.purchasing_method), ['manual shopping', 'ad hoc orders'].includes(method) ? 1 : 0, lead.purchasing_method ?? '');
    if (rules.criteria) {
        breakdown.length = 0;
        for (const criterion of rules.criteria) {
            const raw = sourceValue(lead, criterion.field), matches = criterion.cases.filter((c: Comparison & { points: number; }) => conditionMatches(raw, c));
            const points = matches.length ? Math.max(...matches.map((c: Comparison & { points: number; }) => c.points)) : 0;
            breakdown.push({ name: criterion.name, maximum: criterion.weight, points, reason: unknown(raw) ? (matches.length ? 'Missing value matched' : 'Unknown') : `${criterion.field}: ${raw}${matches.length ? ' (matched)' : ' (no match)'}` });
        }
    }
    const reasons = [];
    if (!unknown(lead.city) && !inArea)
        reasons.push('Outside service area');
    if (!unknown(onsite) && Number(onsite) < 5)
        reasons.push('Fewer than 5 people onsite daily');

    let eligibility: "Eligible" | "Ineligible" | "Needs data" = reasons.length ? 'Ineligible' : 'Eligible';
    if (!reasons.length && (unknown(lead.city) || unknown(onsite))) {
        eligibility = 'Needs data';
        reasons.push('Supply city and daily attendance to determine eligibility');
    }
    const score = Math.round(breakdown.reduce((n: number, r: { name: string; maximum: number; points: number; reason: string; }) => n + r.points, 0) * 100) / 100;
    const band = score >= rules.high ? 'High' : score >= rules.medium ? 'Medium' : 'Low';
    return { score, maximum, band, segment, eligibility, reasons, qualified: eligibility === 'Eligible' && band === 'High', breakdown };
}

export function matchesFilters(lead: Lead, result: ScoreResult, filters: { query?: string; segment?: string; city?: string; minimum?: string | number | null; eligibility?: string; qualification?: string; status?: string; missing?: boolean; } | undefined = {}) {
    const query = norm(filters.query);
    return (!query || norm([lead.first_name, lead.last_name, lead.company, lead.job_title, lead.city, lead.email].join(' ')).includes(query))
        && (!filters.segment || result.segment === filters.segment)
        && (!filters.city || norm(lead.city) === norm(filters.city))
        && (filters.minimum === '' || filters.minimum == null || result.score >= Number(filters.minimum))
        && (!filters.eligibility || result.eligibility === filters.eligibility)
        && (!filters.qualification || (result.qualified ? 'Qualified' : 'Not qualified') === filters.qualification)
        && (!filters.status || (lead.outreach_status || 'Not contacted') === filters.status)
        && (!filters.missing || ['first_name', 'email', 'job_title', 'city', 'office_employees', 'avg_daily_onsite'].some((k: string) => unknown(lead[k])));
}

import type {Column, Lead, ScoreResult} from './types.js';
import { warnings } from './lead-schema.mjs';
export const outreachColumns = [
    { key: 'segment', label: 'Segment' }, { key: 'score', label: 'Score' }, { key: 'band', label: 'Priority' },
    { key: 'eligibility', label: 'Eligibility' }, { key: 'qualification', label: 'Qualification' },
    { key: 'status', label: 'Outreach status' }, { key: 'data', label: 'Data quality' },
];

export function outreachValues(lead: Lead, result: ScoreResult, columns: Column[]): Record<string, string | number> {
    return { segment: result.segment, score: result.score, band: result.band, eligibility: result.eligibility,
        qualification: result.qualified ? 'Qualified' : 'Not qualified', status: lead.outreach_status || 'Not contacted',
        data: warnings(lead, columns).length ? 'Needs attention' : 'Complete' };
}

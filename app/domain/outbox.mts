import type {Column, Lead, MessageSnapshot, Rules} from './types.js';
import { messageIssues } from './outreach.mjs';
import { sourceColumns, sourceValue } from './lead-schema.mjs';
import { scoreLead } from './scoring.mjs';
// Outbox copies are independent of the lead's working draft and delivery history.

export function messageSnapshot(lead: Lead, rules: Rules, { datasetId = '', datasetName = '' }: { datasetId?: string; datasetName?: string; } | undefined = {}): MessageSnapshot {
    const issues = messageIssues(lead, rules).map((issue: string) => issue.replaceAll('before approval', 'before adding to Outbox').replaceAll('Regenerate the draft', 'Reset the draft'));
    if (issues.length || !lead.draft)
        throw Error(issues.join(' '));
    const recipient = String(lead.email || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient))
        throw Error('Enter one valid recipient email.');
    if (/[\r\n]/.test(lead.draft.subject) || lead.draft.subject.length > 500 || lead.draft.body.length > 50000)
        throw Error('Invalid subject or message too large.');
    const result = scoreLead(lead, rules);
    return { leadId: lead.lead_id, datasetId, datasetName, recipient, subject: lead.draft.subject, body: lead.draft.body,
        version: lead.draft.version, templateName: lead.draft.templateName || 'General', segment: result.segment,
        synthetic: lead.data_origin === 'synthetic',
        source: Object.fromEntries(sourceColumns([lead]).map((column: Column) => [column.label, sourceValue(lead, column.key)])) };
}
export { outboxFields, outboxValue, filterOutbox } from './outbox-filters.mjs';

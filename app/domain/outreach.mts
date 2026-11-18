import type {Lead, MessageTemplate, Rules, Templates} from './types.js';
import { sourceValue, recipientEmail } from './lead-schema.mjs';
import { scoreLead, defaults as scoringDefaults } from './scoring.mjs';
import { sourceSnapshot, draftSourceIsCurrent } from './source-state.mjs';
import { leadDrafts, saveActiveDraft } from './draft-state.mjs';

export const templates: Record<string, MessageTemplate> = {
    General: { subject: 'A quick introduction', body: "Hello,\n\nI would like to introduce our services. Would you be open to a brief conversation?" },
    // Legacy segment keys remain readable for previously saved datasets.
    'Office operations': { subject: 'A quick introduction', body: 'Hi {{first_name}},\n\nI would like to introduce our services to {{company}}.\n\nWould you be open to a brief conversation?' },
    'People and HR': { subject: 'A quick introduction for your team', body: 'Hi {{first_name}},\n\nI would like to introduce our services to the team at {{company}}.\n\nWould you be open to a brief conversation?' }
};
const tokens = new Set(['first_name', 'last_name', 'company', 'job_title', 'city', 'personalized_line']);

export const templateNames = (value: object) => Object.keys(value).filter((key: string) => !key.startsWith('_'));

export function templateAt(config: Templates, name: string): MessageTemplate | undefined {
    const value = config[name];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
// Remove retired settings/tokens only from editable template copies; historical messages stay intact.

export function withoutPersonalization(value: Templates) {
    const next = structuredClone(value);
    delete next._factColumn;
    for (const name of templateNames(next))
        for (const field of  ['subject', 'body'] as const) {
            const template = templateAt(next, name);
            if (!template)
                throw Error('Both segments need a subject and body.');
            template[field] = template[field].replace(/{{\s*personalized_line\s*}}/g, '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
        }
    return next;
}

export function validateTemplates(input: unknown): Templates {
    const value =  input as Templates;
    if (!value || typeof value !== 'object' || !templateNames(value).length)
        throw Error('Add at least one template.');
    if (value._columns && (!Array.isArray(value._columns) || value._columns.some((key: string) => typeof key !== 'string')))
        throw Error('Template columns must be a list.');
    if (value._factColumn != null && typeof value._factColumn !== 'string')
        throw Error('Choose a valid fact column.');
    for (const segment of templateNames(value)) {
        const item = templateAt(value, segment);
        if (typeof item?.subject !== 'string' || !item.subject.trim() || typeof item?.body !== 'string' || !item.body.trim())
            throw Error('Both segments need a subject and body.');
        for (const match of (item.subject + '\n' + item.body).matchAll(/{{\s*([^{}]+?)\s*}}/g))
            if (!tokens.has(match[1]) && !match[1].startsWith('csv:') && !value._columns?.includes(match[1]))
                throw Error(`Unsupported merge field: ${match[1]}`);
        const leftover = (item.subject + '\n' + item.body).replace(/{{\s*([^{}]+?)\s*}}/g, '');
        if (/[{}]/.test(leftover))
            throw Error('Use complete merge fields such as {{company}}.');
    }
    return value;
}

function event(lead: Lead, type: string, version: number | undefined) { return [...(lead.activity || []), { type, version, at: new Date().toISOString() }]; }
export const manualTemplate = '__manual__';

export function defaultTemplateName(lead: Lead, config: Templates, rules: Rules | undefined = scoringDefaults) {
    const segment = scoreLead(lead, rules).segment;
    return Object.hasOwn(config, segment) ? segment : 'General';
}

export function generateDraft(lead: Lead, config: Templates | undefined = templates, mode: string | undefined = 'merge', rules: Rules | undefined = scoringDefaults, selection?: string | undefined): Lead & { draft: import("./types.js").Draft; } {
    if (lead.messageWorkflow !== 2 && (lead.outbox?.length || lead.live_delivery))
        throw Error('Initial outreach has already been queued or sent.');
    validateTemplates(config);
    if (!['merge', 'mock'].includes(mode))
        throw Error('Choose mail merge.');
    mode = 'merge'; // Legacy callers can regenerate old mock drafts as ordinary mail merge.
    const segment = scoreLead(lead, rules).segment;
    const templateName = selection ?? defaultTemplateName(lead, config, rules);
    const template = templateName === manualTemplate ? { subject: '', body: '' } : Object.hasOwn(config, templateName) ? templateAt(config, templateName) : templateName === 'General' ? templates.General : null;
    if (!template)
        throw Error('The selected template no longer exists. Choose another template.');
    const values = { ...lead, first_name: lead.first_name || 'there', personalized_line: '' };

    const missingVariables: string[] = [];

    const fill = (text: string) => text.replace(/{{\s*([^{}]+?)\s*}}/g, (_: string, key: string) => {
        let value;
        if (key.startsWith('csv:') || key.startsWith('custom:'))
            value = sourceValue(lead, key);
        else if (lead.values && Object.hasOwn(lead.values, key))
            value = lead.values[key];
        else if (lead.values && key !== 'personalized_line')
            value = undefined;
        else
            value = values[ key as "values" | "email" | "city" | "lead_id" | "company" | "first_name" | "last_name" | "job_title" | "industry" | "office_employees" | "avg_daily_onsite" | "purchasing_method" | "company_fact" | "fact_source" | "data_origin" | "recipient_column" | "extra_fields" | "import_fingerprint" | "source_revision" | "messageWorkflow" | "draft" | "drafts" | "activeDraftId" | "approval" | "activity" | "outreach_status" | "live_delivery" | "outbox" | "followup" | "reply" | "personalized_line"];
        if (lead.values && key !== 'personalized_line' && (value == null || String(value).trim() === ''))
            missingVariables.push(key);
        return String(value ?? '');
    }).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
    const version = (lead.draft?.version || 0) + 1;
    const subject = fill(template.subject), body = fill(template.body);
    return { ...saveActiveDraft(lead, { subject, body, missingVariables, templateName, version, sourceVersion: 2, sourceKey: sourceSnapshot(lead), segment, mode, generatedAt: new Date().toISOString() }), approval: null, outreach_status: 'Drafted', activity: event(lead, 'Draft generated', version) };
}

export function createAdditionalDraft(lead: Lead, config: Templates | undefined = templates, rules: Rules | undefined = scoringDefaults, selection?: string | undefined) {
    const next = { ...lead, drafts: leadDrafts(lead), draft: null, activeDraftId: null, approval: null };
    return generateDraft(next, config, 'merge', rules, selection);
}

export function editDraft(lead: Lead, subject: string, body: string): Lead {
    if (lead.messageWorkflow !== 2 && (lead.outbox?.length || lead.live_delivery))
        throw Error('Queued or sent messages are read-only.');
    if (!lead.draft)
        throw Error('Generate a draft first.');
    if (subject === lead.draft.subject && body === lead.draft.body)
        return lead;
    const version = lead.draft.version + 1;
    return { ...saveActiveDraft(lead, { ...lead.draft, subject, body, missingVariables: [], version }), approval: null, outreach_status: 'Drafted', activity: event(lead, 'Draft edited', version) };
}

export function messageIssues(lead: Lead, rules: Rules | undefined = scoringDefaults): string[] {
    if (!lead.draft)
        return ['Generate a draft first.'];
    const issues = [];
    const result = scoreLead(lead, rules);
    if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
        issues.push('A valid recipient email is required.');
    }
    if (result.eligibility !== 'Eligible')
        issues.push('Lead must be Eligible.');
    if (lead.values && lead.email !== recipientEmail(lead)) {
        issues.push('Recipient column changed. Correct the recipient field and regenerate the draft.');
    }
    if ((lead.values || rules.version === 2) && lead.draft.segment !== result.segment) {
        issues.push('Segment changed. Regenerate the draft.');
    }
    if (lead.draft.missingVariables?.length) {
        issues.push('Missing template values: ' + lead.draft.missingVariables.join(', ') + '. Edit the message or update the source.');
    }
    if (!draftSourceIsCurrent(lead, lead.draft)) {
        issues.push('Source data changed or this older draft needs verification. Regenerate the draft.');
    }
    if (!lead.draft.subject.trim() || !lead.draft.body.trim())
        issues.push('Subject and body cannot be blank.');
    if (/[{}]/.test(lead.draft.subject + lead.draft.body))
        issues.push('Resolve all placeholders before approval.');
    return issues;
}
// Retained only for legacy saved workflow compatibility; current Outbox has no approval gate.
export const approvalIssues = messageIssues;

export function approveDraft(lead: Lead, rules: Rules | undefined = scoringDefaults): Lead & { draft: import("./types.js").Draft; approval: import("./types.js").Approval; } {
    if (lead.outbox?.length || lead.live_delivery)
        throw Error('Initial outreach has already been queued or sent.');
    const issues = approvalIssues(lead, rules);
    if (issues.length || !lead.draft)
        throw Error(issues.join(' '));
    if (isApproved(lead, rules))
        return lead;
    return {
        ...lead,
        draft: lead.draft,
        approval: { version: lead.draft.version, at: new Date().toISOString() },
        outreach_status: 'Approved',
        activity: event(lead, 'Draft approved', lead.draft.version),
    };
}

export function isApproved(lead: Lead, rules: Rules | undefined = scoringDefaults): lead is Lead & { draft: import("./types.js").Draft; approval: import("./types.js").Approval; } {
    return !!lead.approval && lead.approval.version === lead.draft?.version && !approvalIssues(lead, rules).length;
}

export function reconcileApproval(lead: Lead, rules: Rules | undefined = scoringDefaults): Lead {
    if (lead.outbox?.length || lead.live_delivery)
        return lead;
    if (lead.approval && !isApproved(lead, rules)) {
        return {
            ...lead,
            approval: null,
            outreach_status: 'Drafted',
            activity: event(lead, 'Approval invalidated', lead.draft?.version),
        };
    }
    return lead;
}

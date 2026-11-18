import type {Lead, LegacySimulation, Rules} from './types.js';
import { generateDraft, editDraft, approveDraft, isApproved, templates } from './outreach.mjs';

function addEvent(lead: Lead, type: string, version: number) { return [...(lead.activity || []), { type, version, at: new Date().toISOString() }]; }

export function simulateInitial(lead: Lead, rules: Rules): Lead {
    if (lead.live_delivery)
        throw Error('Real outreach is already recorded for this lead.');
    if (lead.outbox?.length)
        throw Error('Initial outreach has already been simulated.');
    if (lead.reply)
        throw Error('This lead has already replied.');
    if (!isApproved(lead, rules))
        throw Error('Approve the current eligible message before simulating delivery.');
    return { ...lead, outbox: [snapshot(lead, 'initial')], outreach_status: 'Simulated sent', activity: addEvent(lead, 'Initial email simulated sent', lead.draft.version) };
}

function snapshot(lead: Lead & { draft: import("./types.js").Draft; approval: import("./types.js").Approval; }, kind: string): LegacySimulation { return { id: crypto.randomUUID(), kind, recipient: lead.email, subject: lead.draft.subject, body: lead.draft.body, version: lead.draft.version, approvedAt: lead.approval.at, sentAt: new Date().toISOString(), delivery: 'simulated' }; }

function requireFollowup(lead: Lead) {
    const initial = lead.outbox?.find((r: LegacySimulation) => r.kind === 'initial');
    if (!initial)
        throw Error('Simulate the initial message first.');
    if (lead.reply)
        throw Error('A simulated reply stops follow-ups.');
    if (lead.outbox?.some((r: LegacySimulation) => r.kind === 'followup'))
        throw Error('The one allowed follow-up has already been simulated.');
    if (lead.email !== initial.recipient)
        throw Error('Recipient changed since initial delivery. Follow-up is blocked.');
    return initial;
}

function project(lead: Lead): Lead { return { ...lead, outbox: [], draft: lead.followup?.draft, approval: lead.followup?.approval, activity: [] }; }

export function generateFollowup(lead: Lead, rules: Rules): Lead {
    const initial = requireFollowup(lead);
    const config = Object.fromEntries(Object.keys(templates).map((k: string) => [k, { subject: 'Following up', body: 'Hi {{first_name}},\n\nFollowing up on my earlier message. Would you be open to a conversation about {{company}}?' }]));
    const generated = generateDraft(project(lead), lead.values ? { General: { subject: 'Following up', body: 'Hello,\n\nFollowing up on my earlier message. Would you be open to a conversation?' } } : config, 'merge', rules);
    generated.draft.subject = `Re: ${initial.subject}`;
    return { ...lead, followup: { draft: generated.draft, approval: null }, activity: addEvent(lead, 'Follow-up drafted', generated.draft.version) };
}

export function editFollowup(lead: Lead, subject: string, body: string): Lead {
    requireFollowup(lead);
    const edited = editDraft(project(lead), subject, body);
    if (edited.draft === lead.followup?.draft)
        return lead;
    return { ...lead, followup: { draft: edited.draft, approval: edited.approval }, activity: addEvent(lead, 'Follow-up edited', edited.draft?.version ?? 0) };
}

export function approveFollowup(lead: Lead, rules: Rules): Lead {
    requireFollowup(lead);
    const approved = approveDraft(project(lead), rules);
    if (lead.followup?.approval?.version === approved.approval.version)
        return lead;
    return { ...lead, followup: { draft: approved.draft, approval: approved.approval }, activity: addEvent(lead, 'Follow-up approved', approved.draft.version) };
}

export function followupApproved(lead: Lead, rules: Rules) { return !!lead.followup && isApproved(project(lead), rules); }

export function simulateFollowup(lead: Lead, rules: Rules): Lead {
    requireFollowup(lead);
    const followup = project(lead);
    if (!lead.followup || !isApproved(followup, rules))
        throw Error('Approve the current eligible follow-up before simulating delivery.');
    return { ...lead, outbox: [...(lead.outbox || []), snapshot(followup, 'followup')], outreach_status: 'Simulated follow-up sent', activity: addEvent(lead, 'Follow-up simulated sent', followup.draft.version) };
}

export function simulateReply(lead: Lead, text: string): Lead {
    if (!lead.outbox?.length)
        throw Error('Simulate an initial delivery before a reply.');
    if (lead.reply)
        throw Error('A reply has already been simulated.');
    if (!text.trim())
        throw Error('Enter a simulated reply.');
    return { ...lead, reply: { body: text.trim(), at: new Date().toISOString(), simulated: true }, followup: lead.followup ? { ...lead.followup, approval: null } : undefined, outreach_status: 'Simulated replied', activity: addEvent(lead, 'Reply simulated; follow-ups stopped', lead.draft?.version ?? 0) };
}

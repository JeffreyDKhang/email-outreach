import type {DetailOptions} from './types.js';
import type {Column, Lead} from '../domain/types.js';
import { closest } from './dom.mjs';
import { byId as $, eventElement } from './dom.mjs';
import { scoreLead } from '../domain/scoring.mjs';
import { warnings, label } from '../domain/lead-schema.mjs';
import { sourceColumns, sourceValue } from '../domain/lead-schema.mjs';

export function mountLeadDetail({ getLeads, getColumns = () => sourceColumns(getLeads()), getRules, openOutreach, escape }: DetailOptions) {
    $('close-detail').onclick = () => $('detail').close();

    function scoreHTML(lead: Lead) { const result = scoreLead(lead, getRules()); return `<section class="score-card"><h3>${result.score} / ${result.maximum} &middot; ${result.band} priority</h3><p>${escape(result.segment)} &middot; ${escape(result.eligibility)} &middot; ${result.qualified ? 'Qualified' : 'Not qualified'}</p>${result.reasons.map((r: string) => `<p class="warning">${escape(r)}</p>`).join('')}<ul>${result.breakdown.map((r: { name: string; maximum: number; points: number; reason: string; }) => `<li><strong>${escape(r.name)}: ${r.points} / ${r.maximum}</strong><span>${escape(r.reason)}</span></li>`).join('')}</ul><p>Qualification indicates fit. Missing email still prevents future sending.</p></section>`; }
    $('leads').onclick = (event: PointerEvent) => { const button = closest(eventElement(event), '[data-id]'); if (!button)
        return; const lead = getLeads().find((r: Lead) => r.lead_id === button.dataset.id); if (!lead)
        return; $('detail-content').innerHTML = `<h2>${escape(lead.company)}</h2><p>${escape([lead.first_name, lead.last_name].join(' '))} · ${escape(lead.job_title)}</p>${warnings(lead, getColumns()).length ? `<p class="warning">Missing fields: ${escape(warnings(lead, getColumns()).map((key: string) => lead.values ? key : label(key)).join(', '))}</p>` : ''}${scoreHTML(lead)}<dl>${getColumns().map((c: Column) => `<dt>${escape(c.label)}</dt><dd>${escape(sourceValue(lead, c.key) === '' ? 'Not supplied' : sourceValue(lead, c.key))}</dd>`).join('')}</dl><button id="review-outreach" class="primary">Review Message</button>`; $('review-outreach').onclick = () => { $('detail').close(); openOutreach(lead); }; $('detail').showModal(); };
}

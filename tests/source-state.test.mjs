import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceSnapshot, draftSourceIsCurrent } from '../app/domain/source-state.mjs';
import { generateDraft, approveDraft } from '../app/domain/outreach.mjs';
import { editLeadField } from '../app/domain/lead-edit.mjs';
import { deleteDatasetColumn } from '../app/domain/dataset-tools.mjs';
import { createDataset } from '../app/domain/datasets.mjs';
import { genericDefaults } from '../app/domain/scoring.mjs';
import { prepareLiveBatch } from '../server/sending.mjs';

const legacy = () => ({ lead_id:'legacy', company:'Test', email:'test@company.test', extra_fields:{ Budget:'10' } });
const config = { General:{ subject:'Budget', body:'Your budget: {{custom:Budget}}' }, _columns:['custom:Budget'] };
const account = { id:'sender', email:'sender@company.test', provider:'gmail' };

test('legacy custom-field edits cannot reapprove or queue stale copy, even after editing back', () => {
  const approved = approveDraft(generateDraft(legacy(), config, 'merge', genericDefaults), genericDefaults);
  const edited = editLeadField(approved, 'custom:Budget', '20');
  assert.equal(edited.draft.body, 'Your budget: 10');
  assert.throws(() => approveDraft(edited, genericDefaults), /Regenerate/);
  assert.throws(() => prepareLiveBatch([edited], genericDefaults, account, []));
  const restoredValue = editLeadField(edited, 'custom:Budget', '10');
  assert.throws(() => approveDraft(restoredValue, genericDefaults), /Regenerate/);
  const fresh = approveDraft(generateDraft(edited, config, 'merge', genericDefaults), genericDefaults);
  assert.equal(prepareLiveBatch([fresh], genericDefaults, account, []).items[0].body, 'Your budget: 20');
});

test('blank legacy column removal uses the same source revision policy as field edits', () => {
  const lead = { ...legacy(), industry:'' };
  const data = createDataset('Legacy', [approveDraft(generateDraft(lead, config, 'merge', genericDefaults), genericDefaults)]);
  const changed = deleteDatasetColumn(data, 'industry');
  assert.equal(changed.leads[0].source_revision, 1);
  assert.throws(() => approveDraft(changed.leads[0], genericDefaults), /Regenerate/);
  assert.equal(data.leads[0].source_revision, undefined);
});

test('all legacy fields and extras participate; activity/status do not alter the source snapshot', () => {
  const original = legacy(), before = sourceSnapshot(original);
  for (const patch of [{ office_employees:25 }, { purchasing_method:'Changed' }, { data_origin:'synthetic' }, { extra_fields:{ Budget:'20' } }]) {
    assert.notEqual(sourceSnapshot({ ...original, ...patch }), before);
  }
  assert.equal(sourceSnapshot({ ...original, outreach_status:'Drafted', activity:[{type:'Review'}] }), before);
});

test('new snapshots are order-independent; compatible old native drafts remain usable', () => {
  const lead = { lead_id:'csv', company:'Ada', email:'ada@company.test', values:{ Name:'Ada', Email:'ada@company.test' }, recipient_column:'Email' };
  const reordered = { ...lead, values:{ Email:'ada@company.test', Name:'Ada' } };
  assert.equal(sourceSnapshot(lead), sourceSnapshot(reordered));
  const old = { sourceKey:JSON.stringify([lead.values, lead.recipient_column, lead.email]) };
  assert.equal(draftSourceIsCurrent(lead, old), true);
  assert.equal(draftSourceIsCurrent({ ...lead, source_revision:1 }, old), false);
  const oldLegacy = { sourceKey:JSON.stringify(['', '', 'Test', '', '', 'test@company.test', '', '']) };
  assert.equal(draftSourceIsCurrent(legacy(), oldLegacy), false);
});

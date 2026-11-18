import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStorageRepository,storageKeys} from '../app/infrastructure/storage.mjs';
import {defaults} from '../app/domain/scoring.mjs';
import {templates,generateDraft,approveDraft} from '../app/domain/outreach.mjs';
import {simulateInitial} from '../app/domain/delivery.mjs';

function memoryStorage() {
  const data = new Map();
  return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value)};
}
test('repository reads existing v1 keys and round-trips nested workflow state', () => {
  const storage = memoryStorage();
  const lead = {lead_id:'one',company:'Example',email:'alex@example.com',job_title:'Office Manager',city:'Toronto',avg_daily_onsite:25};
  const sent = simulateInitial(approveDraft(generateDraft(lead)));
  storage.setItem('officepantry.leads.v1',JSON.stringify([sent]));
  const repository = createStorageRepository(storage);
  assert.deepEqual(repository.loadLeads(),[sent]);
  repository.saveRules(defaults);
  repository.saveTemplates(templates);
  assert.deepEqual(repository.loadRules(),defaults);
  assert.deepEqual(repository.loadTemplates(),templates);
  repository.saveLeads([sent]);
  assert.deepEqual(createStorageRepository(storage).loadLeads(),[sent]);
});
test('invalid saves and corrupted reads do not overwrite stored data', () => {
  const storage = memoryStorage(),repository = createStorageRepository(storage);
  repository.saveRules(defaults);
  const original = storage.getItem(storageKeys.rules);
  assert.throws(() => repository.saveRules({...defaults,high:999}));
  assert.equal(storage.getItem(storageKeys.rules),original);
  assert.throws(() => repository.saveLeads([{}]));
  storage.setItem(storageKeys.leads,'broken JSON');
  assert.throws(() => repository.loadLeads());
  assert.equal(storage.getItem(storageKeys.leads),'broken JSON');
});
test('storage failures propagate and defaults are independent copies', () => {
  const repository = createStorageRepository(memoryStorage());
  const rules = repository.loadRules();rules.cities.push('Other');
  assert.deepEqual(repository.loadRules(),defaults);
  const failing = createStorageRepository({getItem(){throw Error('Denied');},setItem(){throw Error('Full');}});
  assert.throws(() => failing.loadLeads(),/Denied/);
  assert.throws(() => failing.saveLeads([]),/Full/);
});

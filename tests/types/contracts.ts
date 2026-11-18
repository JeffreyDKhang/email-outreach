// Compiler-only tests. tsc checks these; Node never executes them or sends mail.
// Each expect-error must produce a diagnostic, or the typecheck fails.
import type {DeliveryStatus, EmailProvider, Lead, LiveApi, MessageSnapshot, Rules, Workspace} from '../../app/domain/types.js';
import {createLiveApi} from '../../app/infrastructure/live-api.mjs';
import {createWorkspaceRepository} from '../../app/infrastructure/workspace-repository.mjs';
import {createOutboxService} from '../../app/application/outbox.mjs';
import {generateDraft} from '../../app/domain/outreach.mjs';
import {messageSnapshot} from '../../app/domain/outbox.mjs';
import {requireProvider} from '../../server/providers/interface.mjs';
import {byId} from '../../app/ui/dom.mjs';
import type {SettingsStore} from '../../server/types.js';

export async function validContracts(lead: Lead, rules: Rules, workspace: Workspace) {
  const api: LiveApi = createLiveApi();
  const record = await api('/api/workspace');
  record.revision satisfies number;
  record.workspace satisfies Workspace | null;
  const result = await api('/api/workspace', {workspace, revision: record.revision});
  result.revision satisfies number;
  const repo = createWorkspaceRepository({api, legacy: {loadWorkspace: () => workspace}});
  (await repo.save(workspace)) satisfies Workspace;
  const draft = generateDraft(lead, undefined, 'merge', rules);
  draft.draft.subject satisfies string;
  const snapshot: MessageSnapshot = messageSnapshot(draft, rules);
  snapshot.templateName satisfies string;
  const outbox = createOutboxService({api, getDataset: () => workspace.datasets[0] ?? null});
  (await outbox.add([draft])).ids satisfies string[];
  const provider: EmailProvider = requireProvider({
    getAccount: () => null,
    disconnect: async () => {},
    sendMessage: async () => ({status: 'accepted', messageId: 'fake-only'}),
  });
  return provider;
}

export async function invalidContracts(api: LiveApi, workspace: Workspace, lead: Lead, rules: Rules) {
  // @ts-expect-error A misspelled endpoint must not silently return any.
  await api('/api/workspaces');
  // @ts-expect-error Workspace writes require the optimistic-concurrency revision.
  await api('/api/workspace', {workspace});
  // @ts-expect-error Revision numbers cannot be text.
  await api('/api/workspace', {workspace, revision: '1'});
  // @ts-expect-error Enqueue requires the digest of the reviewed messages.
  await api('/api/live/enqueue', {id: 'preview'});
  // @ts-expect-error Outbox selection IDs are strings, not row positions.
  await api('/api/outbox/preview', {ids: [1]});
  // @ts-expect-error A text delay is invalid even when it looks numeric.
  await api('/api/sending/settings', {delaySeconds: '30'});
  const messages = await api('/api/outbox');
  // @ts-expect-error The API returns a messages collection, not jobs.
  messages.jobs;
  // @ts-expect-error Gmail acceptance is not proof of inbox delivery.
  const status: DeliveryStatus = 'delivered';
  // @ts-expect-error Sending needs a message body as well as a subject.
  const snapshot: MessageSnapshot = {recipient: 'test@company.test', subject: 'Hello'};
  // @ts-expect-error Shared business functions reject incomplete leads.
  messageSnapshot({lead_id: 'one'}, rules);
  const draft = generateDraft(lead, undefined, 'merge', rules);
  // @ts-expect-error Message text must be a string.
  draft.draft.body = 123;
  return {status, snapshot};
}

export function interfaceContracts(store: SettingsStore){
  byId('draft-subject').value satisfies string;
  byId('settings-dialog').showModal();
  // @ts-expect-error Static control names must exist in the app markup.
  byId('drfat-subject');
  // @ts-expect-error A message container is not a text input.
  byId('outbox-messages').value;
  // @ts-expect-error OAuth configuration fields must be strings.
  store.set('google-config',{clientId: 123,clientSecret: 'fake-only'});
  // @ts-expect-error Delivery settings require a numeric pace.
  store.set('sending-settings',{delaySeconds: '30'});
}

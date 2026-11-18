// Shared persisted and wire contracts. No browser, database or provider imports.
// Legacy fields remain optional so existing saved workspaces can be migrated.
export type SourceValue = string | number | boolean | null;
export type ColumnType = 'text' | 'number';
export interface Column { key: string; label: string }
export type Operator = 'equals' | 'not_equals' | 'contains' | 'in' | 'gte' | 'lte' | 'between' | 'present' | 'missing';
export interface Comparison { operator: Operator; value?: SourceValue; to?: SourceValue }
export interface Condition extends Comparison { field: string }
export interface Criterion { name: string; field: string; weight: number; cases: (Comparison & {points: number})[] }
export interface Segment { name: string; conditions: Condition[] }
export interface PriorityThresholds { medium: number; high: number; columnTypes?: Record<string, ColumnType> }
export interface RuleProfile extends PriorityThresholds {
  version: 2;
  criteria: Criterion[];
  eligibility: Condition[];
  segments: Segment[];
}
export type WeightKey = 'city' | 'size' | 'onsite' | 'role' | 'purchasing';
export interface LegacyRules extends PriorityThresholds {
  version?: 1;
  cities: string[];
  weights: Record<WeightKey, number>;
  criteria?: Criterion[];
  eligibility?: Condition[];
  segments?: Segment[];
}
export type Rules = RuleProfile | LegacyRules;
export interface MessageTemplate { subject: string; body: string }
// The existing file format stores reserved metadata beside user-named templates.
export interface Templates {
  [name: string]: MessageTemplate | string[] | string | undefined;
  _columns?: string[];
  _factColumn?: string;
}
export interface Activity { type: string; version?: number; at: string }
export interface Approval { version: number; at: string }
export interface Draft extends MessageTemplate {
  id?: string;
  version: number;
  templateName?: string;
  segment?: string;
  mode?: string;
  generatedAt?: string;
  missingVariables?: string[];
  sourceVersion?: number;
  sourceKey?: string;
}
export interface LegacySimulation extends MessageTemplate {
  id: string; kind: string; recipient: string; version: number;
  approvedAt: string; sentAt: string; delivery: 'simulated';
}
export type DeliveryStatus = 'queued' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'cancelled' | 'simulated';
export interface Lead {
  [field: string]: unknown;
  lead_id: string;
  company: string;
  email: string;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  city?: string;
  industry?: string;
  office_employees?: number | string;
  avg_daily_onsite?: number | string;
  purchasing_method?: string;
  company_fact?: string;
  fact_source?: string;
  data_origin?: string;
  values?: Record<string, string>;
  recipient_column?: string;
  extra_fields?: Record<string, SourceValue>;
  import_fingerprint?: string;
  source_revision?: number;
  messageWorkflow?: number;
  draft?: Draft | null;
  drafts?: Draft[];
  activeDraftId?: string | null;
  approval?: Approval | null;
  activity?: Activity[];
  outreach_status?: string;
  live_delivery?: { status: DeliveryStatus; sender?: string; messageId?: string };
  outbox?: LegacySimulation[];
  followup?: { draft?: Draft | null; approval?: Approval | null };
  reply?: { body: string; at: string; simulated: boolean };
}
export interface Dataset {
  id: string; name: string; sourceName: string;
  leads: Lead[]; rules: Rules; templates: Templates;
  native?: boolean; columns?: Column[]; recipientKey?: string;
}
export interface Workspace { version: 1; activeId: string | null; datasets: Dataset[] }
export interface WorkspaceRecord { workspace: Workspace | null; revision: number; updated: string | null }
export interface WorkspaceWrite { workspace: Workspace; revision: number }
export interface WorkspaceSaved { revision: number; updated: string }
export interface ScoreResult {
  score: number; maximum: number; band: 'Low' | 'Medium' | 'High' | 'Unscored';
  segment: string; eligibility: 'Eligible' | 'Ineligible' | 'Needs data';
  reasons: string[]; qualified: boolean;
  breakdown: { name: string; maximum: number; points: number; reason: string }[];
}
export interface MessageSnapshot extends MessageTemplate {
  leadId: string; datasetId: string; datasetName: string;
  recipient: string; version: number; templateName: string;
  segment: string; synthetic: boolean; source: Record<string, unknown>;
}
export interface OutboxMessage {
  id: string; payload: MessageSnapshot; status: 'held' | 'queued';
  batch_id?: string | null; batch_name?: string | null; created: string;
}
export interface OutboxFilter { key: string; operator?: Operator; value?: SourceValue; to?: SourceValue }
export interface Account { id: string; email: string; provider: string }
export interface EmailProvider {
  getAccount(): Account | null;
  disconnect(): Promise<void>;
  sendMessage(message: DeliveryPayload): Promise<DeliveryResult & {status: 'accepted' | 'simulated'}>;
}
export interface DeliveryPayload extends MessageTemplate {
  id: string; account: string; sender: string; provider: string; recipient: string;
  leadId: string; version: number; outboxId?: string; directId?: string;
  datasetId?: string; datasetName?: string; batchId?: string | null; batchName?: string | null;
}
export interface DeliveryResult { provider?: string; messageId?: string; status?: 'accepted' | 'simulated'; error?: string; code?: string; stage?: string }
export interface DeliveryJob {
  id: string; account: string; recipient: string; payload: DeliveryPayload;
  status: DeliveryStatus; result: DeliveryResult | null;
  created: string; updated: string; attempted_at?: string | null; history_cleared_at?: string | null;
}
// Queue projection also accepts partial jobs created before enqueue acknowledgement.
export interface DeliveryUpdate {
  payload: Pick<DeliveryPayload, 'leadId'> & Partial<DeliveryPayload>;
  status: DeliveryStatus; recipient?: string; result?: DeliveryResult | null;
  created?: string; updated?: string;
}
export interface SendPreview { id: string; digest: string; items: DeliveryPayload[]; expires: number; kind?: 'instant' }
export interface HeldMessagesRequest { requestId: string; datasetId: string; datasetName: string; leads: Lead[]; rules: Rules }
export interface SendingSettings { delaySeconds: number }
export interface Allowance { limit: number; used: number; remaining: number; reserved: number; nextReleaseAt: string | null }
export interface ConnectionHealth { status: string; accountId?: string | null; checkedAt?: string; code?: string; stage?: string; error?: string }
export interface SendingState {
  account: Pick<Account, 'email'> | null; connection?: ConnectionHealth;
  allowance: Allowance | null; settings: SendingSettings;
  paused: { reason: string; at: string } | null; serverTime: string;
}
export interface GetApi {
  '/api/workspace': WorkspaceRecord;
  '/api/outbox': { messages: OutboxMessage[] };
  '/api/live/jobs': { jobs: DeliveryJob[] };
  '/api/sending': SendingState;
  '/api/account': { configured: boolean; account: Account | null; connection?: ConnectionHealth; redirectUri: string };
  '/api/session': { csrf: string };
}
export interface PostApi {
  '/api/workspace': { request: WorkspaceWrite; response: WorkspaceSaved };
  '/api/outbox/add': { request: HeldMessagesRequest; response: {ids: string[]} };
  '/api/outbox/batch': { request: {ids: string[]; name: string}; response: {id: string; name: string} };
  '/api/outbox/remove': { request: {ids: string[]}; response: {removed: true} };
  '/api/outbox/preview': { request: {ids: string[]}; response: SendPreview };
  '/api/instant/preview': { request: HeldMessagesRequest; response: SendPreview };
  '/api/live/preview': { request: {leads: Lead[]; rules: Rules}; response: SendPreview };
  '/api/live/enqueue': { request: {id: string; digest: string}; response: {queued: number} };
  '/api/live/history/clear': { request: {ids: string[]}; response: {cleared: number} };
  '/api/live/cancel': { request: Record<string, never>; response: {cancelled: true} };
  '/api/sending/settings': { request: SendingSettings; response: {settings: SendingSettings} };
  '/api/sending/resume': { request: Record<string, never>; response: {resumed: true} };
  '/api/google/config': { request: {clientId: string; clientSecret: string}; response: {saved: true} };
  '/api/google/connect': { request: Record<string, never>; response: {url: string} };
  '/api/google/check': { request: Record<string, never>; response: {ok: boolean; checkedAt: string; checks: {name: string; reachable: boolean; code?: string; error?: string}[]} };
  '/api/account/disconnect': { request: Record<string, never>; response: {disconnected: true; notice?: string} };
}
export interface LiveApi {
  <P extends keyof GetApi>(path: P): Promise<GetApi[P]>;
  <P extends keyof PostApi>(path: P, value: PostApi[P]['request']): Promise<PostApi[P]['response']>;
}
export interface WorkspaceRepository {
  load(): Promise<{workspace: Workspace; migrated: boolean}>;
  save(value: Workspace): Promise<Workspace>;
}
export interface LegacyWorkspaceSource { loadWorkspace(options?: {cacheMigration?: boolean}): Workspace }
export interface ParsedCSV { headers: string[]; rows: string[][] }
export interface ImportResult { accepted: Lead[]; rejected: {row: number; error: string}[] }

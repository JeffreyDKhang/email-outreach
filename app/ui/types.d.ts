import type {Column, ColumnType, Condition, Dataset, Lead, LiveApi, ParsedCSV, RuleProfile, Rules, Segment, Templates} from '../domain/types.js';
export type Guard = ReturnType<typeof import('./unsaved-changes.mjs').createUnsavedChangesGuard>;
export type SaveLeads = (leads: Lead[]) => boolean | Promise<boolean>;
export interface Context {
  api: LiveApi; escape(value: unknown): string; notice(message: string): void;
  unsavedChanges?: Guard;
  getLeads(): Lead[]; getColumns(): Column[]; getRules(): Rules;
  getDataset(): Dataset | null | undefined;
  getVisibleIds(): string[];
  save: SaveLeads;
}
export interface TemplateRepository {loadTemplates(): Templates; saveTemplates(value: Templates): unknown | Promise<unknown>}
export interface LiveSender {open(ids: string[], refresh?: (() => unknown | Promise<unknown>) | null): Promise<void>; openInstant(leads: Lead[]): Promise<void>}
export type OutboxService = ReturnType<typeof import('../application/outbox.mjs').createOutboxService>;
export type AccountsOptions = Pick<Context, 'api' | 'escape' | 'unsavedChanges'>;
export type ScoringOptions = Pick<Context, 'unsavedChanges' | 'getLeads' | 'getRules' | 'escape'> & Partial<Pick<Context,'getColumns'>> & {onSave(rules: RuleProfile): unknown | Promise<unknown>};
export type EligibilityOptions = Pick<Context, 'unsavedChanges' | 'getLeads' | 'getColumns' | 'getRules' | 'escape'> & {onSave(conditions: Condition[]): unknown | Promise<unknown>};
export type SegmentOptions = Omit<EligibilityOptions,'onSave'> & {onSave(segments: Segment[]): unknown | Promise<unknown>};
export type SegmentEditorOptions = Pick<Context, 'getLeads' | 'getColumns' | 'escape'> & {container: HTMLElement};
export type TemplatesOptions = Pick<Context,'unsavedChanges' | 'getLeads' | 'getRules' | 'escape' | 'notice'> & Partial<Pick<Context,'getColumns'>> & {repository: TemplateRepository};
export type OutreachOptions = Pick<Context,'unsavedChanges' | 'getLeads' | 'getColumns' | 'getVisibleIds' | 'getRules' | 'save' | 'escape' | 'notice'> & {repository: TemplateRepository; liveSender: LiveSender; outboxService: OutboxService};
export type BatchOptions = Pick<Context,'getLeads' | 'getVisibleIds' | 'getRules' | 'save' | 'escape'> & {getTemplates(): Templates; liveSender: LiveSender; outboxService: OutboxService};
export type LiveSendOptions = Pick<Context,'api' | 'getLeads' | 'getRules' | 'getDataset' | 'save' | 'escape'>;
export type OutboxOptions = Pick<Context,'unsavedChanges' | 'api' | 'escape'> & Partial<Pick<Context,'getDataset'>> & {liveSender: LiveSender; statusFactory?: typeof import('./sending-status-ui.mjs').mountSendingStatus};
export type SendingStatusOptions = Pick<Context,'api' | 'unsavedChanges'>;
export type QueueOptions = Pick<Context,'api' | 'escape'> & {queueSync: ReturnType<typeof import('../application/queue-sync.mjs').createQueueSync>};
export type DetailOptions = Pick<Context,'getLeads' | 'getRules' | 'escape'> & Partial<Pick<Context,'getColumns'>> & {openOutreach(lead: Lead): unknown};
export type LeadEditOptions = Pick<Context,'unsavedChanges' | 'getDataset' | 'save' | 'escape' | 'notice'>;
export type DatasetToolsOptions = Pick<Context,'unsavedChanges' | 'getDataset' | 'escape' | 'notice'> & {getSelectedIds(): string[]; onSave(dataset: Dataset): unknown | Promise<unknown>};
export type ImportOptions = Pick<Context,'unsavedChanges' | 'getDataset' | 'escape' | 'notice'> & {onImport(name: string, leads: Lead[], sourceName: string): boolean | Promise<boolean>; onAppend(id: string, leads: Lead[]): boolean | Promise<boolean>};
export interface ColumnFilter {values?: string[]; min?: string | number; max?: string | number}
export type TableOptions = Pick<Context,'getLeads' | 'escape'> & Partial<Pick<Context,'getColumns'>> & {score(lead: Lead): import('../domain/types.js').ScoreResult; getTypes?(): Record<string, ColumnType>; onChange(): unknown};

import type {DeliveryJob, DeliveryResult, DeliveryStatus, SendingSettings} from '../app/domain/types.js';
import type {Credentials, OAuth2Client} from 'google-auth-library';
import type {Account, ConnectionHealth, EmailProvider, MessageSnapshot, OutboxMessage, SendPreview} from '../app/domain/types.js';

export interface QueueSettings {
  'sending-settings': SendingSettings;
  'sending-pause': {reason: string; at: string};
}

// The worker sees only the operations it needs, not SQLite or OAuth credentials.
export interface QueueStore {
  jobs(): DeliveryJob[];
  update(id: string, status: DeliveryStatus, result?: DeliveryResult | null): void;
  get?<K extends keyof QueueSettings>(name: K): QueueSettings[K] | null;
  set?<K extends keyof QueueSettings>(name: K, value: QueueSettings[K]): void;
}
export interface Settings extends QueueSettings {
  [key: string]: unknown;
  'google-config': {clientId: string; clientSecret: string};
  'gmail-account': {id: string; email: string; tokens: Credentials};
  'gmail-connection-status': ConnectionHealth;
}
export interface SettingsStore {
  get<K extends keyof Settings>(name: K): Settings[K] | null;
  set<K extends keyof Settings>(name: K, value: Settings[K]): void;
  remove(name: string): void;
}
export interface CryptoStore {
  db: import('node:sqlite').DatabaseSync;
  seal(value: unknown): string;
  unseal(value: string): unknown;
}
export interface HeldRequest {requestId: string; digest: string; messages: {id: string; payload: MessageSnapshot}[]}
export interface StoredOutboxRow extends Omit<OutboxMessage, 'payload'> {payload: string}
export interface StoredJobRow extends Omit<DeliveryJob, 'payload' | 'result'> {payload: string; result: string | null}
export type ConnectivityRequest = (options: Parameters<OAuth2Client['transporter']['request']>[0]) => Promise<{status: number}>;
export interface GmailProvider extends EmailProvider {
  configured(): boolean;
  authorize(state: string): Promise<{verifier: string; url: string}>;
  connect(code: string | null, verifier: string): Promise<void>;
  getConnectionHealth(): ConnectionHealth;
  checkConnectivity(): ReturnType<typeof import('./google-connectivity.mjs').checkGoogleConnectivity>;
}
export interface Session {csrf: string; expires: number; oauth?: {state: string; verifier: string; expires: number}; preview?: SendPreview | null}

import type {DeliveryPayload} from '../../app/domain/types.js';
import { requireProvider } from './interface.mjs';

export function mockProvider(sender: string | undefined = 'demo@example.com') {
    return requireProvider({ getAccount: () => ({ id: 'mock', email: sender, provider: 'mock' }), disconnect: async () => { }, sendMessage: async (message: DeliveryPayload) => ({ provider: 'mock', messageId: message.id, status: 'simulated' }) });
}

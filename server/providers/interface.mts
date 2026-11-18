import type {EmailProvider} from '../../app/domain/types.js';
/** Each provider supplies getAccount(), disconnect(), and sendMessage(message).
 * message: {sender,recipient,subject,body,id}; result: {provider,messageId,status}.
 * 'accepted' means accepted by the provider, never proof of delivery.
 */

export function requireProvider<T extends EmailProvider>(provider: T): T {
    for (const method of  ['getAccount', 'disconnect', 'sendMessage'] as const)
        if (typeof provider?.[method] !== 'function')
            throw Error(`Email provider needs ${method}().`);
    return provider;
}
export class SendError extends Error {
    declare uncertain: boolean; declare pauseQueue: boolean;

    constructor(message: string, uncertain: boolean | undefined = false, pauseQueue: boolean | undefined = false) { super(message); this.uncertain = uncertain; this.pauseQueue = pauseQueue; }
}

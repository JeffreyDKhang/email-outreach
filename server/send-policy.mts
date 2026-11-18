import type {Allowance, DeliveryJob, SendingSettings} from '../app/domain/types.js';
export const SEND_LIMIT = 500;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function validateSendingSettings(value: unknown): SendingSettings {
    if (!value || typeof value !== 'object' || !('delaySeconds' in value) || typeof value.delaySeconds !== 'number' || !Number.isInteger(value.delaySeconds) || value.delaySeconds < 0 || value.delaySeconds > 3600)
        throw Error('Choose a whole-number delay from 0 to 3600 seconds.');
    return { delaySeconds: value.delaySeconds };
}

export function appAllowance(jobs: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">[], account: string, now: number | undefined = Date.now()): Allowance {
    const own = jobs.filter((job: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">) => job.account === account);
    const reserved = own.filter((job: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">) => ['queued', 'sending'].includes(job.status));
    const recent = own.filter((job: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">) => !['queued', 'sending'].includes(job.status) && Date.parse(job.attempted_at || job.created) + WINDOW_MS > now);
    const releases = recent.map((job: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">) => Date.parse(job.attempted_at || job.created) + WINDOW_MS).filter(Number.isFinite);
    const used = reserved.length + recent.length;
    return { limit: SEND_LIMIT, used, remaining: Math.max(0, SEND_LIMIT - used), reserved: reserved.length,
        nextReleaseAt: releases.length ? new Date(Math.min(...releases)).toISOString() : null };
}

export function requireAllowance(jobs: Pick<DeliveryJob, "status" | "account" | "created" | "attempted_at">[], account: string, count: number, now: number | undefined = Date.now()) {
    if (count > appAllowance(jobs, account, now).remaining)
        throw Error('This batch exceeds the remaining app allowance of 500 initial emails per sender in a rolling 24 hours.');
}

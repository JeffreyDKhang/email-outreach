import type {ConnectivityRequest} from './types.js';
import { OAuth2Client } from 'google-auth-library';
import { OAuthConnectionError, classifyOAuthError } from './oauth-errors.mjs';
// Public unauthenticated requests only: never use an account client or send email.

export async function checkGoogleConnectivity(request: ConnectivityRequest | undefined = (options: Parameters<OAuth2Client['transporter']['request']>[0]) => new OAuth2Client().transporter.request(options)) {
    const endpoints = [
        { name: 'Google authorization', url: 'https://oauth2.googleapis.com/token', expected: [404, 405] },
        { name: 'Gmail API', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', expected: [401] },
    ];
    const checks = await Promise.all(endpoints.map(async (endpoint: { name: string; url: string; expected: number[]; }) => {
        try {
            const response = await request({ url: endpoint.url, method: 'GET', retry: false, timeout: 8000, validateStatus: () => true });
            if (!endpoint.expected.includes(response.status))
                throw new OAuthConnectionError('connectivity_failed', 'connectivity');
            return { name: endpoint.name, reachable: true };
        }
        catch (error) {
            const safe = classifyOAuthError(error, 'connectivity');
            return { name: endpoint.name, reachable: false, code: safe.code, error: safe.message };
        }
    }));
    return { ok: checks.every((check: { name: string; reachable: boolean; code?: undefined; error?: undefined; } | { name: string; reachable: boolean; code: string; error: string; }) => check.reachable), checks, checkedAt: new Date().toISOString() };
}

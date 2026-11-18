
const messages: Record<string, string> = {
    invalid_client: 'Google rejected the client credentials. Save the current client ID and secret from the same Web application client, then reconnect.',
    invalid_grant: 'The authorization code expired, was already used, or did not match this connection. Start a fresh Connect Gmail flow; do not reload the callback URL.',
    redirect_uri_mismatch: 'The authorized redirect URI must exactly match the URI shown in Connect email, including host and port.',
    access_denied: 'Google authorization was denied. Reconnect and grant the requested sending permission.',
    invalid_scope: 'Google rejected the requested permissions. Confirm Gmail API and the consent-screen scopes are configured.',
    unauthorized_client: 'This Google client cannot use this authorization flow. Use a Web application OAuth client.',
    invalid_request: 'Google rejected the authorization request. Verify the Web application client configuration and start a new connection.',
    admin_policy_enforced: 'Your Google Workspace administrator blocked this application or permission.',
    network_error: 'The backend could not reach Google. Check the server’s internet access, proxy and firewall, then run Check Google connectivity. A new client secret is not needed for a network failure.',
    certificate_error: 'The backend could not verify Google’s TLS certificate. Check the machine’s certificate/proxy configuration; do not disable certificate verification.',
    missing_identity_token: 'Google did not return an identity token. Reconnect and grant the requested OpenID/email identity permissions.',
    missing_refresh_token: 'Google did not return offline access. Remove the existing app grant in your Google account if needed, then reconnect and consent again.',
    identity_verification_failed: 'Google’s identity token could not be verified. Check the machine’s clock and network access, then reconnect.',
    identity_not_verified: 'Google did not provide a verified account identity.',
    gmail_permission_missing: 'Gmail sending permission was not granted. Reconnect and select the permission to send email on your behalf.',
    scope_verification_failed: 'The backend could not verify the granted Gmail permission. Reconnect; check network access if this persists.',
    credential_store_failed: 'The account was authorized but its credentials could not be saved locally. Check access to the app’s .local directory.',
    token_exchange_failed: 'Google’s authorization-code exchange failed. Verify the local OAuth configuration, then start a fresh connection.',
    connection_failed: 'The Gmail connection failed. Start a fresh connection from the app.',
    authorization_expired: 'Google authorization expired or was revoked. Reconnect Gmail using your existing client configuration, then review pending messages.',
    token_refresh_failed: 'Gmail authorization could not be checked. Run Check Google connectivity. Reconnect only if authorization still fails after connectivity is restored.',
    oauth_session_expired: 'This login attempt expired or its session did not match. Return to the app and start a fresh Connect Gmail flow. Do not refresh this callback page.',
    connectivity_failed: 'Google did not return the expected response. Check the server’s proxy, firewall and internet connection, then run the check again.',
};
const stages = new Set(['token_exchange', 'token_refresh', 'connectivity', 'identity_verification', 'permission_check', 'credential_store', 'authorization']);
export class OAuthConnectionError extends Error {
    declare code: string; declare stage: string;

    constructor(code: string, stage: string) { super(messages[code] || messages.connection_failed); this.code = Object.hasOwn(messages, code) ? code : 'connection_failed'; this.stage = stages.has(stage) ? stage : 'authorization'; }
}

export function classifyOAuthError(error: unknown, stage: string) {
    if (error instanceof OAuthConnectionError)
        return error;
    const details = record(error), response = record(details.response), googleCode = record(response.data).error;
    if (stage === 'token_refresh' && (googleCode === 'invalid_grant' || response.status === 401))
        return new OAuthConnectionError('authorization_expired', stage);
    if (typeof googleCode === 'string' && Object.hasOwn(messages, googleCode))
        return new OAuthConnectionError(googleCode, stage);
    const codes = [];
    const pending = [error], seen = new Set();
    while (pending.length && seen.size < 20) {
        const value = pending.pop();
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        const item = record(value);
        codes.push(item.code);
        pending.push(item.cause, ...(Array.isArray(item.errors) ? item.errors : []));
    }
    if (codes.some((code: unknown) => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(String(code))))
        return new OAuthConnectionError('certificate_error', stage);
    if (codes.some((code: unknown) => ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED'].includes(String(code))))
        return new OAuthConnectionError('network_error', stage);

    const fallback: Record<string, string> = { connectivity: 'connectivity_failed', token_refresh: 'token_refresh_failed', token_exchange: 'token_exchange_failed', identity_verification: 'identity_verification_failed', permission_check: 'scope_verification_failed', credential_store: 'credential_store_failed' };
    return new OAuthConnectionError(fallback[stage] || 'connection_failed', stage);
}
// Never return raw SDK messages, request URLs/bodies, tokens, or provider descriptions.

export function publicOAuthError(error: unknown) { const safe = classifyOAuthError(error, 'authorization'); return { error: safe.message, code: safe.code, stage: safe.stage, retry: '/app/' }; }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ?  value as Record<string, unknown> : {}; }

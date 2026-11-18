import { publicOAuthError } from './oauth-errors.mjs';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (char: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ char as "\"" | "&" | "<" | ">" | "'"]));

export function oauthErrorPage(error: unknown) {
    const safe = publicOAuthError(error);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gmail connection needs attention</title><link rel="stylesheet" href="/app/styles.css"></head>
    <body class="oauth-error-page"><main><h1>Gmail connection needs attention</h1><p>${escape(safe.error)}</p>
    <p>Return to Connect email and use Check Google connectivity. Once the issue is resolved, start a fresh Connect Gmail flow from the app.</p>
    <p>This attempt did not connect Gmail. No email was sent by this login attempt. Do not refresh this page to retry.</p>
    <p><a href="/app/">Return to Email Outreach</a></p><details><summary>Diagnostic details</summary><p>Code: ${escape(safe.code)}<br>Step: ${escape(safe.stage)}</p></details></main></body></html>`;
}

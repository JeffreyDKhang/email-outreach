import type {AccountsOptions} from './types.js';
import { byId as $, errorMessage } from './dom.mjs';

export function mountAccounts({ api, escape: e, unsavedChanges }: AccountsOptions) {
    const dialog = document.createElement('dialog');
    dialog.id = 'accounts-dialog';
    dialog.innerHTML = `
    <div class="dialog-heading"><h2>Connected email account</h2><button id="close-accounts">Close</button></div>
    <p id="account-state"></p>
    <p id="account-connection-warning" class="warning" role="status" hidden></p>
    <button id="check-google-connectivity">Check Google connectivity</button>
    <p id="google-connectivity-result" role="status"></p>
    <p>Register your own Google web application and enable the Gmail API. Use this exact authorized redirect URI:</p>
    <pre id="google-redirect"></pre>
    <form id="google-config-form">
      <label>Google client ID<input id="google-client-id" autocomplete="off" required></label>
      <label>Google client secret<input id="google-client-secret" type="password" autocomplete="off" required></label>
      <button type="submit">Save OAuth configuration locally</button>
    </form>
    <div class="actions"><button id="connect-gmail" class="primary">Connect Gmail</button><button id="disconnect-gmail">Disconnect Gmail</button></div>
    <p>Disconnecting cancels queued messages. Saved drafts and held Outbox copies are kept.</p>
    <p id="account-message" role="status"></p>
    <p>Sending permission only; reply synchronization is not enabled; additional messages can be composed manually. Outlook is a later adapter.</p>`;
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog, { active: () => dialog.open && !$('google-config-form').hidden,
        read: () => [$('google-client-id').value, $('google-client-secret').value] });
    async function refreshAccount() {
        const result = await api('/api/account');
        const attention = result.connection?.status === 'needs_attention';
        $('account-state').textContent = result.account
            ? attention ? `Connection needs attention: ${result.account.email}` : result.connection?.status === 'unchecked' ? `Saved connection: ${result.account.email}. Authorization has not been checked yet.` : `Connected: ${result.account.email}`
            : result.configured ? 'Google OAuth configured. Connect your Gmail account.'
                : 'No account connected. Configure Google OAuth below.';
        $('google-redirect').textContent = result.redirectUri;
        $('connect-gmail').disabled = !result.configured || !!result.account;
        $('disconnect-gmail').disabled = !result.account;
        $('google-config-form').hidden = !!result.account;
        $('account-connection-warning').hidden = !attention;
        $('account-connection-warning').textContent = attention ? result.connection?.error || 'Connection needs attention.' : '';
        $('accounts').textContent = attention ? 'Connect email - Needs attention' : 'Connect email';
    }
    $('accounts').onclick = async () => {
        unsaved?.reset();
        dialog.showModal();
        $('account-message').textContent = '';
        try {
            await refreshAccount();
        }
        catch (error) {
            $('account-message').textContent = errorMessage(error);
        }
    };
    $('close-accounts').onclick = () => dialog.close();
    $('check-google-connectivity').onclick = async () => {
        const button = $('check-google-connectivity');
        if (button.disabled)
            return;
        button.disabled = true;
        $('google-connectivity-result').textContent = 'Checking the backend’s access to Google. No email will be sent.';
        try {
            const result = await api('/api/google/check', {});
            $('google-connectivity-result').textContent = (result.ok ? 'Google endpoints are reachable. This does not verify your Gmail authorization.' : 'Google connectivity needs attention.') + ' ' + result.checks.map((check: { name: string; reachable: boolean; code?: string; error?: string; }) => check.name + ': ' + (check.reachable ? 'reachable' : check.error)).join(' ') + ' No email was sent.';
            await refreshAccount();
        }
        catch (error) {
            $('google-connectivity-result').textContent = errorMessage(error);
        }
        finally {
            button.disabled = false;
        }
    };
    dialog.addEventListener('close', () => { $('google-client-secret').value = ''; });
    $('google-config-form').onsubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        try {
            const submitted = {
                clientId: $('google-client-id').value,
                clientSecret: $('google-client-secret').value,
            };
            await api('/api/google/config', submitted);
            if ($('google-client-secret').value === submitted.clientSecret)
                $('google-client-secret').value = '';
            unsaved?.reset([submitted.clientId, '']);
            $('account-message').textContent = 'Configuration saved on this machine.';
            await refreshAccount();
        }
        catch (error) {
            $('account-message').textContent = errorMessage(error);
        }
    };
    $('connect-gmail').onclick = async () => {
        try {
            const result = await api('/api/google/connect', {});
            window.location.assign(result.url);
        }
        catch (error) {
            $('account-message').textContent = errorMessage(error);
        }
    };
    $('disconnect-gmail').onclick = async () => {
        try {
            const result = await api('/api/account/disconnect', {});
            $('account-message').textContent = result.notice || 'Account disconnected; queued messages cancelled.';
            await refreshAccount();
        }
        catch (error) {
            $('account-message').textContent = errorMessage(error);
        }
    };
}

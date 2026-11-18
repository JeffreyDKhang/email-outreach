import type {SendingStatusOptions} from './types.js';
import type {SendingState} from '../domain/types.js';
import { byId as $, errorMessage } from './dom.mjs';

export function mountSendingStatus({ api, unsavedChanges }: SendingStatusOptions) {

    let snapshot: SendingState | null = null;
    let offset = 0, refreshing = false, unavailable = false, savedDelay = '0';
    $('sending-controls').innerHTML = '<h3>Sending pace</h3><form id="sending-settings-form"><label>Seconds between requests<input id="send-delay" type="number" min="0" max="3600" step="1" value="0" required></label><p>0 = send promptly, one request at a time. An optional delay applies to pending messages. Pacing does not guarantee inbox placement.</p><button type="submit">Save sending pace</button></form><p id="sending-settings-message" role="status"></p><p id="sending-pause-reason"></p><button id="resume-sending" hidden>Resume pending messages</button><p>Resuming does not retry failed or unknown messages. Check Gmail Sent first.</p>';
    unsavedChanges?.register(() => $('outbox-dialog').open && $('send-delay').value !== savedDelay);
    function draw() {
        const card = $('app-allowance');
        const attention = snapshot?.connection?.status === 'needs_attention';
        $('accounts').textContent = attention ? 'Connect email - Needs attention' : 'Connect email';
        const connectionWarning = attention ? 'Gmail connection needs attention. ' + snapshot?.connection?.error + ' Open Connect email. ' : '';
        if (unavailable) {
            card.textContent = 'App allowance unavailable. Check that the local server is running.';
            $('queue-allowance').textContent = card.textContent;
            return;
        }
        if (!snapshot?.allowance) {
            card.textContent = connectionWarning + 'App allowance: connect Gmail to view usage.';
            $('queue-allowance').textContent = card.textContent;
            $('sending-pause-reason').textContent = '';
            $('resume-sending').hidden = true;
            return;
        }
        const a = snapshot.allowance, now = Date.now() + offset;
        let countdown = '';
        if (a.nextReleaseAt) {
            const seconds = Math.max(0, Math.ceil((Date.parse(a.nextReleaseAt) - now) / 1000)), h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
            countdown = seconds ? `Next slot returns in ${h}h ${m}m ${s}s.` : 'Refreshing available slots...';
        }
        else if (a.reserved)
            countdown = 'Queued messages reserve slots; their 24-hour window starts when attempted.';
        card.textContent = connectionWarning + `App allowance: ${a.used} / ${a.limit} used or reserved. ${a.remaining} remaining. ${countdown}${snapshot.paused ? ' Sending paused.' : ''}`;
        $('queue-allowance').textContent = card.textContent;
        $('sending-pause-reason').textContent = snapshot.paused?.reason || '';
        $('resume-sending').hidden = !snapshot.paused;
    }
    async function refresh() {
        if (refreshing)
            return;
        refreshing = true;
        try {
            snapshot = await api('/api/sending');
            unavailable = false;
            offset = Date.parse(snapshot.serverTime) - Date.now();
            draw();
        }
        catch {
            unavailable = true;
            draw();
        }
        finally {
            refreshing = false;
        }
    }
    $('sending-settings-form').onsubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        try {
            const delaySeconds = Number($('send-delay').value);
            await api('/api/sending/settings', { delaySeconds });
            savedDelay = String(delaySeconds);
            $('sending-settings-message').textContent = 'Sending pace saved for pending messages.';
            await refresh();
        }
        catch (error) {
            $('sending-settings-message').textContent = errorMessage(error);
        }
    };
    $('resume-sending').onclick = async () => { try {
        await api('/api/sending/resume', {});
        await refresh();
    }
    catch (error) {
        $('sending-settings-message').textContent = errorMessage(error);
    } };
    $('outbox-dialog').addEventListener('close', () => { $('sending-settings-message').textContent = ''; });
    // Poll server time/usage; render the countdown each second without sending requests.
    refresh();
    setInterval(refresh, 5000);
    setInterval(draw, 1000);
    return { async open() { const previous = $('send-delay').value; await refresh(); if (snapshot) {
            savedDelay = String(snapshot.settings.delaySeconds);
            if ($('send-delay').value === previous)
                $('send-delay').value = savedDelay;
        } } };
}

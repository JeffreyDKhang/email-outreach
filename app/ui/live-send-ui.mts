import type {LiveSendOptions} from './types.js';
import type {DeliveryPayload, Lead, PostApi, SendPreview} from '../domain/types.js';
import { byId as $, errorMessage } from './dom.mjs';
import { markBatchQueued } from '../application/queue-sync.mjs';
import { selectedDraftOnly } from '../domain/draft-state.mjs';

export function mountLiveSend({ api, getLeads, getRules, getDataset, save, escape: e }: LiveSendOptions) {
    const dialog = document.createElement('dialog');

    let preview: SendPreview | null = null;

    let onSent: (() => unknown | Promise<unknown>) | null | undefined;
    dialog.id = 'real-send-dialog';
    dialog.innerHTML = '<div class="dialog-heading"><h2>Review real Gmail delivery</h2><button id="close-real-send">Close</button></div><div id="real-send-content"></div><button id="confirm-real-send" class="primary">Send real emails</button><p id="real-send-message" role="status"></p>';
    document.body.append(dialog);
    $('close-real-send').onclick = () => { preview = null; dialog.close(); };
    $('confirm-real-send').onclick = async () => {
        if (!preview)
            return;
        $('confirm-real-send').disabled = true;
        try {
            const batch = preview;
            await api('/api/live/enqueue', { id: batch.id, digest: batch.digest });
            preview = null;
            if (!await save(markBatchQueued(getLeads(), batch.items)))
                throw Error('Messages are queued, but workspace tracking could not be saved.');
            if (onSent)
                await onSent();
            $('real-send-message').textContent = 'Messages queued for real delivery. Open Sending Queue/History to view progress.';
        }
        catch (error) {
            $('real-send-message').textContent = errorMessage(error) + ' Check Sending Queue/History before trying again.';
        }
    };

    async function showPreview<P extends "/api/outbox/preview" | "/api/instant/preview">(path: P, value: PostApi[P]["request"], refresh: (() => unknown | Promise<unknown>) | null | undefined, instant: boolean | undefined = false) {
        onSent = refresh;
        preview = null;
        $('confirm-real-send').disabled = true;
        $('real-send-content').textContent = 'Checking sender and messages...';
        $('real-send-message').textContent = '';
        dialog.showModal();
        try {
            preview = await api(path, value);
            const sending = await api('/api/sending');
            $('real-send-content').innerHTML = `<p><strong>${instant ? 'INSTANT SEND: bypasses Outbox holding. Confirming starts real delivery.' : 'REAL EMAIL:'} ${preview.items.length} messages from ${e(preview.items[0].sender)}</strong></p><p>Multiple messages to the same recipient are allowed. Check each variation before sending.</p><p>Pacing: ${sending.settings.delaySeconds === 0 ? 'send promptly, sequentially' : e(sending.settings.delaySeconds) + ' seconds between requests'}. App allowance: ${sending.allowance?.remaining ?? 0} slots available. Adjust pace in Outbox.</p><p>Clicking Send real emails queues these exact messages. The local backend starts sending while running; this is not an inbox delivery-time guarantee.</p>${preview.items.map((item: DeliveryPayload) => `<article class="score-card"><p>To: ${e(item.recipient)} &middot; draft v${item.version}</p><strong>${e(item.subject)}</strong><pre>${e(item.body)}</pre></article>`).join('')}`;
            $('confirm-real-send').disabled = false;
        }
        catch (error) {
            preview = null;
            $('real-send-message').textContent = errorMessage(error);
        }
    }
    return {

        open(ids: string[], refresh?: (() => unknown | Promise<unknown>) | null | undefined) { return showPreview('/api/outbox/preview', { ids }, refresh); },

        openInstant(leads: Lead[]) {
            const dataset = getDataset();
            if (!dataset)
                throw Error('Choose a dataset first.');
            return showPreview('/api/instant/preview', { requestId: crypto.randomUUID(), datasetId: dataset.id, datasetName: dataset.name, leads: leads.map(selectedDraftOnly), rules: dataset.rules }, null, true);
        },
    };
}

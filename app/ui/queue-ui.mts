import type {QueueOptions} from './types.js';
import type {DeliveryJob} from '../domain/types.js';
import { byId as $, errorMessage } from './dom.mjs';

export function mountQueue({ api, queueSync, escape: e }: QueueOptions) {
    const dialog = document.createElement('dialog');

    let historyIds: string[] = [];
    let busy = false, requestVersion = 0;
    dialog.id = 'live-jobs-dialog';
    dialog.innerHTML = `
    <div class="dialog-heading"><h2>Sending Queue/History</h2><button id="close-live-jobs">Close</button></div>

    <p>This app counts only its own messages across datasets, not mail sent elsewhere. This is not Gmail's remaining quota. Failed, unknown and cancelled jobs count conservatively for their window; pending jobs reserve slots.</p>

    <p>Accepted means Gmail accepted the message, not confirmed delivery. Unknown outcomes require checking Gmail Sent. Failed or unknown sends are never retried automatically.</p>
    <div class="actions"><button id="refresh-live-jobs">Refresh status</button><button id="cancel-live-jobs">Cancel queued messages</button></div>
    <p id="live-jobs-message" role="status"></p>
    <div id="live-jobs-content"></div>`;
    document.body.append(dialog);

    function jobHTML(job: DeliveryJob) {
        return `<article class="score-card">
      <h3>${e(job.recipient)}</h3><p>Batch: ${e(job.payload.batchName || 'No named batch')}</p>
      <p>From: ${e(job.payload.sender)} &middot; ${e(job.status)} &middot; ${e(new Date(job.updated).toLocaleString())}</p>
      <strong>${e(job.payload.subject)}</strong><pre>${e(job.payload.body)}</pre>
      ${job.result?.error ? `<p class="warning">${e(job.result.error)}</p>` : ''}
      ${job.result?.messageId ? `<p>Gmail ID: ${e(job.result.messageId)}</p>` : ''}
    </article>`;
    }
    async function showJobs(operation: () => Promise<DeliveryJob[]> = queueSync.refresh) {
        const version = ++requestVersion;
        try {
            const jobs = await operation();
            if (version !== requestVersion)
                return false;
            const current = jobs.filter((job: DeliveryJob) => ['queued', 'sending'].includes(job.status)), history = jobs.filter((job: DeliveryJob) => !['queued', 'sending'].includes(job.status) && !job.history_cleared_at);
            historyIds = history.map((job: DeliveryJob) => job.id);
            $('live-jobs-content').innerHTML = '<h3>Current queue</h3>' + (current.length ? current.map(jobHTML).join('') : '<p>No messages currently sending or queued.</p>') + '<div class="actions"><h3>History</h3><button id="clear-live-history" class="danger" ' + (busy || !historyIds.length ? 'disabled' : '') + '>Clear history</button></div>' + (history.length ? history.map(jobHTML).join('') : '<p>No delivery history to show.</p>');
            $('clear-live-history').onclick = clearHistory;
            return true;
        }
        catch (error) {
            if (version === requestVersion)
                $('live-jobs-message').textContent = errorMessage(error);
            return false;
        }
    }
    async function clearHistory() {
        if (busy || !historyIds.length)
            return;
        const ids = [...historyIds];
        if (!confirm(`Clear ${ids.length} completed history record(s) from this view? This cannot be undone in the app. Current queued/sending messages, saved drafts and Gmail emails are kept. Sending limits and duplicate-send protection still apply. Check Gmail Sent for any Unknown outcomes before clearing.`))
            return;
        busy = true;
        $('clear-live-history').disabled = true;
        $('refresh-live-jobs').disabled = true;
        $('cancel-live-jobs').disabled = true;
        try {
            if (await showJobs(() => queueSync.clearHistory(ids)))
                $('live-jobs-message').textContent = 'Completed history cleared. Current queued and sending messages are unchanged.';
        }
        finally {
            busy = false;
            $('refresh-live-jobs').disabled = false;
            $('cancel-live-jobs').disabled = false;
            if ($('clear-live-history'))
                $('clear-live-history').disabled = !historyIds.length;
        }
    }
    $('live-jobs').onclick = () => {
        dialog.showModal();
        $('live-jobs-message').textContent = '';
        return showJobs();
    };
    setInterval(() => { if (dialog.open && !busy)
        showJobs(); }, 3000);
    $('refresh-live-jobs').onclick = () => showJobs();
    $('cancel-live-jobs').onclick = () => showJobs(queueSync.cancel);
    $('close-live-jobs').onclick = () => dialog.close();
}

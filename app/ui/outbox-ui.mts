import type {OutboxOptions} from './types.js';
import type {Dataset, Operator, OutboxFilter, OutboxMessage} from '../domain/types.js';
import type {ElementTags} from './elements.js';
import { query } from './dom.mjs';
import { ancestor } from './dom.mjs';
import { closest } from './dom.mjs';
import { byId as $, errorMessage, eventElement, eventControl } from './dom.mjs';
import { outboxFields, outboxValue, filterOutbox, outboxFieldType, outboxFilterError, outboxChoiceField, outboxFilterChoices, outboxForDataset, heldBatches } from '../domain/outbox-filters.mjs';
import { allowedOperators } from '../domain/column-types.mjs';
import { mountSendingStatus } from './sending-status-ui.mjs';

export function mountOutbox({ unsavedChanges, api, liveSender, getDataset = () => null, escape: e, statusFactory = mountSendingStatus }: OutboxOptions) {

    let messages: OutboxMessage[] = [];

    let selected: Set<string> = new Set();

    let filters: (OutboxFilter & { operator: import("../domain/types.js").Operator; })[] = [];
    let busy = false;

    let dataset: Dataset | null | undefined = null;
    const getDatasets = () => dataset ? [dataset] : [];
    const dialog = document.createElement('dialog');
    dialog.id = 'outbox-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><h2 id="outbox-title">Outbox</h2><button id="close-outbox">Close</button></div>
    <p>Messages here are on hold. Adding a message or creating a batch never sends it. Each entry is a frozen copy; later lead edits do not change it.</p>
    <p id="queue-allowance" role="status"></p><div id="sending-controls"></div>
    <section class="outbox-filters-panel" aria-labelledby="outbox-filters-heading"><h3 id="outbox-filters-heading">Filters</h3>
    <details class="outbox-filter-section" open><summary>Message filters</summary><div class="outbox-filter-body">
      <p>Search the saved Subject or Message text, or choose an existing Template, Segment or Batch. These fields describe the Outbox message copy.</p>
      <div id="outbox-message-filters"></div><div class="actions outbox-filter-actions"><button id="add-outbox-message-filter">Add message filter</button><button id="clear-outbox-message-filters">Clear message filters</button></div></div></details>
    <details class="outbox-filter-section"><summary>CSV filters</summary><div class="outbox-filter-body">
      <p>Filter the CSV values saved with each message. Every condition in both filter sections must match.</p>
      <div id="outbox-filters"></div><div class="actions outbox-filter-actions"><button id="add-outbox-filter">Add CSV filter</button><button id="clear-outbox-filters">Clear CSV filters</button></div></div></details></section>
    <section class="outbox-message-section" aria-labelledby="outbox-messages-heading">
      <div class="outbox-section-heading"><h3 id="outbox-messages-heading">Messages</h3><span id="outbox-message-count" role="status"></span></div>
      <div class="outbox-message-toolbar"><label id="outbox-batch-selector" hidden>Held batch<select id="outbox-batch-filter"></select></label><div class="actions"><button id="outbox-select-visible">Select visible messages</button><button id="outbox-clear-selection">Clear selection</button><button id="outbox-refresh">Refresh Outbox</button></div></div>
      <section class="outbox-selection-panel" aria-labelledby="outbox-selection-heading">
        <h3 id="outbox-selection-heading">Selected messages <span id="outbox-selection-count">(0)</span></h3>
        <div class="outbox-batch-tools"><div class="outbox-batch-row"><label>New batch name<input id="outbox-batch-name" maxlength="100" placeholder="e.g. Tuesday outreach" aria-describedby="outbox-batch-hint"></label><button id="outbox-create-batch">Create a batch</button></div><p id="outbox-batch-hint"></p></div>
        <div class="outbox-delivery-actions"><button id="outbox-send-selected" class="primary">Review selected send</button><button id="outbox-remove" class="danger">Remove selected</button></div>
      </section>
      <p id="outbox-notice" role="status"></p><div id="outbox-messages"></div>
    </section>`;
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog, { selector: '#outbox-batch-name' });
    const sendingStatus = statusFactory({ api, unsavedChanges });
    const held = () => messages.filter((message: OutboxMessage) => message.status === 'held');
    function visible() { return filterOutbox(held(), filters, getDatasets()).filter((message: OutboxMessage) => !$('outbox-batch-filter').value || message.batch_id === $('outbox-batch-filter').value); }

    const conditionLabels: Record<string, string> = { equals: 'Equals', not_equals: 'Does not equal', contains: 'Contains', in: 'Is one of (comma separated)', gte: 'At least', lte: 'At most', between: 'Between', present: 'Has a value', missing: 'Is blank' };
    function drawFilters() {
        const allFields = outboxFields(held(), getDatasets());
        $('add-outbox-filter').disabled = !allFields.some((field: { group: string; key: string; label: string; }) => field.group === 'source');
        for (const group of ['message', 'source']) {
            const fields = allFields.filter((field: { group: string; key: string; label: string; }) => field.group === group);
            $(group === 'message' ? 'outbox-message-filters' : 'outbox-filters').innerHTML = filters.map((filter: OutboxFilter & { operator: import("../domain/types.js").Operator; }, index: number) => {
                if ((filter.key.startsWith('source:') ? 'source' : 'message') !== group)
                    return '';
                const type = outboxFieldType(held(), filter.key, getDatasets()), operators = allowedOperators(type);
                const incompatible = !operators.includes(filter.operator);
                if (incompatible)
                    operators.push(filter.operator);
                const numeric = ['gte', 'lte', 'between'].includes(filter.operator);
                const choices = outboxChoiceField(filter.key) ? outboxFilterChoices(held(), filter.key, getDatasets()) : null;
                return `<div class="condition" data-filter-index="${index}"><label>${group === 'message' ? 'Message field' : 'CSV column'}<select data-outbox-filter="key">${fields.map((field: { group: string; key: string; label: string; }) => `<option value="${e(field.key)}" ${field.key === filter.key ? 'selected' : ''}>${e(field.label)}</option>`).join('')}${fields.some((field: { group: string; key: string; label: string; }) => field.key === filter.key) ? '' : `<option value="${e(filter.key)}" selected>${e(filter.key)} (unavailable)</option>`}</select></label>
          ${choices ? `<label>Select ${e(fields.find((field: { group: string; key: string; label: string; }) => field.key === filter.key)?.label || 'option')}<select data-outbox-filter="choice"><option value="" ${filter.value === undefined ? 'selected' : ''}>Choose an option</option>${choices.map((choice: { value: string; label: string; }) => `<option value="${e(JSON.stringify(choice.value))}" ${choice.value === filter.value ? 'selected' : ''}>${e(choice.label)}</option>`).join('')}${filter.value !== undefined && !choices.some((choice: { value: string; label: string; }) => choice.value === filter.value) ? `<option value="${e(JSON.stringify(filter.value))}" selected>${e(filter.value || 'Empty')} (unavailable)</option>` : ''}</select></label>` : `
          <label>Condition<select data-outbox-filter="operator">${operators.map((operator: string) => `<option value="${operator}" ${operator === filter.operator ? 'selected' : ''}>${conditionLabels[operator]}${incompatible && operator === filter.operator ? ' (incompatible)' : ''}</option>`).join('')}</select></label>
          ${['present', 'missing'].includes(filter.operator) ? '' : `<label>${filter.operator === 'between' ? 'Lower bound' : filter.operator === 'in' ? 'Values (comma separated)' : 'Value'}<input data-outbox-filter="value" type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="any"' : ''} value="${e(filter.value ?? '')}"></label>`}
          ${filter.operator === 'between' ? `<label>Upper bound<input data-outbox-filter="to" type="number" step="any" value="${e(filter.to ?? '')}"></label>` : ''}`}
          <button data-remove-filter="${index}">Remove condition</button><p data-filter-error role="alert">${e(outboxFilterError(filter, held(), getDatasets()))}</p></div>`;
            }).join('');
        }
    }
    function draw() {
        const rows = visible(), currentIds = new Set(rows.map((message: OutboxMessage) => message.id));
        selected = new Set([...selected].filter((id: string) => currentIds.has(id)));
        $('outbox-message-count').textContent = `${rows.length} of ${held().length} held messages`;
        $('outbox-selection-count').textContent = `(${selected.size})`;
        $('outbox-messages').innerHTML = rows.length ? rows.map((message: OutboxMessage) => `<article class="score-card"><label><input type="checkbox" data-outbox-select="${e(message.id)}" ${selected.has(message.id) ? 'checked' : ''}> Select message to ${e(message.payload.recipient)}</label>
      <p>${e(message.payload.datasetName)} &middot; ${e(message.payload.templateName)} &middot; ${e(message.batch_name || 'No batch')} &middot; Held since ${e(new Date(message.created).toLocaleString())}</p>
      <strong>${e(message.payload.subject)}</strong><pre>${e(message.payload.body)}</pre><details><summary>Snapshot variables</summary><dl>${outboxFields([message]).map((field: { group: string; key: string; label: string; }) => `<dt>${e(field.label)}</dt><dd>${e(outboxValue(message, field.key))}</dd>`).join('')}</dl></details></article>`).join('') : `<div class="outbox-empty-state"><h4>${busy && !held().length ? 'Loading messages…' : held().length ? 'No messages match these filters' : 'No messages in Outbox'}</h4><p>${busy && !held().length ? 'Checking the held messages for this dataset.' : held().length ? 'Adjust your filters or choose another held batch.' : 'Open a lead’s Review Message and choose Send to Outbox.'}</p></div>`;
        $('outbox-send-selected').textContent = `Review selected send (${selected.size})`;
        for (const id of  ['outbox-create-batch', 'outbox-send-selected', 'outbox-remove'] as const)
            $(id).disabled = busy || !selected.size;
    }
    async function refresh() {
        const { messages: next } = await api('/api/outbox');
        messages = outboxForDataset(next, dataset?.id);
        const batch = $('outbox-batch-filter').value;
        const batches = heldBatches(messages);
        $('outbox-batch-filter').innerHTML = '<option value="">All held messages</option>' + batches.map((batch: { id: string; name: string | null | undefined; count: number; }) => `<option value="${e(batch.id)}">${e(batch.name)} (${batch.count})</option>`).join('');
        $('outbox-batch-filter').value = batches.some((value: { id: string; name: string | null | undefined; count: number; }) => value.id === batch) ? batch : '';
        $('outbox-batch-selector').hidden = !batches.length;
        $('outbox-batch-hint').textContent = batches.length ? 'Creating a batch groups the selected messages and keeps them on hold.' : 'No held batches yet. Select messages and enter a name to create one. Messages stay on hold.';
        drawFilters();
        draw();
    }

    async function action(work: () => unknown | Promise<unknown>) { if (busy)
        return; busy = true; draw(); try {
        await work();
    }
    catch (error) {
        $('outbox-notice').textContent = errorMessage(error);
    }
    finally {
        busy = false;
        draw();
    } }
    $('outbox').onclick = () => {
        const nextDataset = getDataset();
        if (nextDataset?.id !== dataset?.id) {
            messages = [];
            filters = [];
            selected.clear();
            $('outbox-batch-filter').value = '';
            $('outbox-batch-filter').innerHTML = '';
            $('outbox-batch-selector').hidden = true;
            $('outbox-batch-hint').textContent = '';
            $('outbox-batch-name').value = '';
            $('outbox-notice').textContent = '';
        }
        dataset = nextDataset;
        $('outbox-title').textContent = dataset ? `Outbox: ${dataset.name}` : 'Outbox';
        drawFilters();
        draw();
        unsaved?.reset();
        dialog.showModal();
        sendingStatus.open();
        action(refresh);
    };
    $('close-outbox').onclick = () => dialog.close();
    $('outbox-refresh').onclick = () => action(refresh);

    function bindFilters(containerId: keyof ElementTags, addId: "add-outbox-filter" | "add-outbox-message-filter", clearId: "clear-outbox-filters" | "clear-outbox-message-filters", group: "source" | "message") {
        $(addId).onclick = () => {
            const field = outboxFields(held(), getDatasets()).find((field: { group: string; key: string; label: string; }) => field.group === group);
            if (!field)
                return;
            filters.push({ key: field.key, operator: 'contains', value: '' });
            drawFilters();
            draw();
        };
        $(clearId).onclick = () => { filters = filters.filter((filter: OutboxFilter & { operator: import("../domain/types.js").Operator; }) => (filter.key.startsWith('source:') ? 'source' : 'message') !== group); drawFilters(); draw(); };
        $(containerId).oninput = (event: InputEvent) => {
            const field = eventElement(event).dataset.outboxFilter;
            if (eventElement(event).tagName !== 'INPUT' || !field)
                return;
            const row = ancestor(eventElement(event), '[data-filter-index]'), filter = filters[Number(row.dataset.filterIndex)];
            if (field === 'operator')
                filter.operator =  eventControl(event).value as Operator;
            else if (field === 'key' || field === 'value' || field === 'to')
                filter[field] = eventControl(event).value;
            query(row, '[data-filter-error]').textContent = outboxFilterError(filter, held(), getDatasets());
            draw();
        };
        $(containerId).onchange = (event: Event) => {
            const field = eventElement(event).dataset.outboxFilter;
            if (eventElement(event).tagName !== 'SELECT' || !field)
                return;
            const row = ancestor(eventElement(event), '[data-filter-index]');
            const filter = filters[Number(row.dataset.filterIndex)];
            if (field === 'choice') {
                // JSON distinguishes the placeholder from an explicit No batch/segment choice.
                filter.value = eventControl(event).value === '' ? undefined : JSON.parse(eventControl(event).value);
            }
            else if (field === 'key' && filter.key !== eventControl(event).value) {
                const previousKey = filter.key;
                filter.key = eventControl(event).value;
                if (outboxChoiceField(filter.key)) {
                    filter.operator = 'equals';
                    delete filter.value;
                    delete filter.to;
                }
                else if (outboxChoiceField(previousKey)) {
                    filter.operator = 'contains';
                    filter.value = '';
                    delete filter.to;
                }
            }
            else if (field === 'operator')
                filter.operator =  eventControl(event).value as Operator;
            else if (field === 'key' || field === 'value' || field === 'to')
                filter[field] = eventControl(event).value;
            drawFilters();
            draw();
        };
        $(containerId).onclick = (event: PointerEvent) => { const button = closest(eventElement(event), '[data-remove-filter]'); if (button) {
            filters.splice(Number(button.dataset.removeFilter), 1);
            drawFilters();
            draw();
        } };
    }
    bindFilters('outbox-message-filters', 'add-outbox-message-filter', 'clear-outbox-message-filters', 'message');
    bindFilters('outbox-filters', 'add-outbox-filter', 'clear-outbox-filters', 'source');
    $('outbox-batch-filter').onchange = () => { selected.clear(); draw(); };
    $('outbox-messages').onchange = (event: Event) => { const id = eventElement(event).dataset.outboxSelect; if (!id)
        return;   (eventElement(event) as HTMLInputElement).checked ? selected.add(id) : selected.delete(id); draw(); };
    $('outbox-select-visible').onclick = () => { selected = new Set(visible().map((message: OutboxMessage) => message.id)); draw(); };
    $('outbox-clear-selection').onclick = () => { selected.clear(); draw(); };
    $('outbox-create-batch').onclick = () => action(async () => {
        const name = $('outbox-batch-name').value.trim();
        if (!name)
            throw Error('Enter a batch name first.');
        await api('/api/outbox/batch', { ids: [...selected], name });
        if ($('outbox-batch-name').value.trim() === name) {
            $('outbox-batch-name').value = '';
            unsaved?.reset();
        }
        $('outbox-notice').textContent = 'Batch created. Its messages remain on hold.';
        await refresh();
    });
    $('outbox-remove').onclick = () => { if (confirm('Remove the selected held message copies from Outbox? Your lead drafts are kept.'))
        action(async () => { await api('/api/outbox/remove', { ids: [...selected] }); await refresh(); }); };
    $('outbox-send-selected').onclick = () => liveSender.open([...selected], refresh);
}

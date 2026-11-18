import type {Column, ColumnType, Dataset, Lead, MessageSnapshot, OutboxFilter, OutboxMessage} from './types.js';
import { datasetColumns, sourceValue } from './lead-schema.mjs';
import { allowedOperators, columnType, inferColumnType } from './column-types.mjs';
import { conditionMatches, genericDefaults, validateRules } from './scoring.mjs';
import { manualTemplate, templateNames } from './outreach.mjs';

export const outboxChoiceField = (key: string): key is "segment" | "templateName" | "batch_name" => ['templateName', 'segment', 'batch_name'].includes(key);

export function outboxForDataset(messages: OutboxMessage[], datasetId: string | null | undefined) {
    return typeof datasetId === 'string' && datasetId
        ? messages.filter((message: OutboxMessage) => message.payload.datasetId === datasetId) : [];
}
// Include configured names and historical names stored on immutable message copies.

export function outboxFilterChoices(messages: OutboxMessage[], key: string, datasets: Dataset[] | undefined = []) {
    if (!outboxChoiceField(key))
        return [];
    const values = new Set(messages.map((message: OutboxMessage) => outboxValue(message, key)));
    if (key === 'templateName') {
        values.add('General');
        for (const dataset of datasets)
            for (const name of templateNames(dataset.templates || {}))
                values.add(name);
    }
    else if (key === 'segment') {
        values.add('General');
        for (const dataset of datasets)
            for (const segment of dataset.rules?.segments || [])
                values.add(segment.name);
    }
    else
        values.add('');
    const emptyLabels = { templateName: 'No template', segment: 'No segment', batch_name: 'No batch' };
    return [...values].sort((a: string, b: string) => a.localeCompare(b)).map((value: string) => ({ value,
        label: value === manualTemplate && key === 'templateName' ? 'Manually from scratch' : value || emptyLabels[key] }));
}
// Schema discovery includes empty datasets and historical snapshot-only columns.

export function outboxFields(messages: OutboxMessage[], datasets: Dataset[] | undefined = []) {
    const fields = [{ key: 'subject', label: 'Subject' }, { key: 'body', label: 'Message' },
        { key: 'templateName', label: 'Template' }, { key: 'segment', label: 'Segment' },
        { key: 'batch_name', label: 'Batch' }].map((field: { key: string; label: string; }) => ({ ...field, group: 'message' }));
    const labels = new Set([...datasets.flatMap((dataset: Dataset) => datasetColumns(dataset).map((column: Column) => column.label)),
        ...messages.flatMap((message: OutboxMessage) => Object.keys(message.payload.source || {}))]);
    for (const label of labels)
        fields.push({ key: 'source:' + label, label: 'CSV: ' + label, group: 'source' });
    return fields;
}

export function outboxValue(message: OutboxMessage, key: string) {
    return String(key.startsWith('source:') ? message.payload.source?.[key.slice(7)] ?? '' : key === 'batch_name' ? message.batch_name || '' : message.payload[ key as keyof MessageSnapshot] ?? '');
}

export function outboxFieldType(messages: OutboxMessage[], key: string, datasets: Dataset[] | undefined = []): ColumnType {
    if (!key.startsWith('source:'))
        return 'text';

    const values: unknown[] = messages.map((message: OutboxMessage) => outboxValue(message, key));
    const label = key.slice(7), types = [];
    let explicit = false;
    for (const dataset of datasets) {
        const column = datasetColumns(dataset).find((column: Column) => column.label === label);
        if (!column)
            continue;
        const overrides = dataset.rules?.columnTypes || {};
        explicit ||= Object.hasOwn(overrides, column.key);
        types.push(columnType(dataset.leads || [], column.key, overrides));
        values.push(...(dataset.leads || []).map((lead: Lead) => sourceValue(lead, column.key)));
    }
    // Conflicting schemas stay conservative; a filter must make sense across lists.
    return explicit ? (types.every((type: string) => type === 'number') ? 'number' : 'text') : inferColumnType(values);
}

export function outboxFilterError(filter: OutboxFilter, messages: OutboxMessage[], datasets: Dataset[] | undefined = []) {
    if (!outboxFields(messages, datasets).some((field: { group: string; key: string; label: string; }) => field.key === filter.key))
        return 'Choose an available field.';
    if (outboxChoiceField(filter.key))
        return outboxFilterChoices(messages, filter.key, datasets).some((choice: { value: string; label: string; }) => choice.value === filter.value) ? '' : 'Choose an available option.';
    const operator = filter.operator || 'contains';
    if (!allowedOperators(outboxFieldType(messages, filter.key, datasets)).includes(operator))
        return 'Choose a condition compatible with this field type.';
    try {
        validateRules({ ...genericDefaults, medium: 1, high: 2, eligibility: [{ ...filter, field: filter.key, operator }] });
        return '';
    }
    catch (error) {
        return error instanceof Error ? error.message : 'Invalid filter.';
    }
}

export function filterOutbox(messages: OutboxMessage[], filters: OutboxFilter[], datasets: Dataset[] | undefined = []) {
    if (filters.some((filter: OutboxFilter) => outboxFilterError(filter, messages, datasets)))
        return [];
    return messages.filter((message: OutboxMessage) => filters.every((filter: OutboxFilter) => outboxChoiceField(filter.key)
        ? outboxValue(message, filter.key) === filter.value
        : conditionMatches(outboxValue(message, filter.key), { ...filter, operator: filter.operator || 'contains' })));
}

export function heldBatches(messages: OutboxMessage[]) {

    const batches: Map<string, { id: string; name: string | null | undefined; count: number; }> = new Map();
    for (const message of messages) {
        if (message.status !== 'held' || !message.batch_id)
            continue;
        const batch = batches.get(message.batch_id) || { id: message.batch_id, name: message.batch_name, count: 0 };
        batch.count++;
        batches.set(batch.id, batch);
    }
    return [...batches.values()];
}

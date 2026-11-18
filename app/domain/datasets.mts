import type {Column, Dataset, Lead, Rules, Templates, Workspace} from './types.js';
import { genericDefaults, validateRules } from './scoring.mjs';
import { templates, validateTemplates } from './outreach.mjs';

export const emptyWorkspace: Workspace = { version: 1, activeId: null, datasets: [] };
export const defaultTemplates = { General: templates.General };

export function datasetName(value: unknown) {
    const name = String(value ?? '').trim();
    if (!name || name.length > 100)
        throw Error('Enter a dataset name between 1 and 100 characters.');
    return name;
}

export function createDataset(name: string, leads: Lead[], sourceName: string | undefined = ''): Dataset {
    return { id: crypto.randomUUID(), name: datasetName(name), sourceName, leads: structuredClone(leads),
        rules: structuredClone(genericDefaults), templates: structuredClone(defaultTemplates) };
}

export function validateWorkspace(input: unknown): Workspace {
    const value =  input as Workspace;
    if (value?.version !== 1 || !Array.isArray(value.datasets))
        throw Error('Invalid saved workspace.');

    const ids: Set<string> = new Set();
    for (const dataset of value.datasets) {
        if (!dataset || typeof dataset.id !== 'string' || !dataset.id || ids.has(dataset.id))
            throw Error('Invalid dataset ID.');
        ids.add(dataset.id);
        datasetName(dataset.name);
        if (dataset.columns !== undefined) {
            if (!Array.isArray(dataset.columns) || dataset.columns.some((column: Column) => !column || typeof column.key !== 'string' || typeof column.label !== 'string' || !column.label.trim()) || new Set(dataset.columns.map((column: Column) => column.key)).size !== dataset.columns.length || new Set(dataset.columns.map((column: Column) => column.label)).size !== dataset.columns.length)
                throw Error('Invalid dataset columns.');
            if (typeof dataset.native !== 'boolean' || typeof dataset.recipientKey !== 'string' || !dataset.columns.some((column: Column) => column.key === dataset.recipientKey))
                throw Error('Invalid dataset recipient column.');
        }
        if (!Array.isArray(dataset.leads) || dataset.leads.some((lead: Lead) => !lead || typeof lead.lead_id !== 'string' || typeof lead.company !== 'string'))
            throw Error('Invalid dataset leads.');
        validateRules(dataset.rules);
        validateTemplates(dataset.templates);
    }
    if (value.datasets.length ? value.activeId === null || !ids.has(value.activeId) : value.activeId !== null)
        throw Error('Invalid active dataset.');
    return value;
}
// Earlier storage did not record import boundaries. Recover separate source layouts
// without dropping historical drafts, IDs, approvals, or delivery snapshots.

export function migrateWorkspace(leads: Lead[], rules: Rules, savedTemplates: Templates) {

    const groups: Map<string, Lead[]> = new Map();
    for (const lead of leads) {
        const key = lead.values ? JSON.stringify([Object.keys(lead.values), lead.recipient_column]) : 'legacy';
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key)?.push(lead);
    }
    const datasets = [...groups].map(([key, rows]: [string, Lead[]], index: number) => {
        const dataset = createDataset(key === 'legacy' ? 'Previous leads' : `Imported CSV ${index + 1}`, rows);
        if (key === 'legacy' || rules.version === 2)
            dataset.rules = structuredClone(rules);
        // Retain user templates, including any historical company-specific copy.
        dataset.templates = structuredClone(savedTemplates);
        return dataset;
    });
    return validateWorkspace({ version: 1, activeId: datasets[0]?.id ?? null, datasets });
}

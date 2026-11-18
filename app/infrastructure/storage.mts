import type {Lead, Rules, Templates, Workspace} from '../domain/types.js';
import { defaults, validateRules } from '../domain/scoring.mjs';
import { templates, validateTemplates } from '../domain/outreach.mjs';
import { emptyWorkspace, migrateWorkspace, validateWorkspace } from '../domain/datasets.mjs';
export const storageKeys = {
    workspace: 'email-outreach.workspace.v1',
    leads: 'officepantry.leads.v1',
    rules: 'officepantry.rules.v1',
    templates: 'officepantry.templates.v1',
};
// The injected Storage interface keeps browser persistence replaceable and testable.
// Failures propagate so the caller can display a notice without discarding saved data.

export function createStorageRepository(storage: Pick<Storage, "getItem" | "setItem"> | undefined = {
    getItem: (key: string) => globalThis.localStorage.getItem(key),
    setItem: (key: string, value: string) => globalThis.localStorage.setItem(key, value),
}) {

    function read<T>(key: string, fallback: T, validate: (value: unknown) => unknown): T {
        const raw = storage.getItem(key);
        const value = raw === null ? structuredClone(fallback) : JSON.parse(raw);
        validate(value);
        return value;
    }

    function validateLeads(leads: unknown) {
        if (!Array.isArray(leads) || leads.some((lead: unknown) => !lead || typeof lead !== 'object' || !('company' in lead) || typeof lead.company !== 'string' || !('lead_id' in lead) || typeof lead.lead_id !== 'string')) {
            throw Error('Saved leads must contain a company and lead ID.');
        }
    }

    function write(key: string, value: unknown, validate: (value: unknown) => unknown) {
        validate(value);
        storage.setItem(key, JSON.stringify(value));
    }
    return {
        loadWorkspace: ({ cacheMigration = true }: { cacheMigration?: boolean | undefined; } = {}) => {
            const raw = storage.getItem(storageKeys.workspace);
            if (raw !== null)
                return validateWorkspace(JSON.parse(raw));
            const leads = read(storageKeys.leads, [] as Lead[], validateLeads);
            if (!leads.length)
                return structuredClone(emptyWorkspace);
            const value = migrateWorkspace(leads, read(storageKeys.rules, defaults as Rules, validateRules), read(storageKeys.templates, templates, validateTemplates));
            if (cacheMigration)
                write(storageKeys.workspace, value, validateWorkspace);
            return value;
        },

        saveWorkspace: (value: Workspace) => write(storageKeys.workspace, value, validateWorkspace),
        loadLeads: () => read(storageKeys.leads, [] as Lead[], validateLeads),

        saveLeads: (leads: Lead[]) => write(storageKeys.leads, leads, validateLeads),
        loadRules: () => read(storageKeys.rules, defaults as Rules, validateRules),

        saveRules: (rules: Rules) => write(storageKeys.rules, rules, validateRules),
        loadTemplates: () => read(storageKeys.templates, templates as Templates, validateTemplates),

        saveTemplates: (value: Templates) => write(storageKeys.templates, value, validateTemplates),
    };
}

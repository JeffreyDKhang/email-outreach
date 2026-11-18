import type {Lead} from '../domain/types.js';
import { messageSnapshot } from '../domain/outbox.mjs';
import { selectedDraftOnly } from '../domain/draft-state.mjs';

export function createOutboxService({ api, getDataset }: { api: import("../domain/types.js").LiveApi; getDataset: () => import("../domain/types.js").Dataset | null; }) {

    let pending: { signature: string; requestId: string; } | null = null;

    let inFlight: Promise<{ ids: string[]; }> | null = null;
    return {

        async add(leads: Lead[]) {
            if (inFlight)
                return inFlight;
            const dataset = getDataset();
            if (!dataset)
                throw Error('Choose a dataset first.');
            // Validate before making a request; retry an uncertain response with the same ID.
            const context = { datasetId: dataset.id, datasetName: dataset.name };
            const signature = JSON.stringify(leads.map((lead: Lead) => messageSnapshot(lead, dataset.rules, context)));
            if (!pending || pending.signature !== signature)
                pending = { signature, requestId: crypto.randomUUID() };
            const value = { ...context, requestId: pending.requestId, leads: leads.map(selectedDraftOnly), rules: dataset.rules };
            inFlight = api('/api/outbox/add', value);
            try {
                const result = await inFlight;
                pending = null;
                return result;
            }
            finally {
                inFlight = null;
            }
        },
    };
}

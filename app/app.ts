import type {Condition, Dataset, Lead, RuleProfile, Segment, Templates, Workspace} from './domain/types.js';
import { closest, byId as $, errorMessage, eventElement, query } from './ui/dom.mjs';
import { createUnsavedChangesGuard } from './ui/unsaved-changes.mjs';
import { mountWorkspaceStatus } from './ui/workspace-status.mjs';
import { createWorkspaceRepository } from './infrastructure/workspace-repository.mjs';
import { mountOutbox } from './ui/outbox-ui.mjs';
import { createOutboxService } from './application/outbox.mjs';
import { mountEligibility } from './ui/eligibility-ui.mjs';
import { mountSegmentSettings } from './ui/segments-ui.mjs';
import { editableRuleProfile } from './domain/rule-profile.mjs';
import { mountQueue } from './ui/queue-ui.mjs';
import { createQueueSync } from './application/queue-sync.mjs';
import { mountDatasetTools } from './ui/dataset-tools-ui.mjs';
import { datasetColumns } from './domain/lead-schema.mjs';
import { mountLeadEdit } from './ui/lead-edit-ui.mjs';
import { createLiveApi } from './infrastructure/live-api.mjs';
import { mountAccounts } from './ui/accounts-ui.mjs';
import { mountLiveSend } from './ui/live-send-ui.mjs';
import { mountImport } from './ui/import-ui.mjs';
import { mountLeadDetail } from './ui/lead-detail-ui.mjs';
import { createStorageRepository } from './infrastructure/storage.mjs';
import { mountScoring } from './ui/scoring-ui.mjs';
import { mountTable } from './ui/table-ui.mjs';
import { mountOutreach } from './ui/outreach-ui.mjs';
import { reconcileApproval } from './domain/outreach.mjs';
import { genericDefaults, scoreLead } from './domain/scoring.mjs';
import { warnings } from './domain/leads.mjs';
import { createDataset, datasetName, defaultTemplates, emptyWorkspace } from './domain/datasets.mjs';
const api = createLiveApi();
const repository = createWorkspaceRepository({ api, legacy: createStorageRepository() });
const unsavedChanges = createUnsavedChangesGuard();
const workspaceStatus = mountWorkspaceStatus({ unsavedChanges, status: $('workspace-status') });

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character: string) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ character as "\"" | "&" | "<" | ">" | "'"]));
let workspace = structuredClone(emptyWorkspace);

let visibleIds: string[] = [];
let storageReady = false;

function notice(text: string) { $('notice').textContent = text; }
workspaceStatus.saving(true);
workspaceStatus.show('Loading the saved workspace…');
try {
    const loaded = await repository.load();
    workspace = loaded.workspace;
    storageReady = true;
    workspaceStatus.show('Saved to the local backend · No account required');
    if (loaded.migrated)
        notice('Your browser workspace was copied to the local backend and verified. The original browser copy is kept.');
}
catch (error) {
    workspaceStatus.show('Workspace could not be loaded. Start the local backend and reload.');
    notice('Your saved data has not been replaced. ' + errorMessage(error));
}
finally {
    workspaceStatus.saving(false);
}
for (const dataset of workspace.datasets)
    dataset.leads = dataset.leads.map((lead: Lead) => ({ ...lead, messageWorkflow: 2, outreach_status: lead.outreach_status === 'Approved' ? 'Drafted' : lead.outreach_status }));
const active = () => workspace.datasets.find((dataset: Dataset) => dataset.id === workspace.activeId) ?? null;
const getLeads = () => active()?.leads || [];
const getColumns = () => datasetColumns(active());
const getRules = () => active()?.rules || genericDefaults;
const getAllLeads = () => workspace.datasets.flatMap((dataset: Dataset) => dataset.leads);

async function persist(next: Workspace) {
    if (!storageReady)
        throw Error('The saved workspace is unavailable. Start the backend and reload before making changes.');
    if (workspaceStatus.pending())
        throw Error('A workspace save is in progress. Wait and try again.');
    workspaceStatus.saving(true);
    try {
        workspace = await repository.save(next);
        workspaceStatus.show('Saved to the local backend · ' + new Date().toLocaleTimeString());
        return true;
    }
    catch (error) {
        workspaceStatus.show('Save not confirmed · Your edits are still in the form');
        notice(errorMessage(error));
        throw error;
    }
    finally {
        workspaceStatus.saving(false);
    }
}

async function updateActive(changes: Partial<Dataset>) {
    if (!active())
        throw Error('Import a CSV to create a dataset first.');
    const datasets = workspace.datasets.map((dataset: Dataset) => dataset.id === workspace.activeId ? { ...dataset, ...changes } : dataset);
    await persist({ ...workspace, datasets });
    render();
    return true;
}

function save(leads: Lead[]) { return updateActive({ leads: leads.map((lead: Lead) => ({ ...lead, messageWorkflow: 2 })) }); }

async function saveAllLeads(leads: Lead[]) {
    const records = new Map(leads.map((lead: Lead) => [lead.lead_id, lead]));
    const datasets = workspace.datasets.map((dataset: Dataset) => ({
        ...dataset,
        leads: dataset.leads.map((lead: Lead) => records.get(lead.lead_id) || lead),
    }));
    await persist({ ...workspace, datasets });
    render();
    return true;
}
function resetFilters() {
    $('search').value = '';
    table.clear();
}

async function selectDataset(id: string) {
    try {
        await persist({ ...workspace, activeId: id });
    }
    catch (error) {
        notice(errorMessage(error));
        return;
    }
    resetFilters();
    notice('');
    render();
}
function renderNavigation() {
    $('dataset-tabs').innerHTML = workspace.datasets.map((dataset: Dataset) => `
    <button class="dataset-tab ${dataset.id === workspace.activeId ? 'active' : ''}"
      data-dataset="${escape(dataset.id)}" aria-pressed="${dataset.id === workspace.activeId}">
      <span>${escape(dataset.name)}</span><small>${dataset.leads.length}</small>
    </button>`).join('') || '<p class="no-datasets">Import a CSV to create your first dataset.</p>';
    $('dataset-title').textContent = active()?.name || 'Your leads';
    $('dataset-description').textContent = active()
        ? 'Columns, rules and templates belong to this dataset.' : 'Each CSV becomes its own named dataset.';
    const actions =  ['segments', 'settings', 'eligibility', 'templates', 'rename-dataset', 'delete-dataset', 'add-leads', 'open-data-tools'] as const;
    for (const id of actions)
        $(id).disabled = !storageReady || !active();
    $('upload').disabled = !storageReady;
}

function renderEmptyState(leads: Lead[], filtered: Lead[]) {
    $('empty').hidden = filtered.length > 0;
    query($('empty'), 'h2').textContent = leads.length ? 'No matching leads'
        : active() ? 'No leads in this dataset' : 'A fresh start for your outreach';
    query($('empty'), 'p').textContent = leads.length ? 'Try changing your search or clearing the filters.'
        : active() ? 'Use Data tools to add a row or Add leads from CSV.' : 'Import a CSV to create a dataset with your own columns.';
}
function render() {
    outreach.clearSelection();
    const leads = getLeads();
    const filtered = table.rows($('search').value);
    visibleIds = filtered.map((row: Lead) => row.lead_id);
    renderNavigation();
    $('total').textContent = String(leads.length);
    $('locations').textContent = String(workspace.datasets.length);
    $('attention').textContent = String(leads.filter((row: Lead) => warnings(row, getColumns()).length).length);
    $('shown').textContent = `${filtered.length} of ${leads.length} leads`;
    table.render(filtered);
    $('attention-filter').setAttribute('aria-pressed', String(table.missingActive()));
    renderEmptyState(leads, filtered);
}
$('dataset-tabs').onclick = (event: PointerEvent) => {
    const button = closest(eventElement(event), '[data-dataset]');
    if (button)
        selectDataset(button.dataset.dataset || '');
};
$('rename-dataset').onclick = async () => {
    const name = prompt('Dataset name', active()?.name);
    if (name === null)
        return;
    try {
        if (await updateActive({ name: datasetName(name) }))
            notice('Dataset renamed.');
    }
    catch (error) {
        notice(errorMessage(error));
    }
};
$('delete-dataset').onclick = async () => {
    const dataset = active();
    if (!dataset)
        return;
    if (!confirm(`Delete "${dataset.name}" and its saved leads and drafts? This cannot be undone in the app. Outbox copies, queued messages and delivery history are kept separately; this does not remove held messages or cancel sending.`))
        return;
    const datasets = workspace.datasets.filter((item: Dataset) => item.id !== dataset.id);
    try {
        await persist({ ...workspace, activeId: datasets[0]?.id || null, datasets });
    }
    catch (error) {
        notice(errorMessage(error));
        return;
    }
    resetFilters();
    render();
    notice('Dataset deleted.');
};
$('search').oninput = render;
const table = mountTable({ getLeads, getColumns, getTypes: () => getRules().columnTypes || {}, score: (lead: Lead) => scoreLead(lead, getRules()), escape, onChange: render });
mountScoring({
    unsavedChanges,
    getLeads, getColumns, getRules, escape,
    async onSave(rules: RuleProfile) {
        const leads = getLeads().map((lead: Lead) => reconcileApproval(lead, rules));
        await updateActive({ rules, leads });
        notice('Scoring rules saved for this dataset.');
    },
});
$('clear-filters').onclick = () => { resetFilters(); render(); };
$('attention-filter').onclick = () => { $('search').value = ''; table.showMissing(); render(); };
const queueSync = createQueueSync({ api, getLeads: getAllLeads, save: saveAllLeads });
mountAccounts({ api, escape, unsavedChanges });
mountQueue({ api, queueSync, escape });
const liveSender = mountLiveSend({ api, getLeads: getAllLeads, getRules, getDataset: active, save: saveAllLeads, escape });
mountEligibility({ unsavedChanges, getLeads, getColumns, getRules, escape, async onSave(eligibility: Condition[]) {
        const rules = { ...editableRuleProfile(getRules(), getLeads()), eligibility };
        const leads = getLeads().map((lead: Lead) => reconcileApproval(lead, rules));
        await updateActive({ rules, leads });
        notice('Eligibility requirements saved for this dataset.');
    } });
mountSegmentSettings({ unsavedChanges, getLeads, getColumns, getRules, escape, async onSave(segments: Segment[]) {
        const rules = { ...editableRuleProfile(getRules(), getLeads()), segments };
        const leads = getLeads().map((lead: Lead) => reconcileApproval(lead, rules));
        await updateActive({ rules, leads });
        notice('Segments saved for this dataset.');
    } });
const scopedRepository = {
    loadTemplates: () => structuredClone(active()?.templates || defaultTemplates),

    async saveTemplates(templates: Templates) {
        const rules = getRules();
        const leads = getLeads().map((lead: Lead) => reconcileApproval(lead, rules));
        await updateActive({ templates: structuredClone(templates), rules, leads });
    },
};
const outboxService = createOutboxService({ api, getDataset: active });
mountOutbox({ unsavedChanges, api, liveSender, getDataset: active, escape });
const outreach = mountOutreach({
    unsavedChanges,
    outboxService,
    getLeads, getColumns, getVisibleIds: () => visibleIds, getRules, save,
    repository: scopedRepository, liveSender, escape, notice,
});
mountImport({
    unsavedChanges,
    getDataset: active, escape, notice,
    onAppend(id: string, rows: Lead[]) {
        if (active()?.id !== id)
            throw Error('The destination dataset changed. Start Add leads again.');
        return save([...getLeads(), ...rows.map((lead: Lead) => ({ ...lead, messageWorkflow: 2 }))]);
    },
    async onImport(name: string, leads: Lead[], sourceName: string) {
        const dataset = createDataset(name, leads.map((lead: Lead) => ({ ...lead, messageWorkflow: 2 })), sourceName);
        await persist({ ...workspace, activeId: dataset.id, datasets: [...workspace.datasets, dataset] });
        resetFilters();
        render();
        return true;
    },
});
mountLeadDetail({ getLeads, getColumns, getRules, openOutreach: outreach.open, escape });
mountLeadEdit({ getDataset: active, save, escape, notice, unsavedChanges });
mountDatasetTools({
    unsavedChanges,
    getDataset: active, getSelectedIds: outreach.getSelectedIds, escape, notice,
    onSave(next: Dataset) {
        if (active()?.id !== next.id)
            throw Error('The dataset changed. Reopen Data tools.');
        resetFilters();
        return updateActive(next);
    },
});
render();

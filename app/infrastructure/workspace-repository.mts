import type {Workspace, WorkspaceRecord, WorkspaceRepository} from '../domain/types.js';
import { validateWorkspace } from '../domain/datasets.mjs';
const conflictMessage = 'The saved workspace changed in another tab or browser. Your edits are still here. Reload to load the newer workspace before saving again.';

export function createWorkspaceRepository({ api, legacy }: { api: import("../domain/types.js").LiveApi; legacy: import("../domain/types.js").LegacyWorkspaceSource; }): WorkspaceRepository {

    let revision: number | null = null;
    let busy = false, conflicted = false;

    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    function accept(record: WorkspaceRecord) {
        if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !record.workspace)
            throw Error('The backend returned an invalid saved workspace.');
        validateWorkspace(record.workspace);
        revision = record.revision;
        return structuredClone(record.workspace);
    }

    async function save(value: Workspace) {
        if (revision === null)
            throw Error('Load the saved workspace before making changes.');
        if (conflicted)
            throw Error(conflictMessage);
        if (busy)
            throw Error('A workspace save is already in progress. Please wait and try again.');
        const workspace = structuredClone(validateWorkspace(value)), expected = revision;
        busy = true;
        try {
            const result = await api('/api/workspace', { workspace, revision: expected });
            if (result.revision !== expected + 1)
                throw Error('The workspace save could not be verified.');
            revision = result.revision;
            return workspace;
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'workspace_conflict') {
                conflicted = true;
                throw Error(conflictMessage);
            }
            // A lost response may follow a successful commit. Read back; never repeat a write blindly.
            try {
                const record = await api('/api/workspace');
                if (record.revision === expected + 1 && equal(record.workspace, workspace))
                    return accept(record);
                if (record.revision > expected) {
                    conflicted = true;
                    throw Error(conflictMessage);
                }
            }
            catch (checkError) {
                if (conflicted)
                    throw checkError;
            }
            throw Error('Unable to confirm the workspace save. Your edits are still here. Check that the local backend is running, then try saving again. ' + (error instanceof Error ? error.message : String(error)));
        }
        finally {
            busy = false;
        }
    }
    return {
        async load() {
            const record = await api('/api/workspace');
            if (record.workspace !== null)
                return { workspace: accept(record), migrated: false };
            if (record.revision !== 0)
                throw Error('Invalid workspace migration state.');
            // Only read browser data when the backend has never held a workspace.
            const workspace = legacy.loadWorkspace({ cacheMigration: false });
            validateWorkspace(workspace);
            revision = 0;
            try {
                await save(workspace);
            }
            catch (error) {
                const winner = await api('/api/workspace');
                if (winner.workspace !== null && winner.revision > 0) {
                    conflicted = false;
                    return { workspace: accept(winner), migrated: false };
                }
                throw error;
            }
            const verified = await api('/api/workspace');
            return { workspace: accept(verified), migrated: equal(verified.workspace, workspace) && workspace.datasets.length > 0 };
        },
        save,
    };
}

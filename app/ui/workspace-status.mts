// Freeze controls during a write so an acknowledged snapshot cannot discard typing
// or close/reopen a dialog underneath an asynchronous Save action.

export function mountWorkspaceStatus({ unsavedChanges, root = document, status }: { unsavedChanges: ReturnType<typeof import("./unsaved-changes.mjs").createUnsavedChangesGuard>; root?: Pick<Document, "querySelectorAll" | "addEventListener">; status: Pick<HTMLElement, "textContent">; }) {
    let pending = false;

    let controls: [HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement, boolean][] = [];
    unsavedChanges.register(() => pending);
    root.addEventListener('cancel', (event: Event) => { if (pending)
        event.preventDefault(); }, true);
    return {
        pending: () => pending,

        saving(value: boolean) {
            pending = value;
            if (value) {
                const fields =  root.querySelectorAll('button,input,textarea,select') as NodeListOf<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>;
                controls = [...fields].map((control: HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement) => [control, control.disabled]);
                for (const [control] of controls)
                    control.disabled = true;
                status.textContent = 'Saving to the local backend…';
            }
            else {
                for (const [control, disabled] of controls)
                    if (control.isConnected)
                        control.disabled = disabled;
                controls = [];
            }
        },

        show(message: string) { status.textContent = message; },
    };
}


export function unsavedControlValues(root: Pick<ParentNode, "querySelectorAll">, selector: string | undefined = 'input,textarea,select') {
    const controls =  root.querySelectorAll(selector) as NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
    return [...controls].map((control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => [
        control.type,
        (control.type === 'checkbox' || control.type === 'radio') && 'checked' in control ? control.checked :
            'selectedOptions' in control && control.multiple ? [...control.selectedOptions].map((option: HTMLOptionElement) => option.value) : control.value,
    ]);
}
// Check live form values at unload, including structural changes made by buttons.
// The browser supplies its own warning text and requires prior user interaction.

export function createUnsavedChangesGuard(target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = globalThis.window) {

    const checks: Set<() => boolean> = new Set();
    const isDirty = () => [...checks].some((check: () => boolean) => check());

    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (!isDirty())
            return;
        event.preventDefault();
        event.returnValue = '';
    };
    target.addEventListener('beforeunload', beforeUnload);

    function register(check: () => boolean) { checks.add(check); return () => checks.delete(check); }
    return {
        isDirty, register,

        track(root: (Pick<ParentNode, "querySelectorAll"> & { open?: boolean; }) | null, { selector, read = () => root ? unsavedControlValues(root, selector) : [], active = () => !!root?.open }: { selector?: string; read?: () => unknown; active?: () => boolean; } | undefined = {}) {

            let baseline: string | null | undefined = null;
            const dispose = register(() => baseline !== null && active() && JSON.stringify(read()) !== baseline);
            return { reset(saved: unknown = read()) { baseline = JSON.stringify(saved); }, clear() { baseline = null; }, dispose };
        },
        dispose() { target.removeEventListener('beforeunload', beforeUnload); checks.clear(); },
    };
}

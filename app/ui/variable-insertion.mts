import { closest } from './dom.mjs';
import { eventElement } from './dom.mjs';
// Retains the caret while the user operates the variable picker and button.

export function createVariableInsertion({ root, warn }: { root: HTMLElement; warn: (message: string) => void; }) {

    let target: HTMLInputElement | HTMLTextAreaElement | null = null;
    root.addEventListener('focusin', (event: FocusEvent) => {
        const field = eventElement(event);
        if (field.matches('[data-subject],[data-body]'))
            target =  field as HTMLInputElement | HTMLTextAreaElement;
        else if (!closest(field, '[data-template]'))
            target = null;
    });
    return {
        reset() { target = null; },

        insert(index: string | number | undefined, key: string) {
            if (!target || !root.contains(target) || String(target.dataset.subject ?? target.dataset.body) !== String(index)) {
                warn('Click in this template’s Subject or Message where you want to insert a variable, then try again.');
                return false;
            }
            target.setRangeText('{{' + key + '}}', target.selectionStart ?? 0, target.selectionEnd ?? 0, 'end');
            target.focus();
            return true;
        },
    };
}

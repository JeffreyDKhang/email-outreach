import type {ElementTags, Elements} from './elements.js';
import type {Comparison, Condition, Operator} from '../domain/types.js';
// Look up a required static control. Keep ID/tag contracts in elements.d.ts in
// sync with dialog markup. The runtime check reports missing markup clearly.
export function byId<K extends keyof ElementTags>(id: K): Elements[K] {
    const node = document.getElementById(id);
    if (!node)
        throw Error(`Missing interface element: ${id}`);
    return  node as Elements[K];
}

export function findById<K extends keyof ElementTags>(id: K): Elements[K] | null { return  document.getElementById(id) as Elements[K] | null; }

export function closest(node: Element, selector: string): HTMLElement | null { return  node.closest(selector) as HTMLElement | null; }

export function ancestor(node: Element, selector: string) { const parent = closest(node, selector); if (!parent)
    throw Error(`Missing interface parent: ${selector}`); return parent; }

export function field(root: ParentNode, selector: string) { return  query(root, selector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }

export function inputs(root: ParentNode, selector: string | undefined = 'input') { return  root.querySelectorAll(selector) as NodeListOf<HTMLInputElement>; }

export function updateCondition(condition: Comparison | Condition, key: string, value: string) {
    if (key === 'operator')
        condition.operator =  value as Operator;
    else if (key === 'field' && 'field' in condition)
        condition.field = value;
    else if (key === 'value' || key === 'to')
        condition[key] = value;
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function eventElement(event: Event | { target: EventTarget | null; }) { return  event.target as HTMLElement; }
// Bound input/change handlers use the shared value property of form controls.
export function eventControl(event: Event) { return  event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }

export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
    const node = root.querySelector(selector);
    if (!node)
        throw Error(`Missing interface control: ${selector}`);
    return  node as T;
}

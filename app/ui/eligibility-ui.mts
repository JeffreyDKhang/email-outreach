import type {EligibilityOptions} from './types.js';
import type {Column, Condition, RuleProfile} from '../domain/types.js';
import { ancestor } from './dom.mjs';
import { closest, updateCondition } from './dom.mjs';
import { byId as $, errorMessage, eventElement, eventControl } from './dom.mjs';
import { editableRuleProfile } from '../domain/rule-profile.mjs';
import { validateRules } from '../domain/scoring.mjs';
import { allowedOperators, columnType, validateConditionTypes } from '../domain/column-types.mjs';

const labels: Record<string, string> = { equals: 'Equals', not_equals: 'Does not equal', contains: 'Contains', in: 'Is one of (comma separated)', gte: 'At least', lte: 'At most', between: 'Between', present: 'Has a value', missing: 'Is blank' };

export function mountEligibility({ unsavedChanges, getLeads, getColumns, getRules, onSave, escape: e }: EligibilityOptions) {

    let editing: RuleProfile;
    const dialog = document.createElement('dialog');
    dialog.id = 'eligibility-dialog';
    dialog.innerHTML = '<form id="eligibility-form"><div class="dialog-heading"><h2>Optional eligibility requirements</h2><button type="button" id="close-eligibility">Close</button></div><p>These requirements set the table’s Eligibility column independently of score and Priority. Every requirement must match. A failed requirement makes a lead Ineligible; missing required information shows Needs data. Leave empty to allow all leads, subject to recipient and message validation.</p><div id="eligibility-conditions"></div><button type="button" id="add-eligibility">Add eligibility requirement</button><p id="eligibility-error" role="alert"></p><button type="submit" class="primary">Save eligibility requirements</button></form>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog);
    function draw() {
        $('eligibility-conditions').innerHTML = editing.eligibility.map((condition: Condition, index: number) => {
            const columns = getColumns();
            const choices = allowedOperators(columnType(getLeads(), condition.field, editing.columnTypes));
            const conflict = !choices.includes(condition.operator);
            if (conflict)
                choices.push(condition.operator);
            const numeric = ['gte', 'lte', 'between'].includes(condition.operator);
            return `<div class="condition" data-eligibility-index="${index}">
        <label>Column<select data-eligibility-field="field">${columns.map((column: Column) => `<option value="${e(column.key)}" ${column.key === condition.field ? 'selected' : ''}>${e(column.label)}</option>`).join('')}${columns.some((column: Column) => column.key === condition.field) ? '' : `<option selected value="${e(condition.field)}">${e(condition.field)} (missing column)</option>`}</select></label>
        <label>Condition<select data-eligibility-field="operator">${choices.map((operator: string) => `<option value="${operator}" ${operator === condition.operator ? 'selected' : ''}>${labels[operator]}${conflict && operator === condition.operator ? ' (incompatible)' : ''}</option>`).join('')}</select></label>
        ${['present', 'missing'].includes(condition.operator) ? '' : `<label>${condition.operator === 'between' ? 'Lower bound' : 'Value'}<input data-eligibility-field="value" type="${numeric ? 'number' : 'text'}" step="any" value="${e(condition.value ?? '')}" required></label>`}
        ${condition.operator === 'between' ? `<label>Upper bound<input data-eligibility-field="to" type="number" step="any" value="${e(condition.to ?? '')}" required></label>` : ''}
        <button type="button" data-remove-eligibility="${index}">Remove requirement</button>
        ${conflict ? '<p class="warning">Correct this numeric condition or change the column type in ICP Settings.</p>' : ''}</div>`;
        }).join('');
    }
    $('eligibility').onclick = () => { editing = editableRuleProfile(getRules(), getLeads()); $('eligibility-error').textContent = ''; draw(); unsaved?.reset(); dialog.showModal(); };
    $('close-eligibility').onclick = () => dialog.close();
    $('add-eligibility').onclick = () => { editing.eligibility.push({ field: getColumns()[0]?.key || 'company', operator: 'present' }); draw(); };

    const change = (event: Event) => {
        const field = eventElement(event).dataset.eligibilityField;
        if (!field)
            return;
        const index = Number(ancestor(eventElement(event), '[data-eligibility-index]').dataset.eligibilityIndex);
        updateCondition(editing.eligibility[index], field, eventControl(event).value);
        if (eventElement(event).tagName === 'SELECT')
            draw();
    };
    $('eligibility-conditions').oninput = (event: InputEvent) => { if (eventElement(event).tagName !== 'SELECT')
        change(event); };
    $('eligibility-conditions').onchange = (event: Event) => { if (eventElement(event).tagName === 'SELECT')
        change(event); };
    $('eligibility-conditions').onclick = (event: PointerEvent) => {
        const button = closest(eventElement(event), '[data-remove-eligibility]');
        if (button) {
            editing.eligibility.splice(Number(button.dataset.removeEligibility), 1);
            draw();
        }
    };
    $('eligibility-form').onsubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        try {
            const validation = { ...editing, criteria: [], segments: [], medium: 1, high: 2 };
            validateRules(validation);
            validateConditionTypes(validation, getLeads());
            await onSave(structuredClone(editing.eligibility));
            dialog.close();
        }
        catch (error) {
            $('eligibility-error').textContent = errorMessage(error);
        }
    };
}

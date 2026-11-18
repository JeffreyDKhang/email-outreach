import type {SegmentEditorOptions, SegmentOptions} from './types.js';
import type {Column, Condition, RuleProfile, Segment} from '../domain/types.js';
import { ancestor } from './dom.mjs';
import { closest, updateCondition } from './dom.mjs';
import { byId as $, errorMessage, eventElement, eventControl } from './dom.mjs';
import { allowedOperators, columnType, validateConditionTypes } from '../domain/column-types.mjs';
import { validateRules } from '../domain/scoring.mjs';
import { editableRuleProfile } from '../domain/rule-profile.mjs';

export function mountSegmentSettings({ unsavedChanges, getLeads, getColumns, getRules, onSave, escape }: SegmentOptions) {
    const dialog = document.createElement('dialog');
    dialog.id = 'segments-dialog';
    dialog.innerHTML = '<div class="dialog-heading"><h2>Segments</h2><button id="close-segments">Close</button></div><p>Group leads by CSV values to choose their template. Every condition must match; the first matching segment wins. In Templates, create a template with exactly the same name as the segment. General is the fallback. Segments do not change ICP scores or eligibility.</p><div id="segment-editor"></div><p id="segments-error" role="alert"></p><button id="save-segments" class="primary">Save segments</button>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog);
    const editor = mountSegments({ container: $('segment-editor'), getLeads, getColumns, escape });
    $('segments').onclick = () => { editor.open(editableRuleProfile(getRules(), getLeads())); $('segments-error').textContent = ''; unsaved?.reset(); dialog.showModal(); };
    $('close-segments').onclick = () => dialog.close();
    $('save-segments').onclick = async () => {
        try {
            await onSave(editor.value());
            dialog.close();
        }
        catch (error) {
            $('segments-error').textContent = errorMessage(error);
        }
    };
}

const labels: Record<string, string> = { equals: 'Equals', not_equals: 'Does not equal', contains: 'Contains', in: 'Is one of (comma separated)', gte: 'At least', lte: 'At most', between: 'Between', present: 'Has a value', missing: 'Is blank' };
// Owns only an unsaved segment draft. The parent commits templates and routing together.

export function mountSegments({ container, getLeads, getColumns, escape: e }: SegmentEditorOptions) {

    let profile: RuleProfile;
    function draw() {
        container.innerHTML = profile.segments.map((segment: Segment, index: number) => `<fieldset data-segment="${index}"><legend>Segment ${index + 1}</legend>
      <label>Name<input data-segment-name value="${e(segment.name)}"></label>
      ${segment.conditions.map((condition: Condition, i: number) => {
            const choices = allowedOperators(columnType(getLeads(), condition.field, profile.columnTypes));
            const conflict = !choices.includes(condition.operator);
            if (conflict)
                choices.push(condition.operator);
            return `<div class="condition" data-segment-condition="${i}"><label>Column<select data-segment-field="field">${getColumns().map((column: Column) => `<option value="${e(column.key)}" ${column.key === condition.field ? 'selected' : ''}>${e(column.label)}</option>`).join('')}${getColumns().some((column: Column) => column.key === condition.field) ? '' : `<option selected value="${e(condition.field)}">${e(condition.field)} (missing column)</option>`}</select></label>
        <label>Condition<select data-segment-field="operator">${choices.map((operator: string) => `<option value="${operator}" ${operator === condition.operator ? 'selected' : ''}>${labels[operator]}${conflict && operator === condition.operator ? ' (incompatible)' : ''}</option>`).join('')}</select></label>
        ${['present', 'missing'].includes(condition.operator) ? '' : `<label>Value<input data-segment-field="value" value="${e(condition.value ?? '')}" type="${['gte', 'lte', 'between'].includes(condition.operator) ? 'number' : 'text'}" step="any"></label>`}
        ${condition.operator === 'between' ? `<label>Upper bound<input data-segment-field="to" value="${e(condition.to ?? '')}" type="number" step="any"></label>` : ''}
        <button type="button" data-segment-action="remove-condition">Remove condition</button>${conflict ? '<p class="warning">Numeric condition on a Text column. Correct the condition or change Column types in ICP Settings.</p>' : ''}</div>`;
        }).join('')}
      <button type="button" data-segment-action="add-condition">Add condition</button>
      <button type="button" data-segment-action="remove">Remove segment</button></fieldset>`).join('') + '<button type="button" data-segment-action="add">Add segment</button>';
    }

    function change(event: Event) {
        const section = ancestor(eventElement(event), '[data-segment]');
        if (!section)
            return;
        const segment = profile.segments[Number(section.dataset.segment)];
        if (eventElement(event).hasAttribute('data-segment-name'))
            segment.name = eventControl(event).value;
        const field = eventElement(event).dataset.segmentField;
        if (field) {
            const row = ancestor(eventElement(event), '[data-segment-condition]');
            updateCondition(segment.conditions[Number(row.dataset.segmentCondition)], field, eventControl(event).value);
        }
        if (eventElement(event).tagName === 'SELECT')
            draw();
    }
    container.oninput = (event: InputEvent) => { if (eventElement(event).tagName !== 'SELECT')
        change(event); };
    container.onchange = (event: Event) => { if (eventElement(event).tagName === 'SELECT')
        change(event); };
    container.onclick = (event: PointerEvent) => {
        const button = closest(eventElement(event), '[data-segment-action]');
        if (!button)
            return;
        const action = button.dataset.segmentAction;

        const fresh = (): Condition => ({ field: getColumns()[0]?.key || 'company', operator: 'present' });
        if (action === 'add')
            profile.segments.push({ name: 'New segment ' + (profile.segments.length + 1), conditions: [fresh()] });
        else {
            const index = Number(ancestor(button, '[data-segment]').dataset.segment), segment = profile.segments[index];
            if (action === 'remove')
                profile.segments.splice(index, 1);
            if (action === 'add-condition')
                segment.conditions.push(fresh());
            if (action === 'remove-condition')
                segment.conditions.splice(Number(ancestor(button, '[data-segment-condition]').dataset.segmentCondition), 1);
        }
        draw();
    };
    return {

        open(rules: RuleProfile) { profile = structuredClone(rules); draw(); },
        value() {
            const rules = { ...profile, criteria: [], eligibility: [], medium: 1, high: 2 };
            validateRules(rules);
            validateConditionTypes(rules, getLeads());
            return structuredClone(profile.segments);
        },
    };
}

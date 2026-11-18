import type {ScoringOptions} from './types.js';
import type {Column, Comparison, Criterion, RuleProfile} from '../domain/types.js';
import { closest, field, inputs, updateCondition } from './dom.mjs';
import { byId as $, errorMessage, eventElement, eventControl } from './dom.mjs';
import { editableRuleProfile } from '../domain/rule-profile.mjs';
import { genericDefaults, validateRules } from '../domain/scoring.mjs';
import { columnType, allowedOperators, conditionTypeError, pointsError, validateConditionTypes } from '../domain/column-types.mjs';
import { sourceColumns } from '../domain/lead-schema.mjs';

const names: Record<string, string> = { equals: 'Equals', not_equals: 'Does not equal', contains: 'Contains', in: 'Is one of (comma separated)', gte: 'At least', lte: 'At most', between: 'Between', present: 'Has a value', missing: 'Is blank' };

export function mountScoring({ unsavedChanges, getLeads, getColumns = () => sourceColumns(getLeads()), getRules, onSave, escape: e }: ScoringOptions) {

    let editing: RuleProfile;
    const unsaved = unsavedChanges?.track($('settings-dialog'));

    function columnOptions(key: string) { const cols = getColumns(); if (!cols.some((c: Column) => c.key === key) && key)
        cols.push({ key, label: key + ' (not in current dataset)' }); return cols.map((c: Column) => `<option value="${e(c.key)}" ${c.key === key ? 'selected' : ''}>${e(c.label)}</option>`).join(''); }
    const newCondition = () => ({ field: getColumns()[0]?.key || 'company', operator: 'present', value: '' });

    function conditionHTML(condition: Comparison & { field?: string; points?: number; }, index: number, withField: boolean, field: string | undefined = condition.field || '', weight?: number | undefined) {
        const type = columnType(getLeads(), field, editing.columnTypes);
        const conflict = conditionTypeError(condition, type);
        const choices = allowedOperators(type);
        if (conflict)
            choices.push(condition.operator);
        const needsValue = !['missing', 'present'].includes(condition.operator);
        const numeric = ['gte', 'lte', 'between'].includes(condition.operator);
        return `<div class="condition" data-condition="${index}">${withField ? `<label>Column<select data-field="field">${columnOptions(field)}</select></label>` : ''}
      <label>Condition<select data-field="operator">${choices.map((op: string) => `<option value="${op}" ${condition.operator === op ? 'selected' : ''}>${names[op]}${conflict && op === condition.operator ? ' (incompatible)' : ''}</option>`).join('')}</select></label>
      ${needsValue ? `<label>${condition.operator === 'between' ? 'Lower bound' : 'Value'}<input data-field="value" type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="any"' : ''} value="${e(condition.value ?? '')}" required></label>` : ''}
      ${condition.operator === 'between' ? `<label>Upper bound<input data-field="to" type="number" step="any" value="${e(condition.to ?? '')}" required></label>` : ''}
      ${withField ? '' : `<label>Points<input type="number" min="0" max="${weight}" step="any" data-field="points" value="${condition.points}" required><span data-points-error role="alert"></span></label>`}
      <button type="button" data-action="remove-condition">Remove condition</button>${conflict ? `<p class="warning" role="alert">${e(conflict)}</p>` : ''}</div>`;
    }
    function validatePoints() {
        for (const box of $('weight-fields').querySelectorAll('[data-group]')) {
            const maximum = Number(field(box, '[data-field="weight"]').value);
            for (const input of inputs(box, '[data-field="points"]')) {
                input.max = String(maximum);
                const message = pointsError(input.value, maximum);
                input.setCustomValidity(message);
                input.setAttribute('aria-invalid', String(!!message));
                if (input.nextElementSibling)
                    input.nextElementSibling.textContent = message;
            }
        }
    }
    function maximum() {
        const maximum = editing.criteria.reduce((sum: number, criterion: Criterion) => sum + criterion.weight, 0);
        $('rules-maximum').textContent = editing.criteria.length ? 'Maximum score: ' + maximum + ' points (total criterion weights).' : 'No scoring criteria: Priority is Unscored.';
        const medium = Number($('rule-medium').value), high = Number($('rule-high').value);
        $('priority-summary').textContent = !editing.criteria.length ? 'Add scoring criteria to assign Low, Medium or High priority.' : medium >= 1 && high > medium && high <= maximum ? `Low priority: 0 to below ${medium}. Medium priority: ${medium} to below ${high}. High priority: ${high} and above.` : 'Set thresholds so 1 <= Medium < High <= maximum score.';
    }
    $('rule-medium').oninput = maximum;
    $('rule-high').oninput = maximum;
    function draw() {
        $('weight-fields').innerHTML = editing.criteria.map((c: Criterion, i: number) => `<fieldset data-group="criteria" data-index="${i}"><legend>Scoring criterion ${i + 1}</legend><div class="rule-heading"><label>Name<input data-field="name" value="${e(c.name)}" required></label><label>Column<select data-field="field">${columnOptions(c.field)}</select></label><label>Weight / max points<input type="number" data-field="weight" min="0" max="1000" step="any" value="${c.weight}" required></label><button type="button" data-action="remove-item">Remove criterion</button></div><p>Only the highest matching condition points count.</p>${c.cases.map((x: Comparison & { points: number; }, j: number) => conditionHTML(x, j, false, c.field, c.weight)).join('')}<button type="button" data-action="add-condition">Add condition</button></fieldset>`).join('');
        $('column-types').innerHTML = getColumns().map((c: Column) => `<label>${e(c.label)}<select data-type-key="${e(c.key)}"><option value="">Auto (${columnType(getLeads(), c.key)})</option><option value="text" ${editing.columnTypes?.[c.key] === 'text' ? 'selected' : ''}>Text</option><option value="number" ${editing.columnTypes?.[c.key] === 'number' ? 'selected' : ''}>Number</option></select></label>`).join('');
        maximum();
        validatePoints();
    }
    const types = document.createElement('details');
    types.className = 'column-types-card';
    types.innerHTML = '<summary><span><span class="column-types-title">Column types</span><span class="column-types-helper">Shared with table filters</span></span></summary><div class="column-types-body"><p>Auto uses nonblank values. Mixed, blank and leading-zero columns default to Text. Overrides do not change CSV values.</p><div id="column-types"></div></div>';
    $('scoring-criteria').before(types);
    $('column-types').onchange = (event: Event) => { const key = eventElement(event).dataset.typeKey; if (!key)
        return; editing.columnTypes ??= {}; if (eventControl(event).value)
        Object.defineProperty(editing.columnTypes, key, { value: eventControl(event).value, enumerable: true, writable: true, configurable: true });
    else
        delete editing.columnTypes[key]; draw(); };

    function populate(value: RuleProfile) { editing = value; $('rule-medium').value = String(value.medium); $('rule-high').value = String(value.high); $('rules-error').textContent = ''; draw(); }
    $('settings').onclick = () => { populate(editableRuleProfile(getRules(), getLeads())); types.open = false; unsaved?.reset(); $('settings-dialog').showModal(); };
    $('close-settings').onclick = () => $('settings-dialog').close();
    $('blank-rules').onclick = () => { if (!confirm('Clear scoring criteria, column-type overrides and priority thresholds in this form? Your eligibility requirements and segments are kept. Nothing is saved until Save and recalculate.'))
        return; populate({ ...structuredClone(genericDefaults), segments: structuredClone(editing.segments), eligibility: structuredClone(editing.eligibility) }); };
    $('add-criterion').onclick = () => { editing.criteria.push({ name: 'New criterion', field: newCondition().field, weight: 10, cases: [{ operator: 'present', points: 10 }] }); draw(); };

    function target(event: Event | { target: EventTarget | null; }) {
        const box = closest(eventElement(event), '[data-group]');
        if (!box || box.dataset.group !== 'criteria')
            return;
        const index = Number(box.dataset.index), item = editing.criteria[index];
        if (!item)
            return;
        const condition = closest(eventElement(event), '[data-condition]');
        return { index, item, conditionIndex: condition ? Number(condition.dataset.condition) : null };
    }

    function change(event: Event) {
        const selected = target(event), key = eventElement(event).dataset.field;
        if (!selected || !key)
            return;
        const value = eventControl(event).value;
        if (selected.conditionIndex !== null) {
            const condition = selected.item.cases[selected.conditionIndex];
            if (key === 'points')
                condition.points = value === '' ? NaN : Number(value);
            else
                updateCondition(condition, key, value);
        }
        else if (key === 'weight')
            selected.item.weight = value === '' ? NaN : Number(value);
        else if (key === 'name' || key === 'field')
            selected.item[key] = value;
        maximum();
        validatePoints();
    }
    $('weight-fields').oninput = change;
    $('weight-fields').onchange = (event: Event) => { if (eventElement(event).tagName === 'SELECT') {
        change(event);
        draw();
    } };
    $('weight-fields').onclick = (event: PointerEvent) => {
        const button = closest(eventElement(event), '[data-action]');
        if (!button)
            return;
        const selected = target({ target: button });
        if (!selected)
            return;
        const { index, item, conditionIndex } = selected, action = button.dataset.action;
        if (action === 'remove-item')
            editing.criteria.splice(index, 1);
        if (action === 'remove-condition' && conditionIndex !== null)
            item.cases.splice(conditionIndex, 1);
        if (action === 'add-condition')
            item.cases.push({ operator: 'present', points: item.weight });
        draw();
    };
    $('rules-form').onsubmit = async (event: SubmitEvent) => { event.preventDefault(); try {
        editing.medium = Number($('rule-medium').value);
        editing.high = Number($('rule-high').value);
        validateRules(editing);
        validateConditionTypes({ ...editing, segments: [], eligibility: [] }, getLeads());
        await onSave(structuredClone(editing));
        $('settings-dialog').close();
    }
    catch (error) {
        $('rules-error').textContent = errorMessage(error);
    } };
}

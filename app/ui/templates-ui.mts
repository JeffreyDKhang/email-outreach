import type {TemplatesOptions} from './types.js';
import type {Column, Segment, Templates} from '../domain/types.js';
import { byId as $, errorMessage, eventElement, closest, field } from './dom.mjs';
import { unsavedControlValues } from './unsaved-changes.mjs';
import { createVariableInsertion } from './variable-insertion.mjs';
import { editableRuleProfile } from '../domain/rule-profile.mjs';
import { templates, templateAt, validateTemplates, templateNames, withoutPersonalization } from '../domain/outreach.mjs';
import { defaultTemplates } from '../domain/datasets.mjs';
import { sourceColumns } from '../domain/lead-schema.mjs';

export function mountTemplates({ unsavedChanges, repository, getLeads, getColumns = () => sourceColumns(getLeads()), getRules, escape: e, notice }: TemplatesOptions) {

    let config: Templates = structuredClone(templates);

    let editing: Templates;

    function currentTemplate(name: string) { const template = templateAt(editing, name); if (!template)
        throw Error('The template no longer exists. Reopen Templates.'); return template; }
    try {
        config = repository.loadTemplates();
    }
    catch {
        notice('Saved templates could not be read. Default templates are active.');
    }
    const dialog = document.createElement('dialog');
    dialog.id = 'templates-dialog';
    dialog.innerHTML = '<div class="dialog-heading"><h2>Email templates</h2><button id="close-templates">Close</button></div><p>Insert variables directly from your dataset. General is the fallback template. A template with the same name as a segment is used for that segment. Missing source values must be corrected or the message edited before adding to Outbox.</p><div id="template-fields"></div><div class="actions"><label>Select template type<select id="new-template-segment"><option value="">Custom template</option></select></label><input id="new-template-name" aria-label="New template name" placeholder="Template / segment name"><button id="add-template">Add template</button></div><p id="template-error" role="alert"></p><div class="template-save-actions"><button id="save-templates" class="primary">Save templates</button><button id="restore-templates">Reset and delete all templates</button></div>';
    document.body.append(dialog);
    const unsaved = unsavedChanges?.track(dialog, { read: () => [templateNames(editing), unsavedControlValues(dialog, '[data-subject],[data-body],#new-template-name')] });
    const insertion = createVariableInsertion({ root: dialog, warn: (message: string) => { $('template-error').textContent = message; alert(message); } });
    function draw() {
        insertion.reset();
        const columns = getColumns();
        $('new-template-segment').innerHTML = '<option value="">Custom template</option>' + editableRuleProfile(getRules(), getLeads()).segments.map((segment: Segment) => `<option value="${e(segment.name)}" ${Object.hasOwn(editing, segment.name) ? 'disabled' : ''}>${e(segment.name)}</option>`).join('');
        $('new-template-name').disabled = false;
        $('template-fields').innerHTML = templateNames(editing).map((name: string, i: number) => `<fieldset data-template="${i}"><legend>${e(name)}</legend><label>Subject<input data-subject="${i}" value="${e(currentTemplate(name).subject)}"></label><label>Message<textarea rows="7" data-body="${i}">${e(currentTemplate(name).body)}</textarea></label><p>Click in the Subject or Message of this template, choose a dataset variable, then click Insert variable.</p><div class="actions"><label>Insert a dataset variable<select data-variable="${i}" aria-label="Dataset variable">${columns.map((c: Column) => `<option value="${e(c.key)}">${e(c.label)}</option>`).join('')}</select></label><button data-insert="${i}">Insert variable</button><button data-remove-template="${i}" ${name === 'General' ? 'disabled' : ''}>Remove template</button></div></fieldset>`).join('');
    }
    function capture() { for (const [i, name] of templateNames(editing).entries()) {
        editing[name] = { subject: field(document, `[data-subject="${i}"]`).value, body: field(document, `[data-body="${i}"]`).value };
    } }

    function populate(value: Templates) { editing = withoutPersonalization(value); editing.General ??= structuredClone(templates.General); $('template-error').textContent = ''; draw(); }
    $('templates').onclick = () => { populate(repository.loadTemplates()); unsaved?.reset(); dialog.showModal(); };
    $('close-templates').onclick = () => dialog.close();
    $('restore-templates').onclick = () => { if (!confirm('Reset General to its default and delete all other templates in this dataset? Your template edits will be discarded. This takes effect only when you click Save templates. Existing lead drafts, sent messages and segment rules are kept.'))
        return; populate(defaultTemplates); $('template-error').textContent = 'Templates reset in this form. Click Save templates to apply, or Close to discard the reset.'; };
    $('template-fields').onclick = (event: PointerEvent) => {
        const button = closest(eventElement(event), 'button');
        if (!button)
            return;
        const index = button.dataset.insert ?? button.dataset.removeTemplate;
        if (button.hasAttribute('data-insert')) {
            const key = field(document, `[data-variable="${index}"]`).value;
            if (insertion.insert(index, key))
                $('template-error').textContent = '';
        }
        else {
            capture();
            delete editing[templateNames(editing)[Number(index)]];
            draw();
        }
    };
    $('new-template-segment').onchange = () => { const name = $('new-template-segment').value; $('new-template-name').disabled = !!name; $('new-template-name').value = name; };
    $('add-template').onclick = () => { try {
        capture();
        const name = ($('new-template-segment').value || $('new-template-name').value).trim();
        if (!name || name.startsWith('_') || Object.hasOwn(editing, name))
            throw Error('Enter a new non-reserved template name.');
        Object.defineProperty(editing, name, { value: structuredClone(currentTemplate('General')), enumerable: true, writable: true, configurable: true });
        $('new-template-name').value = '';
        draw();
    }
    catch (error) {
        $('template-error').textContent = errorMessage(error);
    } };
    $('save-templates').onclick = async () => { try {
        capture();
        editing._columns = getColumns().flatMap((c: Column) => [c.key, c.label]);
        validateTemplates(editing);
        await repository.saveTemplates(editing);
        config = structuredClone(editing);
        dialog.close();
        notice('Templates saved. Existing drafts stay unchanged until reset.');
    }
    catch (error) {
        $('template-error').textContent = errorMessage(error);
    } };
    return { getTemplates: () => repository.loadTemplates() };
}

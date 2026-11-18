import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVariableInsertion} from '../app/ui/variable-insertion.mjs';

test('variables use the remembered caret/selection and never default to another template',()=>{
  let focus,warnings=[];
  const root={addEventListener(name,callback){focus=callback;},contains:field=>field.connected};
  const editor=createVariableInsertion({root,warn:message=>warnings.push(message)});
  const field={dataset:{body:'0'},connected:true,value:'Hello world',selectionStart:6,selectionEnd:11,matches:()=>true,focus(){this.focused=true;},setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;}};
  assert.equal(editor.insert('0','csv:Name'),false);assert.match(warnings[0],/Click in/);
  focus({target:field});
  focus({target:{matches:()=>false,closest:()=>({})}}); // Picker keeps the destination.
  assert.equal(editor.insert('0','csv:Name'),true);assert.equal(field.value,'Hello {{csv:Name}}');
  assert.equal(field.focused,true);
  assert.equal(editor.insert('1','csv:Email'),false);
  field.dataset={subject:'1'};field.value='Hi ';field.selectionStart=field.selectionEnd=3;
  focus({target:field});assert.equal(editor.insert('1','csv:Name'),true);assert.equal(field.value,'Hi {{csv:Name}}');
  focus({target:{matches:()=>false,closest:()=>null}});assert.equal(editor.insert('1','csv:Name'),false);
  focus({target:field});editor.reset();assert.equal(editor.insert('1','csv:Name'),false);
  focus({target:field});field.connected=false;assert.equal(editor.insert('1','csv:Name'),false);
});

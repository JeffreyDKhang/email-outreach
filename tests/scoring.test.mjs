import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,scoreLead,segmentFor,validateRules,matchesFilters} from '../app/domain/scoring.mjs';
const lead={city:'Toronto',office_employees:60,avg_daily_onsite:35,job_title:'Office Manager',purchasing_method:'manual shopping',email:'a@example.com',first_name:'Alex'};
test('agreed examples and inclusive size/attendance boundaries',()=>{
  assert.equal(scoreLead(lead).score,100);assert.equal(scoreLead({...lead,purchasing_method:'existing supplier'}).score,90);
  for(const size of [20,150])assert.equal(scoreLead({...lead,office_employees:size}).breakdown[1].points,20);
  for(const size of [10,19,151,250])assert.equal(scoreLead({...lead,office_employees:size}).breakdown[1].points,10);
  for(const size of [0,9,251])assert.equal(scoreLead({...lead,office_employees:size}).breakdown[1].points,0);
  assert.equal(scoreLead({...lead,avg_daily_onsite:14}).breakdown[2].points,10);
  assert.equal(scoreLead({...lead,avg_daily_onsite:15}).breakdown[2].points,25);
});
test('eligibility independent of score and unknown differs from zero',()=>{
  const custom={...defaults,weights:{city:0,size:40,onsite:0,role:40,purchasing:20}};
  const outside=scoreLead({...lead,city:'Ottawa'},custom);assert.equal(outside.score,100);assert.equal(outside.qualified,false);assert.equal(outside.eligibility,'Ineligible');
  assert.equal(scoreLead({...lead,avg_daily_onsite:''}).eligibility,'Needs data');
  assert.equal(scoreLead({...lead,avg_daily_onsite:0}).eligibility,'Ineligible');
  assert.equal(scoreLead({...lead,city:'',avg_daily_onsite:0}).eligibility,'Ineligible');
  assert.equal(scoreLead({...lead,office_employees:''}).breakdown[1].reason,'Unknown');
});
test('title and city normalization; unsupported roles stay unassigned',()=>{assert.equal(segmentFor('  HR   MANAGER '),'People and HR');assert.equal(segmentFor('Assistant HR Manager'),'Unassigned');assert.equal(scoreLead({...lead,city:' toronto '}).score,100);});
test('rules validate and revised weights and thresholds recalculate',()=>{
  for(const bad of [{...defaults,high:101},{...defaults,medium:80},{...defaults,cities:[]},{...defaults,cities:['Toronto',' toronto ']},{...defaults,weights:{...defaults.weights,city:-1}}])assert.throws(()=>validateRules(bad));
  const revised={...defaults,weights:{...defaults.weights,city:50},high:110};assert.equal(scoreLead(lead,revised).score,125);assert.equal(scoreLead(lead,revised).maximum,125);
});
test('all filters combine with AND including qualification and missing data',()=>{
  const result=scoreLead(lead);assert.ok(matchesFilters(lead,result,{segment:'Office operations',city:'Toronto',minimum:80,eligibility:'Eligible',qualification:'Qualified',status:'Not contacted',query:'alex'}));
  for(const f of [{segment:'People and HR'},{city:'Markham'},{minimum:101},{eligibility:'Ineligible'},{missing:true},{qualification:'Not qualified'}])assert.equal(matchesFilters(lead,result,f),false);
  const incomplete={...lead,email:''};assert.ok(matchesFilters(incomplete,scoreLead(incomplete),{missing:true}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { createFixtures } from '../fixtures.mjs';
import { makeBlindPrompt, makeGenerationPrompt } from '../providers.mjs';
import { Store } from '../store.mjs';

const providers = () => ['replay','codex','jev'].map(id => ({id,available:true,label:id}));
const original = () => createFixtures()[0].item;
const attestations = {science:true,alignment:true,originality:true,difficulty:true};
async function setup(t, extra={}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'simcc-test-'));
  const app = createApp({dataDir:directory,providerStatus:providers,...extra});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, method='GET', body, headers={}) => {
    const response = await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':app.csrfToken,...headers},...(body === undefined ? {} : {body:typeof body==='string'?body:JSON.stringify(body)})});
    const data = await response.text();return {status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(data):data,headers:response.headers};
  };
  const job = async response => {
    assert.equal(response.status,202);
    for(let i=0;i<200;i++){const result=await call('/api/jobs/'+response.data.jobId);if(['completed','failed'].includes(result.data.status))return result.data;await new Promise(r=>setTimeout(r,10));}
    throw new Error('Job did not finish');
  };
  return {...app,directory,base,call,job,id:app.store.all()[0]?.id};
}
const approve = version => ({version,action:'approved',reviewer:'Integration test reviewer',note:'Isolated test record only.',attestations});

test('approval persists, export includes current approved version, edit invalidates approval and rejects stale edits',async t=>{
  const a=await setup(t); const route='/api/records/'+a.id;
  const denied=await a.call(route+'/review','POST',{...approve(1),attestations:{}}); assert.equal(denied.status,400);
  const approved=await a.call(route+'/review','POST',approve(1)); assert.equal(approved.status,200,JSON.stringify(approved.data)); assert.equal(approved.data.record.checks.blocking,0);
  assert.equal((await a.call('/api/export')).data.records.length,1);
  assert.equal((await a.call(route+'/check','POST',{version:1})).data.record.status,'approved');
  const item=approved.data.record.item; item.answer.explanation_en+=' Review wording.';
  const edited=await a.call(route,'PUT',{version:1,item}); assert.equal(edited.status,200);assert.equal(edited.data.record.version,2);assert.equal(edited.data.record.status,'draft');assert.equal(edited.data.record.item.review_record.human_reviewer,null);
  assert.equal((await a.call('/api/export')).data.records.length,0);
  assert.equal((await a.call(route,'PUT',{version:1,item})).status,409);
  assert.equal(new Store(a.directory).get(a.id).version,2);
});

test('deliberate faults run actual checks and cannot be approved',async t=>{
  const a=await setup(t);
  for(const fixtureId of ['wrong-answer','missing-assumption','duplicate-options']){
    const job=await a.job(await a.call('/api/generate','POST',{provider:'replay',fixtureId})); assert.equal(job.status,'completed');
    const record=(await a.call('/api/records/'+job.recordId)).data.record;assert.equal(record.provenance.mode,'fixture');assert.ok(record.checks.blocking>0);
    assert.equal((await a.call('/api/records/'+record.id+'/review','POST',approve(1))).status,409);
  }
});

test('malformed edits are not persisted and HTML export escapes user text',async t=>{
  const a=await setup(t);const route='/api/records/'+a.id;
  const bad=original();bad.student_question.options={};
  assert.equal((await a.call(route,'PUT',{version:1,item:bad})).status,400);assert.equal(a.store.get(a.id).version,1);
  const item=original();item.answer.explanation_en='<script>alert(1)</script>';
  assert.equal((await a.call(route,'PUT',{version:1,item})).status,200);
  const html=await a.call(route+'/export?format=html');assert.equal(html.status,200);assert.ok(html.data.includes('&lt;script&gt;'));assert.ok(!html.data.includes('<script>'));
});

test('blind disagreement blocks approval; new content clears all model review results',async t=>{
  let prompt;
  const a=await setup(t,{runStructured:async(p,text)=>{prompt=text;return {value:{optionId:1,reasoning:'Test disagreement',issues:[]},model:'test-model',usage:null};},runJev:async()=>({provider:'jev',model:'test-model',answers:{scope:'test'}})});
  const route='/api/records/'+a.id;
  const review=await a.job(await a.call(route+'/blind-review','POST',{version:1,provider:'codex'}));assert.equal(review.status,'completed');
  assert.ok(!prompt.includes('explanation_en'));assert.ok(!prompt.includes('distractor_rationales'));
  const record=a.store.get(a.id);assert.equal(record.blindReview.agreement,false);assert.ok(record.checks.blocking>0);
  assert.equal((await a.call(route+'/review','POST',approve(1))).status,409);
  await a.job(await a.call(route+'/jev-review','POST',{version:1}));assert.ok(a.store.get(a.id).jevReview);
  const edit=await a.call(route,'PUT',{version:1,item:record.item});assert.equal(edit.status,200);assert.equal(edit.data.record.blindReview,null);assert.equal(edit.data.record.jevReview,null);
});

test('stale asynchronous model results never attach to a newer version',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const a=await setup(t,{runStructured:()=>pending});const route='/api/records/'+a.id;
  const started=await a.call(route+'/blind-review','POST',{version:1,provider:'codex'});
  assert.equal((await a.call(route,'PUT',{version:1,item:original()})).status,200);
  release({value:{optionId:3,reasoning:'Late test result',issues:[]},model:'test',usage:null});
  assert.equal((await a.job(started)).status,'failed');assert.equal(a.store.get(a.id).blindReview,null);
});

test('live failures never substitute a replay, and successful live calls receive actual provenance',async t=>{
  let fail=true;
  const a=await setup(t,{runStructured:async()=>{if(fail)throw new Error('secret diagnostic should be private');return {value:original(),model:'actual-test-model',usage:{tokens:12},durationMs:5};}});
  const before=a.store.all().length;
  const failed=await a.job(await a.call('/api/generate','POST',{provider:'codex'}));assert.equal(failed.status,'failed');assert.ok(!failed.error.includes('secret'));assert.equal(a.store.all().length,before);
  fail=false;const succeeded=await a.job(await a.call('/api/generate','POST',{provider:'codex'}));assert.equal(succeeded.status,'completed',JSON.stringify(succeeded));
  const record=a.store.get(succeeded.recordId);assert.equal(record.provenance.mode,'live');assert.equal(record.provenance.model,'actual-test-model');assert.equal(record.item.review_record.human_reviewer,null);assert.equal(record.item.review_record.ready_for_live_assessment,false);assert.ok(record.item.generation_record.generator.includes('actual-test-model'));
});

test('local API rejects hostile origins, hosts, missing CSRF, invalid JSON and oversized requests',async t=>{
  const a=await setup(t);
  assert.equal((await a.call('/api/bootstrap','GET',undefined,{Origin:'https://evil.example'})).status,403);
  const hostileHostStatus = await new Promise((resolve,reject)=>{http.get(a.base+'/api/bootstrap',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(hostileHostStatus,403);
  assert.equal((await a.call('/api/generate','POST',{}, {'X-CSRF-Token':''})).status,403);
  assert.equal((await a.call('/api/generate','POST','{')).status,400);
  assert.equal((await a.call('/api/generate','POST',{padding:'a'.repeat(210000)})).status,413);
  assert.equal((await a.call('/data/records.json')).status,404);
  assert.equal((await a.call('/api/generate','POST',{provider:'not-supported'})).status,400);
});

test('corrupt persisted data fails loudly and is never replaced with a new seed',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'simcc-corrupt-'));const file=path.join(directory,'records.json');
  try{fs.writeFileSync(file,'{broken');assert.throws(()=>createApp({dataDir:directory}),/not overwritten/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');}finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('blind prompt hides key and generation prompt declares constrained template',()=>{
  const item=original();item.answer.explanation_en='SECRET_ANSWER_SENTINEL';item.distractor_rationales[0].issue='SECRET_DISTRACTOR';
  assert.ok(!makeBlindPrompt(item,{objectives:[]}).includes('SECRET_'));
  assert.match(makeGenerationPrompt({}, {}, item),/EXACTLY/);
});

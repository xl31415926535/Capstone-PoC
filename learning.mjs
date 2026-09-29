import { randomUUID, randomInt } from 'node:crypto';
import { AppError } from './store.mjs';
export const difficulties=['Easy','Medium','Hard'];
export const issueCodes=['scientific_error','ambiguous','superficial_rewrite','curriculum','difficulty','language','other'];
export function labelsFor(record) {
  return record.labels || {difficulty:difficulties.includes(record.item.difficulty_estimate)?record.item.difficulty_estimate:record.item.difficulty_target,objectives:record.item.syllabus_mapping.filter(m=>m.internal_mapping_id?.startsWith('P5-')).map(m=>m.internal_mapping_id),skill:record.item.skill,reviewed:false};
}
export const eligible = r=>r.status==='approved'&&r.checks?.blocking===0;
export function evaluationReport(batch, records) {
  const rows=batch.entries.map(entry=>{
    const record=records.find(r=>r.id===entry.recordId);
    const decisions=record?.reviewEvents.filter(e=>e.version===record.version&&['approved','changes_requested','rejected'].includes(e.action))||[];
    const decision=decisions.at(-1);
    return {...entry,title:record?.title||entry.title||'Generation failed',family:record?.item.question_family||entry.family,status:record?.status||'failed',version:record?.version||null,currentBlocking:record?.checks.blocking??null,decision:decision?.action||null,reviewSeconds:decision?.reviewSeconds??null,issueCodes:decision?.issueCodes||[],labels:record?labelsFor(record):null};
  });
  const stored=rows.filter(r=>r.recordId),reviewed=rows.filter(r=>r.decision),approved=reviewed.filter(r=>r.decision==='approved'&&r.status==='approved'&&r.currentBlocking===0);
  const timed=reviewed.filter(r=>Number.isFinite(r.reviewSeconds)),approvedTimed=approved.filter(r=>Number.isFinite(r.reviewSeconds));
  return {...batch,rows,metrics:{requested:batch.plan.length,generated:stored.length,generationFailed:rows.filter(r=>!r.recordId).length,localPass:stored.filter(r=>r.initialLocalBlocking===0).length,blindCompleted:stored.filter(r=>r.initialBlindAgreement!==undefined).length,blindAgreed:stored.filter(r=>r.initialBlindAgreement===true).length,humanReviewed:reviewed.length,humanApproved:approved.length,humanAcceptanceRate:reviewed.length?approved.length/reviewed.length:null,averageReviewSeconds:timed.length?timed.reduce((s,r)=>s+r.reviewSeconds,0)/timed.length:null,reviewSecondsPerApproved:approved.length&&timed.length===reviewed.length?timed.reduce((s,r)=>s+r.reviewSeconds,0)/approved.length:null,approvedTimedCount:approvedTimed.length,reviewTimeSamples:timed.length},definitions:{humanAcceptanceRate:'Approved current versions / current versions with a recorded human decision. Unreviewed items are excluded; this is not a scientific accuracy estimate.',localPass:'Initial schema/rule checks only. Does not include the required blind-review gate and does not certify science.',reviewTime:'Reviewer-reported active minutes, converted to seconds; not automatically measured wall-clock time.',limitations:'No teacher calibration, real pupil trial, global originality check or cross-provider independence is implied.'}};
}
export function createPracticeService(store,fixtures) {
  const sessions=new Map();
  const activeBank=()=>store.all().filter(eligible);
  const publicQuestion=r=>({id:r.id,version:r.version,title:r.title,grade:r.item.grade,topic:r.item.topic,labels:labelsFor(r),question:r.item.student_question});
  function config(){const records=activeBank();return {available:records.length,difficulties:[...new Set(records.map(r=>labelsFor(r).difficulty))],objectives:[...new Set(records.flatMap(r=>labelsFor(r).objectives))],skills:[...new Set(records.map(r=>labelsFor(r).skill))]};}
  function start(body){
    for(const [id,s] of sessions)if(Date.now()-s.createdAt>3600000)sessions.delete(id);
    if(sessions.size>=100)throw new AppError('Too many practice sessions; retry after older sessions expire.',429);
    const count=body.count??5;if(!Number.isInteger(count)||count<1||count>10)throw new AppError('Practice quantity must be 1–10.');
    const demo=body.demo===true;
    let records=demo?[{id:'recorded-practice-demo',version:1,title:'Unreviewed demonstration — not the approved bank',item:fixtures.find(f=>f.id==='original').item}]:activeBank().filter(r=>{const l=labelsFor(r);return (!body.difficulty||l.difficulty===body.difficulty)&&(!body.objective||l.objectives.includes(body.objective))&&(!body.skill||l.skill===body.skill);});
    if(!records.length)throw new AppError('No approved questions match these filters. Ask a reviewer to approve items first.',404,'EMPTY_BANK');
    for(let i=records.length-1;i>0;i--){const j=randomInt(i+1);[records[i],records[j]]=[records[j],records[i]];}
    records=records.slice(0,count);
    const id=randomUUID();sessions.set(id,{records,createdAt:Date.now(),demo,result:null,answers:null});
    return {sessionId:id,demo,label:demo?'Unreviewed recorded demonstration. This session is separate from the approved bank.':'Practice from approved current versions.',requested:count,returned:records.length,questions:records.map(publicQuestion)};
  }
  function submit(id,body){
    const session=sessions.get(id);if(!session||Date.now()-session.createdAt>3600000)throw new AppError('Practice session expired. Start again.',410);
    const answers=body.answers;if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length!==session.records.length)throw new AppError('Answer every question once.');
    for(const record of session.records)if(!record.item.student_question.options.some(o=>o.id===answers[record.id]))throw new AppError('Select a valid option for every question.');
    if(!session.demo)for(const record of session.records){const current=store.get(record.id);if(!eligible(current)||current.version!==record.version)throw new AppError('A question was revised or withdrawn. Start a fresh practice session.',409,'PRACTICE_STALE');}
    if(session.result){if(session.records.some(r=>answers[r.id]!==session.answers[r.id]))throw new AppError('This attempt is already submitted. Start a new session.',409);return session.result;}
    const items=session.records.map(r=>({id:r.id,selected:answers[r.id],correct:answers[r.id]===r.item.answer.option_id,answer:r.item.answer,steps:r.item.solution_steps||[],distractors:r.item.distractor_rationales,labels:labelsFor(r)}));
    const right=items.filter(i=>i.correct).length;
    session.answers=structuredClone(answers);session.result={demo:session.demo,correct:right,total:items.length,marks:right*2,maxMarks:items.length*2,items,practiceAgainObjectives:[...new Set(items.filter(i=>!i.correct).flatMap(i=>i.labels.objectives))]};return session.result;
  }
  return {config,start,submit};
}

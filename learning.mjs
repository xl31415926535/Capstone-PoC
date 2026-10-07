import { randomUUID, randomInt } from 'node:crypto';
import { AppError } from './store.mjs';
import { pupilFigure } from './circuit.mjs';
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
  const overlaps=stored.filter(r=>Number.isFinite(r.initialSourceOverlap)).map(r=>r.initialSourceOverlap);
  const blindProvider=batch.blindProvider||batch.provider;
  return {...batch,rows,metrics:{requested:batch.plan.length,sourceCompared:overlaps.length,sourceClose:stored.filter(r=>['warn','fail'].includes(r.initialSourceStatus)).length,sourceBlocked:stored.filter(r=>r.initialSourceStatus==='fail').length,meanSourceOverlap:overlaps.length?overlaps.reduce((s,x)=>s+x,0)/overlaps.length:null,maxSourceOverlap:overlaps.length?Math.max(...overlaps):null,generated:stored.length,generationFailed:rows.filter(r=>!r.recordId).length,localPass:stored.filter(r=>r.initialLocalBlocking===0).length,blindCompleted:stored.filter(r=>r.initialBlindAgreement!==undefined).length,blindAgreed:stored.filter(r=>r.initialBlindAgreement===true).length,humanReviewed:reviewed.length,humanApproved:approved.length,humanAcceptanceRate:reviewed.length?approved.length/reviewed.length:null,averageReviewSeconds:timed.length?timed.reduce((s,r)=>s+r.reviewSeconds,0)/timed.length:null,reviewSecondsPerApproved:approved.length&&timed.length===reviewed.length?timed.reduce((s,r)=>s+r.reviewSeconds,0)/approved.length:null,approvedTimedCount:approvedTimed.length,reviewTimeSamples:timed.length},definitions:{humanAcceptanceRate:'Approved current versions / current versions with a recorded human decision. Unreviewed items are excluded; this is not a scientific accuracy estimate.',localPass:'Initial schema/rule checks only. Does not include the required blind-review gate and does not certify science.',reviewTime:'Reviewer-reported active minutes, converted to seconds; not automatically measured wall-clock time.',sourceOverlap:'Share of word pairs a draft repeats from its closest source-bank question when it was generated (labels and numbers masked). Close: 35% or more; blocked: 60% or more.',blindIndependence:blindProvider===batch.provider?'The blind solve used the same provider as the generator, so agreement is not an independent check.':`The blind solve used ${blindProvider}, a different provider from the generator (${batch.provider}).`,limitations:'No teacher calibration, real pupil trial or global originality check is implied.'}};
}
// The retrieval pilot: runs pooled by condition (with or without source
// questions in the prompt). Runs still in progress are left out.
export function compareConditions(reports) {
  const finished=reports.filter(r=>!['queued','running'].includes(r.status));
  return [false,true].map(enabled=>{
    const runs=finished.filter(r=>Boolean(r.retrieval?.enabled)===enabled);
    const sum=key=>runs.reduce((s,r)=>s+(r.metrics[key]||0),0);
    const rows=runs.flatMap(r=>r.rows.filter(x=>x.recordId));
    const overlaps=rows.map(x=>x.initialSourceOverlap).filter(Number.isFinite);
    const timed=rows.filter(x=>x.decision&&Number.isFinite(x.reviewSeconds));
    const issues=Object.fromEntries(issueCodes.map(code=>[code,rows.filter(x=>x.decision&&x.issueCodes.includes(code)).length]));
    const reviewed=sum('humanReviewed'),approved=sum('humanApproved');
    return {retrieval:enabled,runs:runs.length,requested:sum('requested'),generated:sum('generated'),localPass:sum('localPass'),blindCompleted:sum('blindCompleted'),blindAgreed:sum('blindAgreed'),humanReviewed:reviewed,humanApproved:approved,humanAcceptanceRate:reviewed?approved/reviewed:null,averageReviewSeconds:timed.length?timed.reduce((s,x)=>s+x.reviewSeconds,0)/timed.length:null,sourceCompared:overlaps.length,sourceClose:sum('sourceClose'),sourceBlocked:sum('sourceBlocked'),meanSourceOverlap:overlaps.length?overlaps.reduce((s,x)=>s+x,0)/overlaps.length:null,issues};
  });
}
// Difficulty calibration from anonymous practice responses. A band needs at
// least minResponses answers to the same question version.
export const CALIBRATION={minResponses:20,easy:0.8,medium:0.5,weakDistractor:0.05};
const wilson=(k,n,z=1.96)=>{if(!n)return null;const p=k/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));return [Math.max(0,(c-m)/d),Math.min(1,(c+m)/d)];};
export const pupilBand=p=>p>=CALIBRATION.easy?'Easy':p>=CALIBRATION.medium?'Medium':'Hard';
export function calibrationReport(records,sessions) {
  const groups=new Map();
  for(const session of sessions)for(const answer of session.items) {
    const key=answer.recordId+'@'+answer.recordVersion;
    if(!groups.has(key))groups.set(key,{recordId:answer.recordId,version:answer.recordVersion,keyed:answer.keyed,n:0,correct:0,counts:{}});
    const g=groups.get(key);g.n++;g.correct+=answer.correct?1:0;g.counts[answer.selected]=(g.counts[answer.selected]||0)+1;
  }
  const questions=[...groups.values()].map(g=>{
    const record=records.find(r=>r.id===g.recordId),current=record?.version===g.version,p=g.correct/g.n,enough=g.n>=CALIBRATION.minResponses;
    const optionIds=current?record.item.student_question.options.map(o=>o.id):[1,2,3,4];
    const options=optionIds.map(id=>({id,text:current?record.item.student_question.options.find(o=>o.id===id).text:null,count:g.counts[id]||0,share:(g.counts[id]||0)/g.n,keyed:id===g.keyed}));
    const label=current?labelsFor(record).difficulty:null,band=enough?pupilBand(p):null,flags=[];
    if(!enough)flags.push({code:'few_responses',severity:'info',detail:`${g.n} of the ${CALIBRATION.minResponses} responses needed before a difficulty band is shown.`});
    else {
      if(label&&band!==label)flags.push({code:'label_differs',severity:'warn',detail:`Pupils found it ${band} (${Math.round(p*100)}% correct) but it is labelled ${label}. A reviewer can correct the label.`});
      const key=options.find(o=>o.keyed);
      for(const o of options.filter(o=>!o.keyed)) {
        if(o.count>(key?.count||0))flags.push({code:'distractor_beats_key',severity:'warn',detail:`More pupils chose option ${o.id} (${o.count}) than the key, option ${g.keyed} (${key?.count||0}). Check the key and the wording.`});
        else if(o.share<CALIBRATION.weakDistractor)flags.push({code:'weak_distractor',severity:'info',detail:`Option ${o.id} was chosen by ${o.count} of ${g.n} pupils, so it may not be a plausible wrong answer.`});
      }
    }
    return {recordId:g.recordId,title:record?.title||'Question no longer in the bank',version:g.version,current,status:record?.status||null,n:g.n,correct:g.correct,p,interval:wilson(g.correct,g.n),band,label,agreement:band&&label?band===label:null,options,flags};
  }).sort((a,b)=>b.n-a.n||a.title.localeCompare(b.title));
  return {sessions:sessions.length,responses:sessions.reduce((s,x)=>s+x.items.length,0),thresholds:CALIBRATION,definitions:{p:'Share of pupils who chose the key for this question version.',interval:'95% Wilson interval for that share.',band:`Easy at ${CALIBRATION.easy*100}% correct or more, Medium from ${CALIBRATION.medium*100}%, Hard below; shown once a version has ${CALIBRATION.minResponses} responses.`,privacy:'Each response holds the question id and version, the chosen option and whether it was correct. No names, accounts or device details are stored. Demo answers are not saved.'},questions};
}
export function createPracticeService(store,fixtures,responses=null) {
  const sessions=new Map();
  const activeBank=()=>store.all().filter(eligible);
  const publicQuestion=r=>({id:r.id,version:r.version,title:r.title,grade:r.item.grade,topic:r.item.topic,labels:labelsFor(r),question:r.item.student_question.figure?{...r.item.student_question,figure:pupilFigure(r.item.student_question.figure)}:r.item.student_question});
  function config(){const records=activeBank();return {available:records.length,difficulties:[...new Set(records.map(r=>labelsFor(r).difficulty))],objectives:[...new Set(records.flatMap(r=>labelsFor(r).objectives))],skills:[...new Set(records.map(r=>labelsFor(r).skill))]};}
  function start(body){
    for(const [id,s] of sessions)if(Date.now()-s.createdAt>3600000)sessions.delete(id);
    if(sessions.size>=100)throw new AppError('Too many practice sessions; retry after older sessions expire.',429);
    const count=body.count??5;if(!Number.isInteger(count)||count<1||count>10)throw new AppError('Practice quantity must be 1–10.');
    const demo=body.demo===true;
    let records=demo?[{id:'recorded-practice-demo',version:1,title:'Unreviewed demonstration — not the approved bank',item:fixtures.find(f=>f.id==='original').item},{id:'constructed-circuit-demo',version:1,title:'Unreviewed demonstration with a circuit diagram',item:fixtures.find(f=>f.id==='circuit-switch').item}]:activeBank().filter(r=>{const l=labelsFor(r);return (!body.difficulty||l.difficulty===body.difficulty)&&(!body.objective||l.objectives.includes(body.objective))&&(!body.skill||l.skill===body.skill);});
    if(!records.length)throw new AppError('No approved questions match these filters. Ask a reviewer to approve items first.',404,'EMPTY_BANK');
    if(!demo)for(let i=records.length-1;i>0;i--){const j=randomInt(i+1);[records[i],records[j]]=[records[j],records[i]];}
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
    // Approved questions only: keep an anonymous response for difficulty calibration.
    let responseSaved=false;
    if(!session.demo&&responses)try{responses.add({id:randomUUID(),version:1,at:new Date().toISOString(),items:session.records.map(r=>({recordId:r.id,recordVersion:r.version,selected:answers[r.id],keyed:r.item.answer.option_id,correct:answers[r.id]===r.item.answer.option_id}))});responseSaved=true;}catch{}
    session.answers=structuredClone(answers);session.result={demo:session.demo,correct:right,total:items.length,marks:right*2,maxMarks:items.length*2,items,practiceAgainObjectives:[...new Set(items.filter(i=>!i.correct).flatMap(i=>i.labels.objectives))],responseSaved};return session.result;
  }
  return {config,start,submit};
}

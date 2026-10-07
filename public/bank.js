'use strict';
// Source bank and syllabus coverage pages (data from /api/bank and /api/coverage).
const bankState={info:null,list:null,filters:{q:'',topic:'',level:'',flag:''},offset:0,selectedId:null,question:null,coverage:null,loading:false,error:null,reviewer:'',reason:''};
const TAG_STATUS={suggested:['not_run','Keyword suggestion'],draft:['draft','Curated, awaiting a teacher'],confirmed:['pass','Confirmed by a reviewer'],rejected:['fail','Rejected by a reviewer']};
const FLAG_LABELS={no_answer:'No answer key',answer_not_in_options:'Key is not an option',few_options:'Too few options',option_noise:'Page text in options',garbled_text:'Damaged text',may_depend_on_image:'Refers to a figure',excluded_content:'Not-required wording'};
const LEVEL_LABELS={primary:'Primary',secondary:'Secondary',mixed:'Mixed levels',unknown:'Level unknown'};
const ANSWER_SOURCES={official_key:'answer key published with the paper',author_key:'key set by the question authors',inferred:'inferred key, not from an official source'};
const PAGE_SIZE=25;
const bankTopics=()=>bankState.info?.syllabus?.topics||[];
const topicName=id=>bankTopics().find(t=>t.id===id)?.label||id;
const tagLabel=(kind,id)=>kind==='topic'?`${topicName(id)} · ${bankTopics().find(t=>t.id===id)?.level||''}`:id.replace('P5-SYSTEMS-ELECTRICAL-','P5 Electrical system · ');

async function loadBankInfo(){try{bankState.info=await api('/api/bank');}catch(error){bankState.info={available:false,reason:error.message};}}
async function loadBankList(){
 bankState.loading=true;bankState.error=null;render();
 try{
  if(!bankState.info)await loadBankInfo();
  if(bankState.info.available){
   const params=new URLSearchParams({...Object.fromEntries(Object.entries(bankState.filters).filter(([,v])=>v)),limit:PAGE_SIZE,offset:bankState.offset});
   bankState.list=await api('/api/bank/questions?'+params);
   if(!bankState.list.questions.some(q=>q.id===bankState.selectedId)){bankState.selectedId=bankState.list.questions[0]?.id??null;bankState.question=null;}
   if(bankState.selectedId&&bankState.question?.id!==bankState.selectedId)bankState.question=(await api(`/api/bank/questions/${bankState.selectedId}`)).question;
  }
 }catch(error){bankState.error=error.message;}
 finally{bankState.loading=false;render();}
}
async function selectBankQuestion(id){bankState.selectedId=id;bankState.error=null;try{bankState.question=(await api(`/api/bank/questions/${id}`)).question;}catch(error){bankState.error=error.message;}render();$(`[data-bank-question="${id}"]`)?.focus({preventScroll:true});}
async function loadCoverage(){bankState.loading=true;render();try{if(!bankState.info)await loadBankInfo();bankState.coverage=await api('/api/coverage');}catch(error){bankState.error=error.message;}finally{bankState.loading=false;render();}}

function bankUnavailable(info){return `<div class="panel"><div class="empty-state"><div class="empty-illustration">${icon('bank')}</div><h2>No source bank loaded</h2><p>${e(info.reason||'The source bank is not available.')}</p>${info.hint?`<p>${e(info.hint)}</p>`:''}<p class="tiny">node scripts/import-bank.mjs --sources examples/bank-sample</p></div></div>`;}
function bankBanner(info){const c=info.counts;return `<div class="scope-strip">${icon('bank')}<div><strong>${e(info.label)}</strong><p>${e(info.notice)}</p></div><div class="scope-pills"><span>${e(c.questions)} questions</span><span>${e(c.primary)} primary level</span><span>${e(c.withKey)} with a key</span><span>${e(c.pilot)} on P5 electricity</span><span>${e(c.withFigure)} with figures</span></div></div>`;}
function libraryPage(){
 const info=bankState.info,head=heading('GROUNDED IN REAL QUESTIONS','Source question bank','Questions from past papers and olympiads, stored with their source, tagged to the 2023 syllabus and checked for extraction damage. Keyword tags are suggestions until a reviewer confirms them.');
 if(!info)return head+'<div class="notice job" role="status"><span class="spinner"></span><div>Loading the source bank…</div></div>';
 if(!info.available)return head+bankUnavailable(info);
 const list=bankState.list,f=bankState.filters,q=bankState.question;
 const items=list?.questions.map(x=>`<button class="record-list-item ${x.id===bankState.selectedId?'selected':''}" data-bank-question="${e(x.id)}"><strong>${e(x.provider)} · ${e(x.gradeScope)} · Q${e(x.number)}</strong><small>${e(x.stem)}</small><span class="bank-chips"><span class="metadata-tag">${e(LEVEL_LABELS[x.level]||x.level)}</span>${x.topics.slice(0,1).map(t=>`<span class="metadata-tag">${e(topicName(t.id))}</span>`).join('')}${x.assets?'<span class="metadata-tag">Figure</span>':''}${x.flags.filter(fl=>fl.severity==='warn').length?`<span class="metadata-tag warn-tag">${e(x.flags.filter(fl=>fl.severity==='warn').length)} warning${x.flags.filter(fl=>fl.severity==='warn').length===1?'':'s'}</span>`:''}</span></button>`).join('')||'<p class="list-empty">No source question matches these filters.</p>';
 const select=(id,label,value,options)=>`<label class="sr-only" for="${id}">${label}</label><select id="${id}">${options.map(([v,l])=>`<option value="${e(v)}" ${v===value?'selected':''}>${e(l)}</option>`).join('')}</select>`;
 const pager=list&&list.total>PAGE_SIZE?`<div class="bank-pager"><button class="ghost" data-bank-page="-1" ${bankState.offset===0?'disabled':''}>Previous</button><small>${e(bankState.offset+1)}–${e(Math.min(bankState.offset+PAGE_SIZE,list.total))} of ${e(list.total)}</small><button class="ghost" data-bank-page="1" ${bankState.offset+PAGE_SIZE>=list.total?'disabled':''}>Next</button></div>`:'';
 return head+bankBanner(info)+(bankState.error?`<div class="notice error" role="alert">${e(bankState.error)}</div>`:'')+`<div class="queue-layout bank-layout"><section class="panel records-panel"><div class="panel-head"><h2>Source questions</h2><small>${list?`${e(list.total)} found`:'Loading…'}</small></div><form id="bank-search" class="bank-filters" role="search"><label class="sr-only" for="bank-q">Search the stems and options</label><input id="bank-q" type="search" maxlength="200" placeholder="Search, e.g. bulbs series" value="${e(f.q)}">${select('bank-topic','Syllabus topic',f.topic,[['','All topics'],...bankTopics().map(t=>[t.id,`${t.level} · ${t.label}`])])}${select('bank-level','Level',f.level,[['','All levels'],...Object.entries(LEVEL_LABELS)])}${select('bank-flag','Quality',f.flag,[['','Any quality'],['clean','No warnings'],['figure','Has a figure'],...Object.entries(FLAG_LABELS)])}<button class="secondary" type="submit" ${bankState.loading?'disabled':''}>Search</button></form><div class="records-list">${items}</div>${pager}</section><section class="panel">${q?bankQuestionView(q):`<div class="empty-state"><div class="empty-illustration">${icon('sources')}</div><h2>Select a source question</h2><p>Its source, syllabus tags, figures and quality flags appear here.</p></div>`}</section></div>`;
}

function bankFigures(q){return q.assets.map(a=>{
 if(a.kind==='figure_image')return `<figure class="bank-figure"><img src="${e(a.url)}" alt="Figure for question ${e(q.number)} as printed in the source${a.page?`, page ${e(a.page)}`:''}"><figcaption>${e(a.note)}</figcaption></figure>`;
 let svg='';try{svg=window.SimccCircuit.renderFigureSvg(a.figure);}catch{svg='<p class="model-note">The structured circuit could not be drawn.</p>';}
 const verdict={pass:'The solver agrees with the key',fail:'The solver disagrees with the key',not_run:'Solved, but not a machine-checkable question type'}[a.checkStatus]||'Not checked';
 return `<figure class="circuit-figure">${svg}<figcaption>${e(a.note)}</figcaption></figure><div class="check-row"><span class="check-symbol ${e(a.checkStatus)}">${icon(a.checkStatus==='pass'?'check':a.checkStatus==='fail'?'cross':'info')}</span><div class="check-body"><strong>${e(verdict)}</strong><p>${e(a.checkDetail)}</p></div>${badge(a.checkStatus)}</div>`;
}).join('');}
function bankTagRows(q){
 const rows=[...q.topics.map(t=>({...t,kind:'topic',title:tagLabel('topic',t.id),text:''})),...q.outcomes.map(o=>({...o,kind:'outcome',title:tagLabel('outcome',o.id),text:o.text?`${o.text} (syllabus p.${o.page})`:''}))];
 if(!rows.length)return '<p class="model-note">No syllabus topic matched. Add one below if the question belongs to the 2023 syllabus.</p>';
 return rows.map(r=>{const [cls,label]=TAG_STATUS[r.status]||['not_run',r.status];return `<div class="check-row tag-row"><div class="check-body"><strong>${e(r.title)}</strong>${r.text?`<p>${e(r.text)}</p>`:''}<p>${e(r.evidence)}${r.method==='keyword'?' · keyword match':r.method==='curated'?' · tagged by the project team':' · added by a reviewer'}</p></div>${badge(cls,label)}<div class="tag-actions"><button class="ghost" data-tag-action="confirm" data-tag="${e(r.kind+':'+r.id)}" ${r.status==='confirmed'?'disabled':''}>Confirm</button><button class="ghost" data-tag-action="reject" data-tag="${e(r.kind+':'+r.id)}" ${r.status==='rejected'?'disabled':''}>Reject</button></div></div>`;}).join('');
}
function bankQuestionView(q){
 const key=q.correctOption,enrich=q.enrichment,doc=q.document;
 const addable=[...bankTopics().filter(t=>!q.topics.some(x=>x.id===t.id)).map(t=>['topic:'+t.id,`Topic · ${t.level} · ${t.label}`]),...(bankState.info.syllabus?.pilotOutcomes||[]).filter(o=>!q.outcomes.some(x=>x.id===o.id)).map(o=>['outcome:'+o.id,`P5 electricity outcome · ${o.text}`])];
 return `<div class="record-head"><div class="record-topline"><span class="eyebrow">${q.profile.origin==='curated'?'CURATED SOURCE':'IMPORTED SOURCE'} · ${e(LEVEL_LABELS[q.profile.level]||q.profile.level)}</span>${q.answerSource==='inferred'?badge('warn','Inferred key'):''}</div><div class="record-title-row"><div><h2>${e(q.provider)} · Q${e(q.number)}</h2><p>${e(q.competition)} · ${e(q.gradeScope)}${q.section?` · ${e(q.section)}`:''}${q.profile.page?` · page ${e(q.profile.page)}`:''}</p></div></div></div>
 <div class="record-content"><p class="question-stem">${e(q.stem)}</p>${bankFigures(q)}<div class="options">${Object.entries(q.options).map(([k,v])=>`<div class="option ${k===key?'keyed':''}"><span class="option-id">${e(k)}</span><span>${e(v)}</span>${k===key?`<span class="sr-only">(key)</span>`:''}</div>`).join('')}</div><p class="model-note bank-key">${key?`Key: ${e(key)} · ${e(ANSWER_SOURCES[q.answerSource]||'answer key from the imported database')}`:'The source gives no answer key.'}</p>${q.explanation?`<div class="answer-content"><strong>Explanation</strong>${e(q.explanation)}</div>`:''}
 <section class="evidence-section"><div class="section-heading"><div><h3>Syllabus tags</h3><p>2023 primary science syllabus. A reviewer's decision is kept when the bank is rebuilt.</p></div></div>${bankTagRows(q)}<form id="tag-review" class="tag-review"><div class="field"><label for="tag-reviewer">Reviewer name</label><input id="tag-reviewer" maxlength="120" autocomplete="name" value="${e(bankState.reviewer)}" placeholder="Your name"></div><div class="field"><label for="tag-reason">Reason</label><input id="tag-reason" maxlength="1000" value="${e(bankState.reason)}" placeholder="What did you check?"></div><div class="field"><label for="tag-add">Add a tag</label><select id="tag-add"><option value="">Choose a topic or outcome</option>${addable.map(([v,l])=>`<option value="${e(v)}">${e(l)}</option>`).join('')}</select></div><button class="secondary" type="submit">${icon('check')}Add and confirm</button></form></section>
 <section class="evidence-section"><div class="section-heading"><h3>Quality flags</h3></div>${q.flags.map(f=>`<div class="check-row"><span class="check-symbol ${f.severity==='warn'?'warn':''}">${icon('info')}</span><div class="check-body"><strong>${e(FLAG_LABELS[f.code]||f.code)}</strong><p>${e(f.detail)}</p></div>${badge(f.severity==='warn'?'warn':'not_run',f.severity==='warn'?'Warning':'Note')}</div>`).join('')||'<p class="model-note">No extraction or scope warnings.</p>'}</section>
 <section class="evidence-section"><div class="section-heading"><h3>Source</h3></div><div class="source-item">${doc.landingUrl?sourceLink(doc.landingUrl,q.provider+' · '+q.competition):`<strong>${e(q.provider)} · ${e(q.competition)}</strong>`}<p>${e(doc.attribution)}</p><p>Provenance: ${e(q.provenanceStatus)} · ${e(doc.pageCount)} page${doc.pageCount===1?'':'s'} · extracted ${e(doc.extractedAt)}</p></div>
 <details class="answer-details"><summary>Fields for the practice UI (Utkarsh's schema)</summary><div class="table-scroll"><table class="compact-table"><tbody>${Object.entries(enrich).map(([k,v])=>`<tr><th>${e(k)}</th><td>${v===null||v===undefined?'<span class="tiny">empty</span>':e(v)}</td></tr>`).join('')}</tbody></table></div></details>
 <details class="answer-details"><summary>Text as extracted</summary><pre class="model-result bank-raw">${e(q.rawChunk)}</pre></details>
 ${q.reviews.length?`<details class="answer-details" open><summary>Review history</summary><ol class="review-history">${q.reviews.map(r=>`<li class="review-event"><strong>${e(r.action==='confirm'?'Confirmed':'Rejected')} ${e(r.target.replace(/^(topic|outcome):/,''))}</strong><small>${e(r.reviewer)} · ${e(formatDate(r.at))}${r.carried_from?` · carried over from ${e(r.carried_from)}`:''}</small><p>${e(r.note)}</p></li>`).join('')}</ol></details>`:''}</section></div>`;
}

function coveragePage(){
 const head=heading('SYLLABUS COVERAGE','Where the sources and drafts are','All 18 topics of the 2023 primary science syllabus. Source counts come from the source bank (keyword suggestions, curated tags and confirmed tags); generated counts come from this workspace.');
 const c=bankState.coverage;
 if(!c)return head+(bankState.error?`<div class="notice error" role="alert">${e(bankState.error)}</div>`:'<div class="notice job" role="status"><span class="spinner"></span><div>Counting sources and drafts…</div></div>');
 const pilot=c.topics.find(t=>t.id===c.pilotTopic),total=s=>s.suggested+s.draft+s.confirmed;
 const max=Math.max(1,...c.topics.map(t=>total(t.sources)));
 const sourceCell=s=>total(s)?`<strong>${e(total(s))}</strong> <span class="tiny">${e(s.confirmed)} confirmed · ${e(s.draft)} curated · ${e(s.suggested)} suggested</span>`:'<span class="tiny">none</span>';
 return head+(c.bank?'':`<div class="notice warning">No source bank is loaded, so source counts are empty. ${e(c.bankStatus?.reason||'')}</div>`)+`<section class="panel coverage-panel"><div class="panel-head"><h2>Pilot topic · ${e(pilot.label)} (P5 Standard, syllabus p.${e(pilot.pages[0])})</h2><small>${e(pilot.outcomeRows.length)} outcomes</small></div><div class="table-scroll"><table class="compact-table coverage-table"><caption class="sr-only">Pilot outcomes with source questions and generated drafts</caption><thead><tr><th>Outcome</th><th>Pilot objective</th><th>Source questions</th><th>Primary level</th><th>Generated drafts</th></tr></thead><tbody>${pilot.outcomeRows.map(o=>`<tr><td><strong>${e(o.id.replace('P5-SYSTEMS-ELECTRICAL-',''))}</strong> ${e(o.text)}${o.points.length?`<br><span class="tiny">${e(o.points.join('; '))}</span>`:''}</td><td>${o.objective?e(o.objective):`<span class="tiny">${o.excludedFromPilot?'Not assessed by MCQ in the pilot':'Not in the pilot'}</span>`}</td><td>${sourceCell(o.sources)}</td><td>${e(o.sources.primary)}</td><td>${o.objective?`<strong>${e(o.generated.total)}</strong> <span class="tiny">${e(o.generated.approved)} approved</span>`:'<span class="tiny">—</span>'}</td></tr>`).join('')}</tbody></table></div></section>
 <section class="panel coverage-panel"><div class="panel-head"><h2>All topics</h2><small>${e(c.topics.length)} topics · P3–P6</small></div><div class="table-scroll"><table class="compact-table coverage-table"><caption class="sr-only">Source questions per syllabus topic</caption><thead><tr><th>Theme</th><th>Topic</th><th>Outcomes</th><th>"Not required" notes</th><th>Source questions</th><th>Primary level</th><th aria-hidden="true"></th></tr></thead><tbody>${c.themes.flatMap(theme=>c.topics.filter(t=>t.theme===theme).map((t,i)=>`<tr class="${t.id===c.pilotTopic?'pilot-row':''}"><td>${i===0?e(theme):''}</td><td><strong>${e(t.level)}</strong> ${e(t.label)}${t.id===c.pilotTopic?' <span class="metadata-tag">Pilot</span>':''}</td><td>${e(t.outcomes)}</td><td>${e(t.exclusions)}</td><td>${sourceCell(t.sources)}</td><td>${e(t.sources.primary)}</td><td aria-hidden="true"><span class="coverage-bar"><span style="width:${Math.round(100*total(t.sources)/max)}%"></span></span></td></tr>`)).join('')}</tbody></table></div></section>`;
}

function bindBank(){
 if(state.page==='library'&&!bankState.list&&!bankState.loading&&!bankState.error)loadBankList();
 if(state.page==='coverage'&&!bankState.coverage&&!bankState.loading&&!bankState.error)loadCoverage();
 $('#bank-search')?.addEventListener('submit',event=>{event.preventDefault();bankState.filters={q:$('#bank-q').value.trim(),topic:$('#bank-topic').value,level:$('#bank-level').value,flag:$('#bank-flag').value};bankState.offset=0;loadBankList();});
 document.querySelectorAll('[data-bank-question]').forEach(b=>b.addEventListener('click',()=>selectBankQuestion(Number(b.dataset.bankQuestion))));
 document.querySelectorAll('[data-bank-page]').forEach(b=>b.addEventListener('click',()=>{bankState.offset=Math.max(0,bankState.offset+Number(b.dataset.bankPage)*PAGE_SIZE);loadBankList();}));
 const form=$('#tag-review');
 if(form){
  const remember=()=>{bankState.reviewer=$('#tag-reviewer').value;bankState.reason=$('#tag-reason').value;};
  form.addEventListener('input',remember);
  const review=async(target,action)=>{
   remember();
   if(!bankState.reviewer.trim()||!bankState.reason.trim()){toast('Enter your name and a reason before confirming or rejecting a tag.',true);$(bankState.reviewer.trim()?'#tag-reason':'#tag-reviewer').focus();return;}
   try{bankState.question=(await api(`/api/bank/questions/${bankState.question.id}/review`,{method:'POST',body:JSON.stringify({target,action,reviewer:bankState.reviewer,note:bankState.reason})})).question;bankState.reason='';bankState.coverage=null;toast(action==='confirm'?'Tag confirmed and recorded.':'Tag rejected and recorded.');render();}
   catch(error){toast(error.message,true);}
  };
  form.addEventListener('submit',event=>{event.preventDefault();const target=$('#tag-add').value;if(!target){toast('Choose a topic or outcome to add.',true);$('#tag-add').focus();return;}review(target,'confirm');});
  document.querySelectorAll('[data-tag-action]').forEach(b=>b.addEventListener('click',()=>review(b.dataset.tag,b.dataset.tagAction)));
 }
}

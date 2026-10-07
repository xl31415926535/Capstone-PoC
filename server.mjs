import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store, AppError } from './store.mjs';
import { validateItem, schemaErrors } from './validation.mjs';
import { families, draftSchema, batchBlindSchema, makePlan, generationPrompt, batchBlindPrompt, draftToItem, mappingFor } from './model-v2.mjs';
import { createPracticeService, evaluationReport, labelsFor, difficulties, issueCodes } from './learning.mjs';
import { createFixtures } from './fixtures.mjs';
import { providerStatus, runStructured, runJev, makeGenerationPrompt, makeBlindPrompt } from './providers.mjs';
import { printableRecord } from './export.mjs';
import { syllabus } from './syllabus.mjs';
import { FLAG_CODES, PILOT_TOPIC, bankFileStatus, openBank, bankSummary, searchQuestions, getQuestion, assetData, reviewTag, coverage } from './bank.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const curriculum = JSON.parse(fs.readFileSync(path.join(root, 'curriculum.json'), 'utf8'));
const maxBody = 200_000;
const statuses = ['approved', 'changes_requested', 'rejected'];
const bankSyllabus = { topics: syllabus.topics.map(({ id, theme, level, label }) => ({ id, theme, level, label })), pilotOutcomes: syllabus.topics.find(t => t.id === PILOT_TOPIC).outcomes.filter(o => o.stream === 'standard').map(({ id, text, page }) => ({ id, text, page })) };
const bankLevels = ['', 'primary', 'secondary', 'mixed', 'unknown'];
const now = () => new Date().toISOString();

function normalizePending(item, provenance, version = 1, id = null) {
  item = structuredClone(item);
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('Question must be a JSON object.');
  item.status = 'draft_pending_human_review';
  item.official_exam_question = false;
  item.version = String(version);
  if (id && provenance.mode === 'live') item.item_id = 'SIMCC-LIVE-' + id.slice(0, 8);
  item.review_record = {
    independent_review: 'Not run for this version in Science Studio.',
    revision: version > 1 ? 'Edited in Science Studio; prior approvals and model reviews have been invalidated.' : 'Pending review in Science Studio.',
    curriculum_check: 'See the explicit curriculum mappings and local validation results; human confirmation required.',
    logic_check: 'See the executed local checks attached to this record.',
    originality_check: 'Local corpus comparison only. No complete SIMCC bank or web originality clearance.',
    difficulty_check: 'Provisional model/author estimate; no pupil calibration.',
    language_check: 'Human review required.',
    human_reviewer: null, human_approval: 'Pending', ready_for_live_assessment: false
  };
  if (provenance.mode === 'live') {
    item.created_on = now().slice(0, 10);
    item.generation_record = {
      generator: provenance.provider + (provenance.model ? ' / ' + provenance.model : ' / CLI default, model not reported'),
      external_commercial_model_api_calls: provenance.provider === 'codex' ? 0 : 1,
      source_paper_rewritten: false,
      question_observations: 'Constructed model-generated observations, not physical measurements.',
      design_summary: typeof item.generation_blueprint === 'string' ? item.generation_blueprint : 'Generated from the supplied P5 curriculum objectives.'
    };
  }
  return item;
}

function reflectReview(record) {
  const last = record.reviewEvents.findLast(e => e.version === record.version && statuses.includes(e.action));
  record.item.status = record.status === 'draft' ? 'draft_pending_human_review' : record.status;
  record.item.review_record.human_approval = record.status;
  record.item.review_record.human_reviewer = last?.reviewer || null;
  record.item.review_record.ready_for_live_assessment = false; // Prototype sign-off never represents production release.
  record.item.review_record.independent_review = record.blindReview ? `Executed ${record.blindReview.provider} blind solve; see attached result for version ${record.version}.` : 'Not run for this version in Science Studio.';
  return record;
}

export function createApp(options = {}) {
  const store = new Store(options.dataDir || process.env.SIMCC_DATA_DIR || path.join(root, 'data'));
  const batchStore = new Store(path.join(path.dirname(store.file), 'evaluations'));
  for(const b of batchStore.all())if(['queued','running'].includes(b.status))batchStore.update(b.id,b.version,x=>({...x,status:'interrupted',error:'Server restarted during the run. Existing results are retained; no automatic retry was made.'}));
  const fixtures = createFixtures();
  const practice = createPracticeService(store,fixtures);
  // The source bank is opened per request, so a rebuilt file is used at once and never held open.
  // An explicit data directory (tests, the recorded demo) keeps its bank beside its records.
  const bankFile = options.bankFile || (options.dataDir ? null : process.env.SIMCC_BANK_DB) || path.join(path.dirname(store.file), 'question-bank.sqlite');
  const withBank = (fn, write = false) => { const db = openBank(bankFile, { write }); try { return fn(db); } finally { db.close(); } };
  const bankInfo = () => {
    const status = bankFileStatus(bankFile);
    if (!status.available) return { ...status, syllabus: bankSyllabus };
    try { return { ...withBank(bankSummary), syllabus: bankSyllabus }; } catch (error) { return { available: false, reason: error.message, syllabus: bankSyllabus }; }
  };
  const csrfToken = randomBytes(32).toString('hex');
  const jobs = new Map();
  const providers = options.providerStatus || providerStatus;
  const structuredRunner = options.runStructured || runStructured;
  const jevRunner = options.runJev || runJev;
  let active = false;

  function check(record) {
    record.checks = validateItem(record.item, store.all().filter(r => r.id !== record.id));
    if(record.item.model_version==='science-v2' && !record.blindReview) {
      record.checks.results.push({id:'required_blind',label:'Blind review required',status:'fail',detail:'This open-form task requires a completed independent solve before approval.'});record.checks.blocking++;
    }
    if (record.blindReview?.version === record.version && record.blindReview.agreement === false) {
      record.checks.results.push({ id: 'blind_disagreement', label: 'Independent answer agreement', status: 'fail', detail: 'The blind solver did not agree. Edit the question and review the new version before approval.' });
      record.checks.blocking += 1;
    }
    if(record.blindReview?.issues?.length)record.checks.results.push({id:'blind_issues',label:'Blind reviewer concerns',status:'warn',detail:record.blindReview.issues.join(' · ')});
    return reflectReview(record);
  }
  function addRecord(item, provenance, title) {
    const id = randomUUID();
    const record = { id, title: title || 'P5 Electricity · ' + id.slice(0, 6), status: 'draft', version: 1, createdAt: now(), updatedAt: now(), item: normalizePending(item, provenance, 1, id), checks: null, provenance, blindReview: null, jevReview: null, reviewEvents: [] };
    check(record);
    assertStructure(record);
    return store.add(record);
  }
  function assertStructure(record) {
    const result = record.checks.results.find(r => r.id === 'structure');
    if (result?.status === 'fail') throw new AppError('Invalid item structure: ' + result.detail, 400, 'INVALID_ITEM_STRUCTURE');
  }
  if (!store.all().length && options.seed !== false) {
    const sample = fixtures.find(f => f.id === 'original');
    addRecord(sample.item, { mode: 'replay', provider: 'recorded', model: null, label: 'Recorded original example · no API call', durationMs: 0, usage: null, sourceItemId: sample.item.item_id }, 'Which strips conduct electricity?');
  }

  function job(task) {
    if (active) throw new AppError('Another model job is still running. Wait for it to finish.', 409, 'BUSY');
    active = true;
    const entry = { id: randomUUID(), status: 'queued', stage: 'Queued', createdAt: now() };
    jobs.set(entry.id, entry);
    // Keep bounded history; no prompts or credentials are exposed in this endpoint.
    if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
    setImmediate(async () => {
      entry.status = 'running';
      try { const record = await task(entry.id, stage => { entry.stage = stage; }); entry.recordId = record.id; if(record.batchId){entry.batchId=record.batchId;entry.recordIds=record.recordIds;} entry.status = 'completed'; entry.stage = 'Ready for human review'; }
      catch (error) { entry.status = 'failed'; entry.stage = 'Stopped'; entry.error = error instanceof AppError ? error.message : 'The job could not complete. No demo result was substituted.'; }
      finally { active = false; }
    });
    return { jobId: entry.id };
  }

  function assertVersion(record, value) {
    if (!Number.isInteger(value) || value !== record.version) throw new AppError('Question changed. Reload before continuing.', 409, 'STALE_VERSION');
  }
  function assertProvider(id, review = false) {
    const allowed = review ? ['codex', 'gemini', 'openai'] : ['replay', 'codex', 'gemini', 'openai'];
    if (!allowed.includes(id)) throw new AppError('Select a supported provider.');
    if (!providers().find(p => p.id === id)?.available) throw new AppError('Provider is not configured. Open Sources & setup.', 409, 'PROVIDER_UNAVAILABLE');
  }

  async function readBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Use application/json.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > maxBody) throw new AppError('Request exceeds the 200 KB prototype limit.', 413); chunks.push(chunk); }
    try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
    catch { throw new AppError('Invalid JSON request.'); }
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const commonHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, data, extra = {}) => { res.writeHead(status, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    try {
      if (!allowedHosts.has(req.headers.host)) throw new AppError('Only localhost access is supported.', 403);
      if (req.headers.origin && ![...allowedHosts].map(h => 'http://' + h).includes(req.headers.origin)) throw new AppError('Cross-origin requests are not allowed.', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname;
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && req.headers['x-csrf-token'] !== csrfToken) throw new AppError('Invalid local session token. Refresh the page.', 403, 'CSRF');
      if (req.method === 'GET' && route === '/api/bootstrap') { const bank = bankInfo(); return send(200, { csrfToken, curriculum, families, providers: providers(), records: store.all(), batches:batchStore.all().map(b=>evaluationReport(b,store.all())), fixtures: fixtures.map(({ id, label, description }) => ({ id, label, description })), bank: { available: bank.available, label: bank.label || null, questions: bank.counts?.questions ?? null } }); }
      if (req.method === 'GET' && route === '/api/bank') return send(200, bankInfo());
      if (req.method === 'GET' && route === '/api/bank/questions') {
        const p = url.searchParams, filters = { q: p.get('q') || '', topic: p.get('topic') || '', level: p.get('level') || '', flag: p.get('flag') || '', limit: Number(p.get('limit') || 25), offset: Number(p.get('offset') || 0) };
        if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 50 || !Number.isInteger(filters.offset) || filters.offset < 0 || filters.offset > 100000 || filters.q.length > 200 || (filters.topic && !bankSyllabus.topics.some(t => t.id === filters.topic)) || !bankLevels.includes(filters.level) || !['', 'clean', 'figure', ...FLAG_CODES].includes(filters.flag)) throw new AppError('Invalid source bank search.');
        return send(200, withBank(db => searchQuestions(db, filters)));
      }
      const bankRoute = route.match(/^\/api\/bank\/(questions|assets)\/(\d{1,9})(\/review)?$/);
      if (bankRoute) {
        const [, kind, idText, review] = bankRoute, id = Number(idText);
        if (kind === 'assets' && !review && req.method === 'GET') {
          const asset = withBank(db => assetData(db, id));
          res.writeHead(200, { ...commonHeaders, 'Content-Type': asset.mediaType, 'Content-Security-Policy': "default-src 'none'" });
          return res.end(asset.data);
        }
        if (kind === 'questions' && !review && req.method === 'GET') return send(200, { question: withBank(db => getQuestion(db, id)) });
        if (kind === 'questions' && review && req.method === 'POST') { const body = await readBody(req); return send(200, { question: withBank(db => reviewTag(db, id, body), true) }); }
        throw new AppError('Unsupported method.', 405);
      }
      if (req.method === 'GET' && route === '/api/coverage') {
        const bank = bankInfo();
        if (bank.available) return send(200, withBank(db => coverage(db, store.all(), curriculum)));
        return send(200, { ...coverage(null, store.all(), curriculum), bankStatus: { reason: bank.reason } });
      }
      if(req.method==='GET'&&route==='/api/practice/config')return send(200,{csrfToken,curriculum,...practice.config()});
      if(req.method==='POST'&&route==='/api/practice/start')return send(200,practice.start(await readBody(req)));
      if(req.method==='POST'&&/^\/api\/practice\/[^/]+\/submit$/.test(route))return send(200,practice.submit(route.split('/')[3],await readBody(req)));
      if(req.method==='GET'&&route==='/api/evaluations')return send(200,{batches:batchStore.all().map(b=>evaluationReport(b,store.all()))});
      if(req.method==='GET'&&/^\/api\/evaluations\/[^/]+\/export$/.test(route))return send(200,evaluationReport(batchStore.get(route.split('/')[3]),store.all()),{'Content-Disposition':'attachment; filename="simcc-evaluation.json"'});
      if(req.method==='GET'&&route==='/api/feedback/export')return send(200,{exportedAt:now(),purpose:'Reviewer feedback for later analysis; not automatically accepted training data.',records:store.all().filter(r=>r.reviewEvents.length).map(r=>({id:r.id,version:r.version,status:r.status,item:r.item,labels:labelsFor(r),events:r.reviewEvents}))},{'Content-Disposition':'attachment; filename="simcc-reviewer-feedback.json"'});
      if(req.method==='POST'&&route==='/api/batches') {
        const body=await readBody(req);assertProvider(body.provider,true);
        if(active)throw new AppError('Another model job is still running.',409,'BUSY');
        const plan=makePlan(body.count??10,body.family||'balanced',body.difficulty||'Mixed');
        const batchId=randomUUID();
        batchStore.add({id:batchId,version:1,createdAt:now(),updatedAt:now(),status:'queued',provider:body.provider,plan,entries:[],generatorUsage:null,blindUsage:null});
        const result=job(async(jobId,stage)=>{
          const save=patch=>batchStore.update(batchId,1,b=>({...b,...patch}));
          const entries=[];save({status:'running'});
          try {
            stage(`Designing and generating ${plan.length} curriculum-grounded questions`);
            const generated=await structuredRunner(body.provider,generationPrompt(plan,curriculum,store.all()),'draft-schema.json',jobId+'-generate',stage);
            const errors=schemaErrors(generated.value,draftSchema);
            if(errors.length||generated.value.questions.length!==plan.length)throw new AppError('Generation returned an incomplete or malformed batch. '+errors.slice(0,3).join('; '),502);
            save({generatorUsage:generated.usage||null,generatorModel:generated.model||null,generationMs:generated.durationMs});
            for(const [index,draft] of generated.value.questions.entries()) {
              try {
                if(draft.family!==plan[index].family||draft.difficulty!==plan[index].difficulty)throw new AppError('The generated question does not match its requested family/difficulty slot.');
                const item=draftToItem(draft,curriculum);
                const record=addRecord(item,{mode:'live',provider:body.provider,model:generated.model,label:'Live curriculum-first generation · science-v2',durationMs:generated.durationMs,usage:null,batchId,sourceItemId:null},draft.title);
                entries.push({index:index+1,family:draft.family,recordId:record.id,version:1,initialLocalBlocking:record.checks.results.filter(c=>c.status==='fail'&&c.id!=='required_blind').length});
              } catch(error) {entries.push({index:index+1,family:plan[index].family,error:error instanceof AppError?error.message:'Generated item could not be stored.'});}
            }
            save({entries});
            const candidates=entries.filter(e=>e.recordId).map(e=>store.get(e.recordId));
            if(candidates.length) {
              try {
                stage(`Independently solving ${candidates.length} questions without their answer keys`);
                const reviewed=await structuredRunner(body.provider,batchBlindPrompt(candidates,curriculum),'batch-blind-schema.json',jobId+'-blind',stage);
                const invalid=schemaErrors(reviewed.value,batchBlindSchema);
                const reviews=reviewed.value?.reviews;
                if(invalid.length||reviews.length!==candidates.length||new Set(reviews.map(r=>r.id)).size!==candidates.length||reviews.some(r=>!candidates.some(c=>c.id===r.id)))throw new AppError('Blind reviewer returned incomplete or mismatched item IDs.',502);
                for(const review of reviews) {
                  const entry=entries.find(e=>e.recordId===review.id);
                  try {
                    const record=store.update(review.id,entry.version,r=>{r.blindReview={provider:body.provider,model:reviewed.model,optionId:review.optionId,reasoning:review.reasoning,issues:review.issues,agreement:review.optionId===r.item.answer.option_id,ranAt:now(),version:r.version,usage:null,batchId};return check(r);});
                    entry.initialBlindAgreement=record.blindReview.agreement;entry.initialBlindIssues=record.blindReview.issues;
                  }catch{entry.blindError='Item changed during blind review; stale output was discarded.';}
                }
                save({blindUsage:reviewed.usage||null,blindModel:reviewed.model||null,blindMs:reviewed.durationMs});
              }catch(error){for(const entry of entries.filter(e=>e.recordId))entry.blindError=error instanceof AppError?error.message:'Blind review failed. No agreement was assumed.';}
            }
            for(const entry of entries.filter(e=>e.recordId))store.update(entry.recordId,store.get(entry.recordId).version,r=>check(r));
            save({status:'completed',entries,completedAt:now()});
          } catch(error) {
            const message=error instanceof AppError?error.message:'Generation failed. No recorded questions were substituted.';
            save({status:'failed',error:message,entries:plan.map(p=>entries.find(e=>e.index===p.index)||{index:p.index,family:p.family,error:message}),completedAt:now()});
          }
          return {id:entries.find(e=>e.recordId)?.recordId||null,batchId,recordIds:entries.filter(e=>e.recordId).map(e=>e.recordId)};
        });
        return send(202,{...result,batchId});
      }
      if (req.method === 'GET' && route === '/api/records') return send(200, { records: store.all() });
      if (req.method === 'GET' && route.startsWith('/api/jobs/')) { const found = jobs.get(route.slice(10)); if (!found) throw new AppError('Job not found.', 404); return send(200, found); }
      if (req.method === 'GET' && route === '/api/export') {
        const records = store.all().filter(r => r.status === 'approved' && r.checks?.blocking === 0);
        return send(200, { exportedAt: now(), scope: 'Approved current versions in this local prototype; not production release', records }, { 'Content-Disposition': 'attachment; filename="simcc-approved-bank.json"' });
      }
      if (req.method === 'POST' && route === '/api/generate') {
        const body = await readBody(req); assertProvider(body.provider);
        if (body.difficulty && !['Easy', 'Medium', 'Hard'].includes(body.difficulty)) throw new AppError('Unsupported difficulty.');
        if (body.skill && (typeof body.skill !== 'string' || body.skill.length > 160)) throw new AppError('Invalid skill.');
        if (body.provider === 'replay') {
          const fixture = fixtures.find(f => f.id === (body.fixtureId || 'original'));
          if (!fixture) throw new AppError('Unknown recorded example.');
          return send(202, job(async (_, stage) => { stage('Loading recorded example and executing local checks'); return addRecord(fixture.item, { mode: fixture.mode, provider: 'recorded', model: null, label: fixture.mode === 'fixture' ? 'Deliberate validation test · ' + fixture.label : fixture.mode === 'constructed' ? 'Constructed example written by the project team · not model output' : 'Recorded original example · no API call', durationMs: 0, usage: null, sourceItemId: fixture.item.item_id }, fixture.label); }));
        }
        return send(202, job(async (jobId, stage) => {
          stage('Preparing verified curriculum context');
          const request = { difficulty: body.difficulty || 'Medium', skill: body.skill || 'Application / interpreting observations' };
          const prompt = makeGenerationPrompt(request, curriculum, fixtures.find(f => f.id === 'original').item);
          const result = await structuredRunner(body.provider, prompt, 'schema.json', jobId, stage);
          stage('Running local schema, logic and similarity checks');
          return addRecord(result.value, { mode: 'live', provider: body.provider, model: result.model, label: 'Live generation · ' + body.provider, durationMs: result.durationMs, usage: result.usage, sourceItemId: null });
        }));
      }
      const match = route.match(/^\/api\/records\/([a-zA-Z0-9-]+)(?:\/(check|blind-review|jev-review|review|labels|export))?$/);
      if (match) {
        const [, id, action] = match;
        const current = store.get(id);
        if (req.method === 'GET' && !action) return send(200, { record: current });
        if (req.method === 'GET' && action === 'export') {
          if (url.searchParams.get('format') === 'html') return send(200, printableRecord(current), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
          return send(200, current, { 'Content-Disposition': `attachment; filename="simcc-${id}.json"` });
        }
        if (req.method === 'PUT' && !action) {
          const body = await readBody(req);
          if (!body.item || typeof body.item !== 'object' || Array.isArray(body.item)) throw new AppError('Provide the complete item object.');
          const record = store.update(id, body.version, r => {
            r.version++; r.status = 'draft'; r.blindReview = null; r.jevReview = null; r.labels = null;
            r.item = normalizePending(body.item, r.provenance, r.version, id);
            r.reviewEvents.push({ at: now(), action: 'edited', reviewer: 'Local editor', note: 'Content edited; approvals and model reviews reset.', version: r.version, attestations: null });
            check(r); assertStructure(r); return r;
          });
          return send(200, { record });
        }
        if (req.method === 'POST' && action) {
          const body = await readBody(req); assertVersion(current, body.version);
          if (action === 'check') {
            const record = store.update(id, body.version, r => { check(r); if (r.checks.blocking > 0 && r.status === 'approved') { r.status = 'changes_requested'; r.reviewEvents.push({ at: now(), action: 'checks_failed', reviewer: 'Local checks', note: 'Approval withdrawn because current checks failed.', version: r.version, attestations: null }); reflectReview(r); } return r; });
            return send(200, { record });
          }
          if (action === 'blind-review') {
            assertProvider(body.provider, true);
            return send(202, job(async (jobId, stage) => {
              const result = await structuredRunner(body.provider, makeBlindPrompt(current.item, curriculum), 'blind-schema.json', jobId, stage);
              const answer = result.value;
              if (!answer || (!Number.isInteger(answer.optionId) && answer.optionId !== null) || (answer.optionId !== null && (answer.optionId < 1 || answer.optionId > 4)) || typeof answer.reasoning !== 'string' || !Array.isArray(answer.issues) || answer.issues.some(i => typeof i !== 'string')) throw new AppError('Blind review returned invalid structured output.', 502);
              return store.update(id, body.version, r => {
                r.blindReview = { provider: body.provider, model: result.model, optionId: answer.optionId, reasoning: answer.reasoning, issues: answer.issues, agreement: answer.optionId === r.item.answer?.option_id, ranAt: now(), version: r.version, usage: result.usage };
                if (!r.blindReview.agreement && r.status === 'approved') { r.status = 'changes_requested'; r.reviewEvents.push({ at: now(), action: 'review_disagreement', reviewer: 'Blind solver', note: 'Approval withdrawn: independent answer disagreement.', version: r.version, attestations: null }); }
                return check(r);
              });
            }));
          }
          if (action === 'jev-review') {
            if (!providers().find(p => p.id === 'jev')?.available) throw new AppError('Jev is not configured; this optional step can be skipped.', 409);
            return send(202, job(async (_, stage) => { const result = await jevRunner(current.item, curriculum, stage); return store.update(id, body.version, r => { r.jevReview = { ...result, ranAt: now(), version: r.version }; return r; }); }));
          }
          if (action === 'review') {
            if (!statuses.includes(body.action)) throw new AppError('Invalid review action.');
            if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.length > 120 || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 3000) throw new AppError('A reviewer name and review note are required.');
            if(body.reviewSeconds!=null&&(!Number.isFinite(body.reviewSeconds)||body.reviewSeconds<0||body.reviewSeconds>28800))throw new AppError('Review time must be 0–480 minutes.');
            if(body.issueCodes!==undefined&&(!Array.isArray(body.issueCodes)||body.issueCodes.some(x=>!issueCodes.includes(x))))throw new AppError('Unknown review issue category.');
            const record = store.update(id, body.version, r => {
              check(r);
              if (body.action === 'approved') {
                if (r.checks.blocking > 0) throw new AppError('Resolve the blocking checks before approval.', 409, 'CHECKS_BLOCKED');
                if (!['science', 'alignment', 'originality', 'difficulty'].every(key => body.attestations?.[key] === true)) throw new AppError('Confirm all four human review criteria before approving.');
              }
              r.status = body.action;
              r.reviewEvents.push({ at: now(), action: body.action, reviewer: body.reviewer.trim(), note: body.note.trim(), version: r.version, reviewSeconds:body.reviewSeconds??null,issueCodes:body.issueCodes||[],attestations: body.action === 'approved' ? Object.fromEntries(['science', 'alignment', 'originality', 'difficulty'].map(key => [key, true])) : null });
              return reflectReview(r);
            });
            return send(200, { record });
          }
          if(action==='labels') {
            if(!difficulties.includes(body.difficulty)||typeof body.skill!=='string'||!body.skill.trim()||body.skill.length>160||!Array.isArray(body.objectives)||!body.objectives.length||new Set(body.objectives).size!==body.objectives.length||body.objectives.some(id=>!curriculum.objectives.some(o=>o.id===id)))throw new AppError('Provide valid difficulty, skill and curriculum objectives.');
            if(typeof body.reviewer!=='string'||!body.reviewer.trim()||body.reviewer.length>120||typeof body.note!=='string'||!body.note.trim()||body.note.length>3000)throw new AppError('Reviewer and correction reason are required.');
            const record=store.update(id,body.version,r=>{
              const before=labelsFor(r);r.version++;r.status='draft';r.blindReview=null;r.jevReview=null;
              r.labels={difficulty:body.difficulty,objectives:body.objectives,skill:body.skill.trim(),reviewed:true};
              r.item.difficulty_estimate=body.difficulty;r.item.skill=body.skill.trim();
              r.item.syllabus_mapping=body.objectives.map(objective=>({...mappingFor(objective,curriculum),item_evidence:r.item.syllabus_mapping.find(m=>m.internal_mapping_id===objective)?.item_evidence||'Mapping added by academic reviewer: '+body.note.trim()}));
              r.item.subtopics=body.objectives.map(id=>curriculum.objectives.find(o=>o.id===id).title);
              r.item=normalizePending(r.item,r.provenance,r.version,id);
              r.reviewEvents.push({at:now(),action:'labels_corrected',reviewer:body.reviewer.trim(),note:body.note.trim(),version:r.version,before,after:r.labels,attestations:null});
              check(r);assertStructure(r);return r;
            });return send(200,{record});
          }
        }
        throw new AppError('Unsupported method.', 405);
      }
      if (req.method === 'GET') {
        const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/extensions.js':['extensions.js','text/javascript'], '/practice':['practice.html','text/html'], '/practice.js':['practice.js','text/javascript'], '/bank.js':['bank.js','text/javascript'] };
        if (route === '/favicon.ico') { res.writeHead(204, commonHeaders); return res.end(); }
        if (files[route]) { const [file, type] = files[route]; return send(200, fs.readFileSync(path.join(root, 'public', file), 'utf8'), { 'Content-Type': type + '; charset=utf-8' }); }
        // The circuit module is shared by the server and both pages.
        if (route === '/circuit.mjs') return send(200, fs.readFileSync(path.join(root, 'circuit.mjs'), 'utf8'), { 'Content-Type': 'text/javascript; charset=utf-8' });
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (!res.headersSent) send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'An internal operation failed. Your saved records were not intentionally changed.', code: error.code || 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, store, batchStore, jobs, csrfToken, bankFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.SIMCC_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SIMCC_PORT must be between 1024 and 65535.');
  const { server } = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Open the running app or choose SIMCC_PORT.` : 'Server could not start.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Science Studio: http://127.0.0.1:${port}\nLocal-only prototype. Press Ctrl+C to stop.`));
}

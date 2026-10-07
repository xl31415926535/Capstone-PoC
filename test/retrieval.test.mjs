import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { sqlite, buildBank, openBank, retrieveReferences, similarSources, qualityFlags } from '../bank.mjs';
import { families, makePlan, retrievalQueries, generationPrompt, draftToItem } from '../model-v2.mjs';
import { validateItem, sourceOverlap, overlapStatus } from '../validation.mjs';
import { compareConditions } from '../learning.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = path.join(root, 'examples', 'bank-sample');
const curriculum = JSON.parse(fs.readFileSync(path.join(root, 'curriculum.json'), 'utf8'));
const skip = sqlite ? false : 'node:sqlite is not available in this Node version';
const tempDir = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcc-retrieval-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const sampleBank = (dir, file = 'question-bank.sqlite') => { const output = path.join(dir, file); buildBank({ output, sources: [sample], previous: null }); return output; };

const draft = () => ({ title: 'Test-only closed circuit question', family: 'circuit_prediction', difficulty: 'Medium', skill: 'Application', context: 'One working battery and bulb are connected in one loop with a switch. All wire contacts are secure. The switch is open.', question: 'Which change completes the conducting loop?', table: { columns: [], rows: [] }, figure: { panels: [] }, verification: { kind: 'none', options: [], targetLit: [] }, options: [{ id: 1, text: 'Close the switch.' }, { id: 2, text: 'Remove the battery.' }, { id: 3, text: 'Remove the bulb.' }, { id: 4, text: 'Leave the switch open.' }], answer: { optionId: 1, explanation: 'Closing the switch completes the conducting path.', steps: ['An open switch breaks the path.', 'Closing it completes the loop.'], distractors: [{ optionId: 2, reason: 'The circuit requires the battery.' }, { optionId: 3, reason: 'Removing the bulb breaks the loop.' }, { optionId: 4, reason: 'The path remains broken.' }] }, mappings: [{ objectiveId: 'P5-ELEC-CLOSED', evidence: 'The pupil identifies how to close the loop.' }], design: { reasoningTask: 'Predict effect of closing a switch', requiredKnowledge: ['A closed loop permits current.'], originalityRationale: 'Test fixture, not an originality assertion.' } });
// Sample question 3 with the nouns swapped: a superficial rewrite.
const copied = () => ({ ...draft(), title: 'Test-only copied question', context: 'Two identical lamps are connected in series with one cell. A third identical lamp is then added in series.', question: 'What happens to the first two lamps?', options: [{ id: 1, text: 'They become brighter.' }, { id: 2, text: 'They become dimmer.' }, { id: 3, text: 'They stay equally bright.' }, { id: 4, text: 'They stop lighting up.' }], answer: { ...draft().answer, optionId: 2, distractors: [{ optionId: 1, reason: 'More bulbs in series do not raise the current.' }, { optionId: 3, reason: 'The current changes.' }, { optionId: 4, reason: 'The loop is still closed.' }] } });
const approval = v => ({ version: v, action: 'approved', reviewer: 'TEST ONLY', note: 'Simulated test approval.', attestations: { science: true, alignment: true, originality: true, difficulty: true }, reviewSeconds: 60, issueCodes: [] });

async function setup(t, { bank = true, make = draft, available = ['replay', 'codex'] } = {}) {
  const dir = tempDir(t), calls = [];
  if (bank) sampleBank(dir);
  const app = createApp({
    dataDir: dir,
    providerStatus: () => ['replay', 'codex', 'gemini'].map(id => ({ id, available: available.includes(id), label: id })),
    runStructured: async (provider, prompt, schema) => {
      calls.push({ provider, prompt, schema });
      if (schema === 'draft-schema.json') { const payload = JSON.parse(prompt.split('\n\n').at(-1)); return { value: { questions: payload.plan.map(p => ({ ...make(), family: p.family, difficulty: p.difficulty })) }, model: 'mock-test', durationMs: 1 }; }
      const questions = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).questions;
      return { value: { reviews: questions.map(q => ({ id: q.id, optionId: make().answer.optionId, reasoning: 'Fixture independent solve', issues: [] })) }, model: 'mock-blind', durationMs: 1 };
    },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, body) => { const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() }; };
  const batch = async body => {
    const start = await call('/api/batches', { provider: 'codex', count: 2, family: 'balanced', difficulty: 'Mixed', ...body });
    assert.equal(start.status, 202, JSON.stringify(start.data));
    for (let i = 0; i < 300; i++) { const job = await call('/api/jobs/' + start.data.jobId); if (['completed', 'failed'].includes(job.data.status)) break; await new Promise(r => setTimeout(r, 5)); }
    const evaluations = (await call('/api/evaluations')).data;
    return { report: evaluations.batches.find(b => b.id === start.data.batchId), comparison: evaluations.comparison };
  };
  return { ...app, dir, calls, call, batch };
}

test('blank extracted options count as option noise, not as options', () => {
  const flags = qualityFlags('Two lamps are in series. Which lamp is brighter?', { A: '', B: 'Lamp B', C: 'Both are equally bright.', D: 'Lamp A' }, 'C');
  assert.match(flags.find(f => f.code === 'option_noise').detail, /Option A is blank/);
  assert.ok(!flags.some(f => f.code === 'few_options'));
  assert.ok(qualityFlags('Which is a conductor?', { A: 'copper', B: ' ', C: '' }, 'A').some(f => f.code === 'few_options'));
});

test('retrieval queries follow the plan, one per reasoning family', () => {
  const queries = retrievalQueries(makePlan(10));
  assert.deepEqual(queries.map(q => q.key), families.map(f => f.id));
  assert.ok(queries.every(q => q.text.split(' ').length >= 8));
  assert.deepEqual(retrievalQueries(makePlan(3, 'fault_diagnosis', 'Hard')).map(q => q.key), ['fault_diagnosis']);
});

test('reference questions are pilot-topic, primary, undamaged and shared out between queries', { skip }, t => {
  const db = openBank(sampleBank(tempDir(t)));
  t.after(() => db.close());
  const refs = retrieveReferences(db, retrievalQueries(makePlan(10)), { k: 4 });
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.map(r => r.ref), ['S1', 'S2', 'S3', 'S4']);
  assert.equal(new Set(refs.map(r => r.bankId)).size, 4);
  const pilot = new Set(db.prepare("SELECT question_id AS id FROM question_topics WHERE topic_id = 'P5-SYSTEMS-ELECTRICAL'").all().map(r => r.id));
  assert.ok(refs.every(r => pilot.has(r.bankId) && r.key && r.sourceKey.startsWith('simcc-constructed-sample-2026#') && r.matched));
  // Each reference matched at least one family's query.
  assert.ok(refs.every(r => r.matchedFor.length >= 1));
  // All six pilot questions when asked for more; the figure question is described in words.
  const all = retrieveReferences(db, retrievalQueries(makePlan(10)), { k: 10 });
  assert.equal(all.length, 6);
  assert.match(all.find(r => r.stem.includes('switch S1')).figure, /bulb/i);
  // No word match: the eligible questions fill the list in id order.
  const filler = retrieveReferences(db, [{ key: 'none', text: 'zzzz qqqq' }], { k: 2 });
  assert.equal(filler.length, 2);
  assert.ok(filler.every(r => !r.matched && r.matchedFor.length === 0));
  assert.ok(filler[0].bankId < filler[1].bankId);
  // Excluded content (the xylem question) and other topics never come back.
  assert.ok(!all.some(r => /xylem|magnet|condens/i.test(r.stem)));
});

test('similar sources include the questions a draft was generated from', { skip }, t => {
  const db = openBank(sampleBank(tempDir(t)));
  t.after(() => db.close());
  const magnet = db.prepare("SELECT id FROM questions WHERE stem LIKE '%magnet%'").get().id;
  const found = similarSources(db, 'two identical bulbs in series with one battery', { limit: 2 });
  assert.ok(found.length >= 1 && found.length <= 2);
  assert.ok(!found.some(s => s.id === magnet));
  const withExtra = similarSources(db, 'two identical bulbs in series with one battery', { limit: 2, include: [magnet] });
  assert.equal(withExtra.at(-1).id, magnet);
  assert.match(withExtra.at(-1).label, /Q\d+$/);
});

test('source overlap ignores renamed labels and numbers, and blocks near copies', () => {
  const source = 'Two identical bulbs are connected in series with one battery. A third identical bulb is then added in series. What happens to the first two bulbs? They become brighter. They become dimmer. They stay equally bright. They stop lighting up.';
  const relabelled = 'In circuit P, 3 identical bulbs X, Y and Z are connected in series with 2 batteries. Bulb W is then added in series. What happens to bulbs X and Y? They become brighter. They become dimmer. They stay equally bright. They stop lighting up.';
  const original = 'In circuit A, 2 identical bulbs P, Q and R are connected in series with 4 batteries. Bulb S is then added in series. What happens to bulbs P and Q? They become brighter. They become dimmer. They stay equally bright. They stop lighting up.';
  assert.equal(overlapStatus(sourceOverlap(relabelled, original)), 'fail');
  assert.equal(sourceOverlap(relabelled, original).score, 1);
  const item = draftToItem(copied(), curriculum);
  const sources = [{ id: 7, sourceKey: 'doc#3', label: 'Sample · Q3', text: source }, { id: 8, sourceKey: 'doc#5', label: 'Sample · Q5', text: 'Which part of a simple circuit is its energy source? the battery the bulb the switch the wire' }];
  const checked = validateItem(item, [], { sourceQuestions: sources });
  const result = checked.results.find(r => r.id === 'source_similarity');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /Near copy of Sample · Q3/);
  assert.equal(checked.sourceSimilarity.best.id, 7);
  assert.ok(checked.blocking >= 1);
  // A different question on the same topic passes; no bank means not run.
  const fresh = validateItem(draftToItem(draft(), curriculum), [], { sourceQuestions: sources });
  assert.equal(fresh.results.find(r => r.id === 'source_similarity').status, 'pass');
  assert.equal(fresh.blocking, 0);
  assert.equal(validateItem(item).results.find(r => r.id === 'source_similarity').status, 'not_run');
  assert.equal(validateItem(item).sourceSimilarity, null);
  assert.equal(validateItem(item, [], { sourceQuestions: [] }).results.find(r => r.id === 'source_similarity').status, 'pass');
});

test('the generation prompt carries source questions only when retrieval is on', () => {
  const plan = makePlan(2);
  const refs = [{ ref: 'S1', bankId: 123456, sourceKey: 'secret-sha#4', source: 'Sample · P5 · Q4', stem: 'Which bulbs light up?', options: { 1: 'A only' }, key: '1', figure: null }];
  const without = generationPrompt(plan, curriculum);
  assert.doesNotMatch(without, /referenceQuestions/);
  const prompt = generationPrompt(plan, curriculum, [], refs);
  assert.match(prompt, /Never reuse their wording, scenario, labels, numbers, option set or diagram/);
  const payload = JSON.parse(prompt.split('\n\n').at(-1));
  assert.deepEqual(payload.referenceQuestions, [{ ref: 'S1', source: 'Sample · P5 · Q4', question: 'Which bulbs light up?', options: { 1: 'A only' }, key: '1', figure: null }]);
  assert.doesNotMatch(prompt, /123456|secret-sha/);
});

test('a batch with retrieval sends source questions, records them and compares drafts with the bank', { skip }, async t => {
  const a = await setup(t);
  const { report } = await a.batch({ retrieval: true });
  assert.equal(report.status, 'completed');
  const generation = a.calls.find(c => c.schema === 'draft-schema.json');
  const payload = JSON.parse(generation.prompt.split('\n\n').at(-1));
  assert.equal(payload.referenceQuestions.length, 6);
  assert.match(generation.prompt, /Source questions: referenceQuestions/);
  assert.equal(report.retrieval.enabled, true);
  assert.equal(report.retrieval.references.length, 6);
  assert.equal(report.retrieval.bank.label, 'Constructed sample bank');
  assert.deepEqual(report.retrieval.queries.map(q => q.key), ['material_inference', 'circuit_prediction']);
  const record = a.store.get(report.rows[0].recordId);
  assert.deepEqual(record.provenance.retrieval.references.map(r => r.ref), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  assert.ok(record.provenance.retrieval.references.every(r => Number.isInteger(r.bankId) && r.sourceKey && r.source && !r.stem));
  const overlap = record.checks.results.find(r => r.id === 'source_similarity');
  assert.equal(overlap.status, 'pass', overlap.detail);
  assert.ok(record.checks.sourceSimilarity.compared >= 6);
  assert.ok(Number.isFinite(report.rows[0].initialSourceOverlap));
  assert.equal(report.rows[0].initialSourceStatus, 'pass');
  assert.equal(report.metrics.sourceCompared, 2);
  assert.equal(report.metrics.sourceBlocked, 0);
  assert.match(report.definitions.blindIndependence, /same provider/);
  // A run without retrieval keeps its prompt free of source questions but is still compared with the bank.
  const plain = await a.batch({ retrieval: false });
  const second = a.calls.filter(c => c.schema === 'draft-schema.json')[1];
  assert.doesNotMatch(second.prompt, /referenceQuestions/);
  assert.deepEqual(plain.report.retrieval, { enabled: false });
  assert.equal(a.store.get(plain.report.rows[0].recordId).provenance.retrieval, undefined);
  assert.equal(plain.report.metrics.sourceCompared, 2);
  const [without, withRefs] = plain.comparison;
  assert.equal(without.retrieval, false); assert.equal(without.runs, 1); assert.equal(without.generated, 2);
  assert.equal(withRefs.retrieval, true); assert.equal(withRefs.runs, 1); assert.equal(withRefs.sourceCompared, 2);
  assert.equal(withRefs.humanAcceptanceRate, null);
  const boot = (await a.call('/api/bootstrap')).data;
  assert.equal(boot.comparison.length, 2);
});

test('a draft that copies a source question is blocked and counted in the pilot', { skip }, async t => {
  const a = await setup(t, { make: copied });
  const { report, comparison } = await a.batch({ retrieval: true, count: 1 });
  const record = a.store.get(report.rows[0].recordId);
  const overlap = record.checks.results.find(r => r.id === 'source_similarity');
  assert.equal(overlap.status, 'fail');
  assert.match(overlap.detail, /Near copy of SIMCC Capstone Group 20 · Constructed sample \(not a real paper\) · Q3/);
  assert.equal(report.rows[0].initialSourceStatus, 'fail');
  assert.ok(report.rows[0].initialLocalBlocking >= 1);
  assert.equal(report.metrics.sourceBlocked, 1);
  assert.equal(comparison.find(c => c.retrieval).sourceBlocked, 1);
  const review = await a.call(`/api/records/${record.id}/review`, approval(record.version));
  assert.equal(review.status, 409);
  assert.equal(review.data.code, 'CHECKS_BLOCKED');
});

test('retrieval needs a source bank and a boolean flag', { skip }, async t => {
  const a = await setup(t, { bank: false });
  const missing = await a.call('/api/batches', { provider: 'codex', count: 1, retrieval: true });
  assert.equal(missing.status, 409);
  assert.equal(missing.data.code, 'BANK_UNAVAILABLE');
  assert.equal((await a.call('/api/batches', { provider: 'codex', count: 1, retrieval: 'yes' })).status, 400);
  assert.equal((await a.call('/api/evaluations')).data.batches.length, 0);
  // Without a bank a plain run still works, and the overlap check is reported as not run.
  const { report } = await a.batch({ count: 1 });
  assert.equal(a.store.get(report.rows[0].recordId).checks.results.find(r => r.id === 'source_similarity').status, 'not_run');
  assert.equal(report.metrics.sourceCompared, 0);
});

test('the blind solve can use a different provider from the generator', { skip }, async t => {
  const unavailable = await setup(t);
  const refused = await unavailable.call('/api/batches', { provider: 'codex', blindProvider: 'gemini', count: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await unavailable.call('/api/batches', { provider: 'codex', blindProvider: 'replay', count: 1 })).status, 400);
  const a = await setup(t, { available: ['replay', 'codex', 'gemini'] });
  const { report } = await a.batch({ blindProvider: 'gemini', count: 1 });
  assert.deepEqual(a.calls.map(c => [c.provider, c.schema]), [['codex', 'draft-schema.json'], ['gemini', 'batch-blind-schema.json']]);
  assert.equal(report.blindProvider, 'gemini');
  assert.equal(report.blindModel, 'mock-blind');
  assert.equal(a.store.get(report.rows[0].recordId).blindReview.provider, 'gemini');
  assert.match(report.definitions.blindIndependence, /gemini, a different provider from the generator \(codex\)/);
});

test('conditions pool finished runs only', () => {
  const run = (enabled, status, metrics, rows = []) => ({ status, retrieval: { enabled }, metrics: { requested: 2, generated: 2, localPass: 1, blindCompleted: 2, blindAgreed: 1, humanReviewed: 1, humanApproved: 1, sourceClose: 1, sourceBlocked: 0, ...metrics }, rows });
  const rows = [{ recordId: 'a', initialSourceOverlap: 0.2, decision: 'approved', reviewSeconds: 60, issueCodes: [] }, { recordId: 'b', initialSourceOverlap: 0.4, decision: 'changes_requested', reviewSeconds: 120, issueCodes: ['superficial_rewrite'] }];
  const [without, withRefs] = compareConditions([run(true, 'completed', {}, rows), run(true, 'running', {}), run(false, 'failed', { generated: 0, localPass: 0, blindCompleted: 0, blindAgreed: 0, humanReviewed: 0, humanApproved: 0, sourceClose: 0 })]);
  assert.equal(withRefs.runs, 1);
  assert.equal(withRefs.humanAcceptanceRate, 1);
  assert.ok(Math.abs(withRefs.meanSourceOverlap - 0.3) < 1e-9);
  assert.equal(withRefs.averageReviewSeconds, 90);
  assert.equal(withRefs.issues.superficial_rewrite, 1);
  assert.equal(without.runs, 1);
  assert.equal(without.generated, 0);
  assert.equal(without.humanAcceptanceRate, null);
  assert.equal(without.meanSourceOverlap, null);
});

test('the pilot script dry run lists the source questions without calling a model', { skip }, t => {
  const bank = sampleBank(tempDir(t), 'pilot.sqlite');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'retrieval-pilot.mjs'), '--dry-run', '--bank', bank, '--count', '5'], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run, no model call\. Bank: Constructed sample bank/);
  assert.match(result.stdout, /S1 SIMCC Capstone Group 20/);
  assert.match(result.stdout, /Prompt size without retrieval: \d+ characters; with: \d+/);
  const missing = spawnSync(process.execPath, [path.join(root, 'scripts', 'retrieval-pilot.mjs'), '--dry-run', '--bank', path.join(path.dirname(bank), 'none.sqlite')], { encoding: 'utf8', cwd: root });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No source bank has been built yet/);
});

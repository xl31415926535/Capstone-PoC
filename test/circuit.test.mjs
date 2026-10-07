import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { solvePanel, verifyFigure, figureErrors, describeFigure, pupilFigure, renderFigureSvg, textOnlyQuestion } from '../circuit.mjs';
import { draftSchema, draftToItem, batchBlindPrompt } from '../model-v2.mjs';
import { schemaErrors, validateItem } from '../validation.mjs';
import { createFixtures } from '../fixtures.mjs';
import { printableRecord } from '../export.mjs';
import { createApp } from '../server.mjs';

const curriculum = JSON.parse(fs.readFileSync(new URL('../curriculum.json', import.meta.url)));
const examples = JSON.parse(fs.readFileSync(new URL('../examples/circuit-examples.json', import.meta.url))).drafts;
const part = (kind, label = '', extra = {}) => ({ kind, label, state: 'none', material: 'none', branches: [], ...extra });
const battery = () => part('battery');
const bulb = label => part('bulb', label);
const sw = (label, state) => part('switch', label, { state });
const gap = (label, material) => part('gap', label, { material });
const wire = () => part('wire');
const parallel = (...branches) => part('parallel', '', { branches });
const panel = (elements, label = '') => ({ label, elements });
const lit = p => Object.fromEntries(solvePanel(p).bulbs.map(b => [b.label, b.lit ? b.brightness : 0]));
const options = texts => texts.map((text, i) => ({ id: i + 1, text }));
const litCheck = sets => ({ kind: 'lit_bulbs', options: sets.map((bulbs, i) => ({ optionId: i + 1, bulbs, circuit: '', closedSwitches: [] })), targetLit: [] });

test('the solver reproduces the P5 rules for batteries and bulbs in series and parallel', () => {
  assert.deepEqual(lit(panel([battery(), bulb('A')])), { A: 1 });
  assert.deepEqual(lit(panel([battery(), bulb('A'), bulb('B')])), { A: 0.25, B: 0.25 });
  assert.deepEqual(lit(panel([battery(), battery(), bulb('A')])), { A: 4 });
  assert.deepEqual(lit(panel([battery(), parallel([bulb('A')], [bulb('B')])])), { A: 1, B: 1 });
  assert.deepEqual(lit(panel([battery(), bulb('A'), parallel([bulb('B')], [sw('S1', 'open'), bulb('C')])])), { A: 0.25, B: 0.25, C: 0 });
  assert.deepEqual(lit(panel([battery(), bulb('B'), parallel([bulb('A')], [wire()])])), { A: 0, B: 1 }, 'a bulb bypassed by a wire stays off');
  assert.deepEqual(lit(panel([battery(), gap('X', 'insulator'), bulb('A')])), { A: 0 });
  assert.deepEqual(lit(panel([battery(), gap('X', 'conductor'), bulb('A')])), { A: 1 });
  assert.deepEqual(lit(panel([battery(), gap('X', 'none'), bulb('A')])), { A: 0 });
  assert.equal(solvePanel(panel([battery(), parallel([bulb('A')], [wire()])])).shortCircuit, true);
  assert.equal(solvePanel(panel([battery(), sw('S1', 'open'), bulb('A')]), ['S1']).bulbs[0].lit, true, 'switch settings can be overridden');
});

test('figure structure rules keep batteries in series and require readable labels', () => {
  assert.deepEqual(figureErrors({ panels: [panel([battery(), bulb('A')])] }), []);
  assert.match(figureErrors({ panels: [panel([parallel([battery()], [bulb('A')]), bulb('B')])] }).join(' '), /cannot hold a battery/);
  assert.deepEqual(figureErrors({ panels: [panel([battery(), bulb(''), bulb('A')])] }), [], 'a bulb the question never names may stay unlabelled');
  assert.match(figureErrors({ panels: [panel([battery(), bulb('AB')])] }).join(' '), /short label/);
  assert.match(figureErrors({ panels: [panel([battery(), sw('', 'open'), bulb('A')])] }).join(' '), /short label/);
  assert.match(figureErrors({ panels: [panel([battery(), bulb('A'), bulb('A')])] }).join(' '), /different/);
  assert.match(figureErrors({ panels: [panel([battery(), bulb('A')], 'A'), panel([battery(), bulb('A')], 'A')] }).join(' '), /different letter/);
  assert.match(figureErrors({ panels: [panel([bulb('A'), bulb('B')])] }).join(' '), /no battery/);
});

test('bulb comparisons cover the named bulbs in every panel and leave unnamed bulbs out', () => {
  const figure = { panels: [
    panel([battery(), bulb(''), bulb('P')], 'A'),
    panel([battery(), parallel([bulb('Q')], [bulb('')])], 'B'),
    panel([battery(), battery(), bulb('R'), bulb('')], 'C'),
    panel([battery(), bulb('S')], 'D'),
  ] };
  const check = kind => ({ kind, options: ['P', 'Q', 'R', 'S'].map((l, i) => ({ optionId: i + 1, bulbs: [l], circuit: '', closedSwitches: [] })), targetLit: [] });
  const dimmest = verifyFigure(figure, check('dimmest_bulb'), options(['P', 'Q', 'R', 'S']), 1);
  assert.equal(dimmest.status, 'pass', dimmest.detail);
  assert.match(dimmest.detail, /bulb P is the dimmest \(P 0\.25, Q 1, R 1, S 1;/, 'the unnamed bulb beside P is just as dim but is not an option');
  assert.match(verifyFigure(figure, check('brightest_bulb'), options(['P', 'Q', 'R', 'S']), 2).detail, /Q, R and S are equally bright/);
  const clash = structuredClone(figure);
  clash.panels[3].elements[1].label = 'P';
  assert.match(verifyFigure(clash, check('dimmest_bulb'), options(['P', 'Q', 'R', 'S']), 1).detail, /different label across the circuits/);
  assert.match(describeFigure(figure), /Circuit A: one loop with a battery, a bulb and bulb P,/);
});

test('the constructed examples pass and the wrong-key fixture fails on the solved circuit', () => {
  for (const example of examples) {
    const result = validateItem(draftToItem(example.draft, curriculum));
    assert.equal(result.results.find(r => r.id === 'circuit_logic').status, 'pass', example.id);
    assert.equal(result.blocking, 0, example.id);
  }
  const fault = createFixtures().find(f => f.id === 'circuit-wrong-key');
  const check = validateItem(fault.item).results.find(r => r.id === 'circuit_logic');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /A and B light; C does not\. That is option 2, but the key says option 4/);
});

test('verification rejects ties, unreadable dimmest questions, mislabelled options and short circuits', () => {
  const two = { panels: [panel([battery(), parallel([bulb('A')], [bulb('B')])])] };
  const brightest = { kind: 'brightest_bulb', options: ['A', 'B', 'A', 'B'].map((b, i) => ({ optionId: i + 1, bulbs: [b], circuit: '', closedSwitches: [] })), targetLit: [] };
  assert.match(verifyFigure(two, brightest, options(['A', 'B', 'Bulb A', 'Bulb B']), 1).detail, /equally bright/);
  const offBulb = { panels: [panel([battery(), bulb('A'), parallel([bulb('B')], [sw('S1', 'open'), bulb('C')])])] };
  assert.match(verifyFigure(offBulb, { ...brightest, kind: 'dimmest_bulb' }, options(['A', 'B', 'C', 'A']), 1).detail, /does not light/);
  const mislabelled = verifyFigure(offBulb, litCheck([['A'], ['A', 'B'], ['B', 'C'], ['A', 'B', 'C']]), options(['A only', 'A and C only', 'B and C only', 'A, B and C']), 2);
  assert.equal(mislabelled.status, 'fail');
  assert.match(mislabelled.detail, /option 2 reads "A and C only" but is mapped to A and B/);
  const free = verifyFigure(offBulb, litCheck([['A'], ['A', 'B'], ['B', 'C'], ['A', 'B', 'C']]), options(['A only', 'A and B only', 'B and C only', 'Every bulb except none']), 2);
  assert.equal(free.status, 'pass');
  assert.match(free.detail, /option 4 was not machine-read/);
  const shorted = { panels: [panel([battery(), parallel([bulb('A')], [wire()])])] };
  assert.match(verifyFigure(shorted, litCheck([['A'], [], ['A'], []]), options(['A', 'None', 'A only', 'No bulb']), 2).detail, /short-circuits the battery/);
  assert.equal(verifyFigure(offBulb, { kind: 'none', options: [], targetLit: [] }, options(['1', '2', '3', '4']), 1).status, 'not_run');
});

test('switch-setting questions are solved for every option', () => {
  const figure = { panels: [panel([battery(), parallel([sw('S1', 'open'), bulb('A')], [sw('S2', 'open'), bulb('B')])])] };
  const settings = [['S1'], ['S2'], ['S1', 'S2'], []];
  const check = { kind: 'switch_setting', options: settings.map((closedSwitches, i) => ({ optionId: i + 1, bulbs: [], circuit: '', closedSwitches })), targetLit: ['A'] };
  const texts = options(['Close S1 only', 'Close S2 only', 'Close S1 and S2', 'Close no switches']);
  assert.equal(verifyFigure(figure, check, texts, 1).status, 'pass');
  assert.match(verifyFigure(figure, check, texts, 3).detail, /That is option 1, but the key says option 3/);
  const setting = closed => ({ kind: 'switch_setting', options: closed.map((closedSwitches, i) => ({ optionId: i + 1, bulbs: [], circuit: '', closedSwitches })), targetLit: ['A'] });
  const bypass = { panels: [panel([battery(), bulb('A'), parallel([bulb('B')], [sw('S1', 'open')])])] };
  assert.match(verifyFigure(bypass, setting([['S1'], [], ['S1'], []]), options(['S1', 'None', 'S1 only', 'No switch']), 1).detail, /Options 1 and 3 all match/);
  const shorting = { panels: [panel([battery(), parallel([bulb('A')], [sw('S1', 'open')])])] };
  assert.match(verifyFigure(shorting, setting([['S1'], [], [], []]), options(['S1', 'None', 'No switch', 'Neither']), 2).detail, /option 1\) short-circuits the battery/);
});

test('pupils and the blind solver never see what a gap is made of', () => {
  const figure = { panels: [panel([battery(), gap('X', 'insulator'), bulb('A')])] };
  assert.doesNotMatch(describeFigure(figure), /insulator|conductor/);
  assert.equal(pupilFigure(figure).panels[0].elements[1].material, 'unknown');
  const svg = renderFigureSvg(figure);
  assert.match(svg, /^<svg[^>]+role="img"/);
  assert.doesNotMatch(svg, /insulator|conductor/);
  assert.doesNotMatch(renderFigureSvg({ panels: [panel([battery(), bulb('A')], '<b>')] }), /<b>/, 'labels are escaped');
  const draft = structuredClone(examples[1].draft);
  draft.figure.panels[0].elements.splice(1, 0, gap('X', 'conductor'));
  const item = draftToItem(draft, curriculum);
  const prompt = batchBlindPrompt([{ id: 'x', item }], curriculum);
  assert.ok(!prompt.includes('"figure"') && !prompt.includes('conductor"'));
  assert.match(prompt, /object X placed across a gap/);
  assert.equal(textOnlyQuestion(item.student_question).figure, undefined);
});

test('a figure draft fits the strict draft schema and the stored item schema', () => {
  const [example] = examples;
  assert.deepEqual(schemaErrors({ questions: [example.draft] }, draftSchema), []);
  const item = draftToItem(example.draft, curriculum);
  assert.equal(validateItem(item).results.find(r => r.id === 'structure').status, 'pass');
  assert.match(item.student_question.diagram_alt, /^Circuit A: one loop with a battery, bulb P and bulb Q/);
  assert.equal(item.figure_check.kind, 'brightest_circuit');
  const noFigure = draftToItem({ ...example.draft, figure: { panels: [] }, verification: { kind: 'none', options: [], targetLit: [] } }, curriculum);
  assert.equal(noFigure.student_question.figure, undefined);
  assert.equal(noFigure.figure_check, undefined);
  assert.match(printableRecord({ id: 'r', title: 't', status: 'draft', version: 1, updatedAt: '', provenance: { label: 'x' }, item, checks: null, reviewEvents: [] }), /<svg/);
});

test('the server serves the shared circuit module and keeps gap materials out of practice', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcc-circuit-test-'));
  const draft = structuredClone(examples[1].draft);
  draft.figure.panels[0].elements.splice(1, 0, gap('X', 'conductor'));
  draft.context += ' Object X is a steel paper clip.';
  const app = createApp({ dataDir: dir, providerStatus: () => [{ id: 'codex', available: true, label: 'codex' }], runStructured: async (provider, prompt, schema) => schema === 'draft-schema.json'
    ? { value: { questions: [{ ...draft, family: 'material_inference', difficulty: 'Easy' }] }, model: 'mock' }
    : { value: { reviews: JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).questions.map(q => ({ id: q.id, optionId: 2, reasoning: 'Mock solve', issues: [] })) }, model: 'mock' } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, body) => { const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
  const module = await fetch(base + '/circuit.mjs');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  const start = await call('/api/batches', { provider: 'codex', count: 1, family: 'material_inference', difficulty: 'Easy' });
  for (let i = 0; i < 200 && !['completed', 'failed'].includes((await call('/api/jobs/' + start.data.jobId)).data.status); i++) await new Promise(r => setTimeout(r, 5));
  const record = app.store.all().find(r => r.item.student_question.figure);
  assert.ok(record, 'figure record stored');
  assert.equal(record.checks.results.find(r => r.id === 'circuit_logic').status, 'pass');
  const approved = await call(`/api/records/${record.id}/review`, { version: record.version, action: 'approved', reviewer: 'TEST ONLY', note: 'Simulated test approval.', attestations: { science: true, alignment: true, originality: true, difficulty: true }, reviewSeconds: 60, issueCodes: [] });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const session = await call('/api/practice/start', { count: 1 });
  const payload = JSON.stringify(session.data);
  assert.match(payload, /"material":"unknown"/);
  assert.doesNotMatch(payload, /"material":"conductor"|figure_check/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { calibrationReport, pupilBand, CALIBRATION } from '../learning.mjs';

const draft = () => ({ title: 'Test-only closed circuit question', family: 'circuit_prediction', difficulty: 'Easy', skill: 'Application', context: 'One working battery and bulb are connected in one loop with a switch. All wire contacts are secure. The switch is open.', question: 'Which change completes the conducting loop?', table: { columns: [], rows: [] }, figure: { panels: [] }, verification: { kind: 'none', options: [], targetLit: [] }, options: [{ id: 1, text: 'Close the switch.' }, { id: 2, text: 'Remove the battery.' }, { id: 3, text: 'Remove the bulb.' }, { id: 4, text: 'Leave the switch open.' }], answer: { optionId: 1, explanation: 'Closing the switch completes the conducting path.', steps: ['An open switch breaks the path.', 'Closing it completes the loop.'], distractors: [{ optionId: 2, reason: 'The circuit requires the battery.' }, { optionId: 3, reason: 'Removing the bulb breaks the loop.' }, { optionId: 4, reason: 'The path remains broken.' }] }, mappings: [{ objectiveId: 'P5-ELEC-CLOSED', evidence: 'The pupil identifies how to close the loop.' }], design: { reasoningTask: 'Predict effect of closing a switch', requiredKnowledge: ['A closed loop permits current.'], originalityRationale: 'Test fixture, not an originality assertion.' } });
const approval = v => ({ version: v, action: 'approved', reviewer: 'TEST ONLY', note: 'Simulated test approval.', attestations: { science: true, alignment: true, originality: true, difficulty: true }, reviewSeconds: 60, issueCodes: [] });
const record = (id, version = 1, difficulty = 'Easy') => ({ id, version, title: 'Question ' + id, status: 'approved', labels: { difficulty, objectives: ['P5-ELEC-CLOSED'], skill: 'Application', reviewed: true }, item: { student_question: { options: [1, 2, 3, 4].map(n => ({ id: n, text: 'Option text ' + n })) }, answer: { option_id: 1 } } });
const sessionsFor = (recordId, picks, version = 1) => picks.map(selected => ({ id: 'session-' + Math.random(), version: 1, at: '2026-10-07T00:00:00.000Z', items: [{ recordId, recordVersion: version, selected, keyed: 1, correct: selected === 1 }] }));

test('difficulty bands follow the share of pupils who chose the key', () => {
  assert.equal(pupilBand(0.8), 'Easy');
  assert.equal(pupilBand(0.79), 'Medium');
  assert.equal(pupilBand(0.5), 'Medium');
  assert.equal(pupilBand(0.49), 'Hard');
  assert.equal(CALIBRATION.minResponses, 20);
});

test('calibration needs enough responses and flags labels and distractors', () => {
  // 25 answers: 12 chose the key, 10 chose option 2, 3 chose option 3, nobody chose option 4.
  const picks = [...Array(12).fill(1), ...Array(10).fill(2), ...Array(3).fill(3)];
  const report = calibrationReport([record('q1')], sessionsFor('q1', picks));
  assert.equal(report.sessions, 25);
  assert.equal(report.responses, 25);
  const [row] = report.questions;
  assert.equal(row.n, 25);
  assert.equal(row.correct, 12);
  assert.equal(row.p, 0.48);
  assert.equal(row.band, 'Hard');
  assert.equal(row.label, 'Easy');
  assert.equal(row.agreement, false);
  assert.ok(row.interval[0] < 0.48 && row.interval[1] > 0.48 && row.interval[0] > 0.29 && row.interval[1] < 0.67);
  assert.deepEqual(row.options.map(o => [o.id, o.count, o.keyed]), [[1, 12, true], [2, 10, false], [3, 3, false], [4, 0, false]]);
  assert.equal(row.options[0].text, 'Option text 1');
  assert.deepEqual(row.flags.map(f => f.code).sort(), ['label_differs', 'weak_distractor']);
  assert.match(row.flags.find(f => f.code === 'weak_distractor').detail, /Option 4 was chosen by 0 of 25/);
  // A distractor chosen more often than the key.
  const confused = calibrationReport([record('q2', 1, 'Hard')], sessionsFor('q2', [...Array(8).fill(1), ...Array(9).fill(3), ...Array(2).fill(2), ...Array(2).fill(4)])).questions[0];
  assert.equal(confused.band, 'Hard');
  assert.equal(confused.agreement, true);
  assert.match(confused.flags.find(f => f.code === 'distractor_beats_key').detail, /option 3 \(9\) than the key, option 1 \(8\)/);
  // Too few answers: no band and no judgement, only a count.
  const few = calibrationReport([record('q3')], sessionsFor('q3', [1, 1, 2])).questions[0];
  assert.equal(few.band, null);
  assert.equal(few.agreement, null);
  assert.deepEqual(few.flags.map(f => f.code), ['few_responses']);
});

test('answers to an older version stay apart from the current version', () => {
  const report = calibrationReport([record('q1', 2)], [...sessionsFor('q1', [1, 2], 1), ...sessionsFor('q1', [1], 2)]);
  const old = report.questions.find(q => q.version === 1), current = report.questions.find(q => q.version === 2);
  assert.equal(old.current, false);
  assert.equal(old.label, null);
  assert.equal(old.options[0].text, null);
  assert.equal(current.current, true);
  assert.equal(current.n, 1);
  assert.equal(calibrationReport([], sessionsFor('gone', [1])).questions[0].title, 'Question no longer in the bank');
});

test('practice on approved questions saves anonymous responses once; the demo saves none', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcc-calibration-test-'));
  const app = createApp({ dataDir: dir, providerStatus: () => ['replay', 'codex'].map(id => ({ id, available: true, label: id })), runStructured: async (provider, prompt, schema) => {
    if (schema === 'draft-schema.json') return { value: { questions: JSON.parse(prompt.split('\n\n').at(-1)).plan.map(p => ({ ...draft(), family: p.family, difficulty: p.difficulty })) }, model: 'mock' };
    return { value: { reviews: JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).questions.map(q => ({ id: q.id, optionId: 1, reasoning: 'Fixture solve', issues: [] })) }, model: 'mock' };
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, body) => { const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() }; };
  const start = await call('/api/batches', { provider: 'codex', count: 1, family: 'circuit_prediction', difficulty: 'Easy' });
  for (let i = 0; i < 300 && !['completed', 'failed'].includes((await call('/api/jobs/' + start.data.jobId)).data.status); i++) await new Promise(r => setTimeout(r, 5));
  const id = app.store.all().find(r => r.provenance.batchId === start.data.batchId).id;
  assert.equal((await call(`/api/records/${id}/review`, approval(1))).status, 200);

  const demo = await call('/api/practice/start', { count: 1, demo: true });
  const demoResult = await call(`/api/practice/${demo.data.sessionId}/submit`, { answers: { [demo.data.questions[0].id]: 2 } });
  assert.equal(demoResult.data.responseSaved, false);
  assert.equal((await call('/api/calibration')).data.sessions, 0);

  const session = await call('/api/practice/start', { count: 1 });
  const answers = { answers: { [id]: 2 } };
  const result = await call(`/api/practice/${session.data.sessionId}/submit`, answers);
  assert.equal(result.data.responseSaved, true);
  assert.equal(result.data.correct, 0);
  assert.deepEqual((await call(`/api/practice/${session.data.sessionId}/submit`, answers)).data, result.data);
  const calibration = (await call('/api/calibration')).data;
  assert.equal(calibration.sessions, 1);
  assert.equal(calibration.responses, 1);
  const row = calibration.questions[0];
  assert.deepEqual([row.recordId, row.version, row.n, row.correct, row.band, row.current], [id, 1, 1, 0, null, true]);
  assert.equal(row.options.find(o => o.id === 2).count, 1);
  assert.match(calibration.definitions.privacy, /No names, accounts or device details/);
  // The saved entry holds only the question version and the choice.
  const exported = await fetch(base + '/api/calibration/export');
  assert.match(exported.headers.get('content-disposition'), /simcc-pupil-responses\.json/);
  const { sessions } = await exported.json();
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['at', 'id', 'items', 'version']);
  assert.deepEqual(sessions[0].items, [{ recordId: id, recordVersion: 1, selected: 2, keyed: 1, correct: false }]);
  // The evaluation data and the start-up data carry the same report.
  assert.equal((await call('/api/evaluations')).data.calibration.responses, 1);
  assert.equal((await call('/api/bootstrap')).data.calibration.questions.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'responses', 'records.json')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sqlite, buildBank, openBank, bankSummary, searchQuestions, getQuestion, reviewTag, coverage, qualityFlags, suggestTopics, gradeRange } from '../bank.mjs';
import { createApp } from '../server.mjs';

const skip = !sqlite && 'node:sqlite needs Node 22.5 or later';
const sample = fileURLToPath(new URL('../examples/bank-sample', import.meta.url));
const curriculum = JSON.parse(fs.readFileSync(new URL('../curriculum.json', import.meta.url)));
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simcc-bank-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const withDb = (file, fn, write = false) => { const db = openBank(file, { write }); try { return fn(db); } finally { db.close(); } };

// Utkarsh's raw olympiad_poc.sqlite schema, verbatim, with constructed rows.
const RAW_SCHEMA = `
CREATE TABLE source_documents (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, competition TEXT NOT NULL, grade INTEGER, grade_scope TEXT NOT NULL, document_kind TEXT NOT NULL CHECK(document_kind IN ('questions', 'solutions')), landing_url TEXT NOT NULL, download_url TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, page_count INTEGER NOT NULL, extracted_at TEXT NOT NULL, attribution TEXT NOT NULL);
CREATE TABLE questions (id INTEGER PRIMARY KEY, source_document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE, provider TEXT NOT NULL, competition TEXT NOT NULL, grade INTEGER, grade_scope TEXT NOT NULL, source_question_number INTEGER NOT NULL, section TEXT, stem TEXT NOT NULL, options_json TEXT NOT NULL, correct_option TEXT, raw_chunk TEXT NOT NULL, provenance_status TEXT NOT NULL DEFAULT 'public_sample_private_poc', UNIQUE(source_document_id, source_question_number));
CREATE INDEX idx_questions_grade ON questions(grade);
CREATE INDEX idx_questions_provider ON questions(provider);`;
function rawOlympiad(file, { enriched = false } = {}) {
  const db = new sqlite.DatabaseSync(file);
  db.exec(RAW_SCHEMA + (enriched ? ['explanation TEXT', 'subject TEXT', 'topic TEXT', 'subtopic TEXT', 'skill TEXT', 'difficulty TEXT', 'answer_source TEXT', 'depends_on_image INTEGER', 'is_complete INTEGER'].map(c => `ALTER TABLE questions ADD COLUMN ${c};`).join('') : ''));
  db.prepare("INSERT INTO source_documents VALUES (1, 'Test Olympiad', 'Constructed test paper', 5, 'Class 5', 'questions', 'https://example.org/papers', 'https://example.org/papers/5.pdf', 'raw/test_class_5.pdf', ?, 2, '2026-09-30T00:00:00Z', 'Constructed for tests.')").run('a'.repeat(64));
  db.prepare("INSERT INTO source_documents VALUES (2, 'Test Olympiad', 'Constructed test paper', NULL, 'Years 9-10', 'questions', 'https://example.org/papers', 'https://example.org/papers/9.pdf', 'raw/test_year_9.pdf', ?, 2, '2026-09-30T00:00:00Z', 'Constructed for tests.')").run('b'.repeat(64));
  const q = db.prepare('INSERT INTO questions (id, source_document_id, provider, competition, grade, grade_scope, source_question_number, stem, options_json, correct_option, raw_chunk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = [
    [1, 1, 1, 'Two bulbs are connected in series to a battery in a closed circuit. What happens if one bulb is removed?', { A: 'The other bulb goes out.', B: 'The other bulb gets brighter.', C: 'Nothing changes.', D: 'The battery stops working.' }, 'A'],
    [2, 1, 2, 'Which material is the best electrical conductor?', { A: 'copper', B: 'rubber', C: 'glass', D: 'wood SAMPLE PAPER 2026-27 Class-5 www.example.org' }, 'A'],
    [3, 1, 3, 'At wha t tr ophic le vel in th e f ood chain do pl ants be long?', { A: 'first', B: 'second', C: 'third', D: 'fourth' }, null],
    [4, 1, 4, 'Look at the diagram below. Which magnet pole attracts the north pole?', { A: 'north', B: 'south' }, 'B'],
    [5, 2, 1, 'Water moves up the xylem of a tall tree because of evaporation from the leaves. What is this pull called?', { A: 'transpiration pull', B: 'gravity', C: 'osmosis', D: 'diffusion' }, 'A'],
  ];
  for (const [id, doc, n, stem, options, key] of rows) q.run(id, doc, 'Test Olympiad', 'Constructed test paper', doc === 1 ? 5 : null, doc === 1 ? 'Class 5' : 'Years 9-10', n, stem, JSON.stringify(options), key, stem);
  if (enriched) db.exec("UPDATE questions SET explanation = 'Removing a bulb opens the loop.', subject = 'Science', topic = 'Electricity', subtopic = 'Series circuits', skill = 'Application', difficulty = 'Easy', answer_source = 'inferred', depends_on_image = 0, is_complete = 1 WHERE id = 1");
  db.close();
}
// Utkarsh's practice UI query (src/lib/bank.ts), verbatim.
const PRACTICE_SELECT = 'SELECT q.id, q.provider, q.competition, q.grade, q.grade_scope, q.source_question_number, q.stem, q.options_json, q.correct_option, q.explanation, q.subject, q.topic, q.subtopic, q.skill, q.difficulty, q.answer_source, q.depends_on_image, q.is_complete, s.attribution FROM questions q JOIN source_documents s ON s.id = q.source_document_id WHERE q.is_complete = 1 AND q.correct_option IS NOT NULL AND (q.depends_on_image IS NULL OR q.depends_on_image = 0) ORDER BY q.id';

test('the constructed sample builds a bank with syllabus tags, a solved circuit and full-text search', { skip }, t => {
  const output = path.join(tmp(t), 'bank.sqlite');
  const stats = buildBank({ output, sources: [sample], now: '2026-10-07T00:00:00.000Z' });
  assert.equal(stats.questions, 9);
  assert.equal(stats.verifiedFigures, 1);
  withDb(output, db => {
    const summary = bankSummary(db);
    assert.equal(summary.label, 'Constructed sample bank');
    assert.match(summary.notice, /not exam or olympiad questions/);
    assert.deepEqual({ questions: summary.counts.questions, pilot: summary.counts.pilot, complete: summary.counts.complete, verified: summary.counts.verifiedFigures }, { questions: 9, pilot: 6, complete: 9, verified: 1 });
    assert.equal(db.prepare('SELECT count(*) n FROM syllabus_outcomes').get().n, 147);
    assert.equal(db.prepare('SELECT count(*) n FROM syllabus_exclusions').get().n, 22);
    const found = searchQuestions(db, { q: 'bulbs series' });
    assert.equal(found.questions[0].number, 3, 'best match first');
    const circuit = getQuestion(db, searchQuestions(db, { flag: 'figure' }).questions[0].id);
    assert.equal(circuit.assets[0].checkStatus, 'pass', circuit.assets[0].checkDetail);
    assert.match(circuit.assets[0].checkDetail, /B and C light; A does not\. Only option 2 matches/);
    assert.deepEqual(circuit.flags.map(f => [f.code, f.severity]), [['may_depend_on_image', 'info']], 'a stored figure turns the image warning into a note');
    const xylem = getQuestion(db, searchQuestions(db, { q: 'xylem' }).questions[0].id);
    assert.equal(xylem.flags.find(f => f.code === 'excluded_content').severity, 'info');
    assert.deepEqual(searchQuestions(db, { flag: 'excluded_content' }).questions.map(q => q.number), [9]);
    assert.equal(searchQuestions(db, { topic: 'P3-INTERACTIONS-MAGNETS' }).total, 1);
  });
});

test('importing Utkarsh\'s raw olympiad database keeps its rows and ids and flags extraction damage', { skip }, t => {
  const dir = tmp(t), raw = path.join(dir, 'olympiad_poc.sqlite'), output = path.join(dir, 'bank.sqlite');
  rawOlympiad(raw);
  buildBank({ output, olympiad: [raw], sources: [sample] });
  withDb(output, db => {
    assert.deepEqual(db.prepare('SELECT id FROM questions WHERE id < 100 ORDER BY id').all().map(r => r.id), [1, 2, 3, 4, 5], 'olympiad ids are kept');
    const flags = id => getQuestion(db, id).flags.map(f => f.code);
    assert.deepEqual(flags(1), []);
    assert.ok(flags(2).includes('option_noise'));
    assert.ok(flags(3).includes('garbled_text') && flags(3).includes('no_answer'));
    assert.ok(flags(4).includes('few_options') && flags(4).includes('may_depend_on_image'));
    assert.ok(flags(5).includes('excluded_content'));
    const first = getQuestion(db, 1);
    assert.equal(first.profile.level, 'primary');
    assert.equal(getQuestion(db, 5).profile.level, 'secondary');
    assert.deepEqual(first.topics.map(t => [t.id, t.status, t.method]), [['P5-SYSTEMS-ELECTRICAL', 'suggested', 'keyword']]);
    assert.ok(first.outcomes.some(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-P2' && o.status === 'suggested'));
    assert.equal(first.enrichment.is_complete, null, 'raw rows are not claimed complete');
    // Utkarsh's practice UI runs unchanged and sees only complete text-only rows.
    const rows = db.prepare(PRACTICE_SELECT).all();
    assert.equal(rows.length, 8, 'the eight complete text-only sample questions; raw rows and the figure question stay out');
    assert.ok(rows.every(r => r.id > 100000 && r.is_complete === 1 && r.depends_on_image === 0));
  });
});

test('enrichment columns from an enriched olympiad database are copied for the practice UI', { skip }, t => {
  const dir = tmp(t), raw = path.join(dir, 'enriched.sqlite'), output = path.join(dir, 'bank.sqlite');
  rawOlympiad(raw, { enriched: true });
  buildBank({ output, olympiad: [raw] });
  withDb(output, db => {
    const rows = db.prepare(PRACTICE_SELECT).all();
    assert.deepEqual(rows.map(r => [r.id, r.topic, r.answer_source]), [[1, 'Electricity', 'inferred']]);
    assert.match(bankSummary(db).inputs[0].enrichment.join(' '), /is_complete/);
  });
});

test('reviewer decisions on tags are recorded and survive a rebuild', { skip }, t => {
  const dir = tmp(t), raw = path.join(dir, 'olympiad_poc.sqlite'), output = path.join(dir, 'bank.sqlite');
  rawOlympiad(raw);
  buildBank({ output, olympiad: [raw] });
  withDb(output, db => {
    assert.throws(() => reviewTag(db, 1, { target: 'outcome:P5-SYSTEMS-ELECTRICAL-S-C2', action: 'confirm', reviewer: '', note: 'x' }), /reviewer name/);
    assert.throws(() => reviewTag(db, 1, { target: 'outcome:P9-NOPE', action: 'confirm', reviewer: 'T', note: 'x' }), /topic or outcome/);
    const reviewed = reviewTag(db, 1, { target: 'outcome:P5-SYSTEMS-ELECTRICAL-S-C2', action: 'confirm', reviewer: 'Test teacher', note: 'Removing a bulb opens the loop.' }, '2026-10-07T01:00:00.000Z');
    assert.equal(reviewed.outcomes.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-C2').status, 'confirmed');
    reviewTag(db, 2, { target: 'topic:P5-SYSTEMS-ELECTRICAL', action: 'reject', reviewer: 'Test teacher', note: 'Checking the wrong row on purpose.' });
    reviewTag(db, 4, { target: 'topic:P3-INTERACTIONS-MAGNETS', action: 'confirm', reviewer: 'Test teacher', note: 'Magnet poles.' });
  }, true);
  // The second build leaves out question 4, so its decision cannot be carried.
  const db = new sqlite.DatabaseSync(raw); db.exec('DELETE FROM questions WHERE id = 4'); db.close();
  const stats = buildBank({ output, olympiad: [raw] });
  assert.deepEqual([stats.carriedReviews, stats.droppedReviews], [2, 1]);
  withDb(output, db => {
    const q = getQuestion(db, 1);
    assert.equal(q.outcomes.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-C2').status, 'confirmed');
    assert.equal(q.reviews[0].carried_from, 'bank.sqlite');
    assert.equal(getQuestion(db, 2).topics.find(t => t.id === 'P5-SYSTEMS-ELECTRICAL').status, 'rejected');
    assert.equal(searchQuestions(db, { topic: 'P5-SYSTEMS-ELECTRICAL' }).questions.some(x => x.id === 2), false, 'rejected tags drop out of topic filters');
  });
});

test('curated sources are validated before anything is written', { skip }, t => {
  const dir = tmp(t), output = path.join(dir, 'bank.sqlite');
  const doc = JSON.parse(fs.readFileSync(path.join(sample, 'sample-sources.json'), 'utf8'));
  doc.documents[0].file = path.join(sample, 'sample-sources.json');
  const write = (name, mutate) => { const copy = structuredClone(doc); mutate(copy); const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(copy)); return file; };
  assert.throws(() => buildBank({ output, sources: [write('a.json', d => { d.documents[0].questions[0].outcomes[0].id = 'P5-SYSTEMS-ELECTRICAL-S-C9'; })] }), /unknown syllabus outcome/);
  assert.throws(() => buildBank({ output, sources: [write('b.json', d => { d.documents[0].questions[0].assets = [{ kind: 'figure_image', file: 'missing.png' }]; })] }), /not found/);
  assert.throws(() => buildBank({ output, sources: [write('c.json', d => { d.documents[0].questions[0].correct_option = 'E'; })] }), /one of the option keys/);
  assert.throws(() => buildBank({ output, sources: [write('d.json', d => { d.documents[0].landing_url = 'http://example.org'; })] }), /https/);
  assert.throws(() => buildBank({ output, sources: [sample, write('e.json', () => {})] }), /Duplicate source document/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('building')), [], 'no half-built file is left behind');
});

test('quality flags, topic cues and grade bands', () => {
  assert.deepEqual(qualityFlags('Which metal conducts electricity?', { A: 'iron', B: 'wood', C: 'glass', D: 'rubber' }, 'A'), []);
  assert.deepEqual(qualityFlags('Which pair is correct? (i) roots (ii) leaves', { A: 'i and ii', B: 'ii only', C: 'i only', D: 'neither' }, 'A'), [], 'roman numerals are not broken words');
  assert.deepEqual(suggestTopics('A clinical thermometer has a kink near its bulb.').map(t => t.id), ['P4-ENERGY-HEAT'], 'a thermometer bulb is not a circuit');
  assert.deepEqual(suggestTopics('Two bulbs and a battery form a closed circuit.').map(t => t.id), ['P5-SYSTEMS-ELECTRICAL']);
  assert.deepEqual([gradeRange(null, 'Grades 4-6'), gradeRange(5, 'Class 5'), gradeRange(null, 'Primary'), gradeRange(null, 'P6')], [[4, 6], [5, 5], [1, 6], [6, 6]]);
});

async function serve(t, options) {
  const dir = tmp(t);
  const app = createApp({ dataDir: dir, providerStatus: () => [{ id: 'replay', available: true, label: 'replay' }], ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, body, headers = { 'X-CSRF-Token': app.csrfToken }) => {
    const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), data: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { app, dir, call };
}

test('the server exposes the bank, its figures, tag review and syllabus coverage', { skip }, async t => {
  const build = tmp(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(build, 'figure.png'), png);
  const doc = JSON.parse(fs.readFileSync(path.join(sample, 'sample-sources.json'), 'utf8'));
  doc.documents[0].file = path.join(sample, 'sample-sources.json');
  doc.documents[0].questions[3].assets.push({ kind: 'figure_image', file: 'figure.png', page: 1, note: 'Test image.' });
  fs.writeFileSync(path.join(build, 'sources.json'), JSON.stringify(doc));
  const bankFile = path.join(build, 'bank.sqlite');
  buildBank({ output: bankFile, sources: [path.join(build, 'sources.json')] });
  const { call } = await serve(t, { bankFile });

  const info = await call('/api/bank');
  assert.equal(info.data.counts.questions, 9);
  assert.equal(info.data.syllabus.topics.length, 18);
  assert.equal(info.data.syllabus.pilotOutcomes.length, 6);
  assert.equal((await call('/api/bootstrap')).data.bank.questions, 9);
  const list = await call('/api/bank/questions?q=switch&topic=P5-SYSTEMS-ELECTRICAL&limit=5');
  assert.equal(list.status, 200);
  assert.ok(list.data.questions.length >= 1 && list.data.questions.every(q => q.topics.some(t => t.id === 'P5-SYSTEMS-ELECTRICAL')));
  for (const bad of ['?limit=500', '?topic=NOPE', '?level=tertiary', '?flag=whatever', '?offset=-1']) assert.equal((await call('/api/bank/questions' + bad)).status, 400, bad);
  const figureQuestion = (await call('/api/bank/questions?flag=figure')).data.questions[0];
  const detail = (await call('/api/bank/questions/' + figureQuestion.id)).data.question;
  const image = detail.assets.find(a => a.kind === 'figure_image');
  const served = await call(image.url);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/png');
  assert.equal(served.csp, "default-src 'none'");
  assert.ok(served.data.equals(png));
  assert.equal((await call('/api/bank/assets/999999')).status, 404);
  assert.equal((await call('/api/bank/questions/999999')).status, 404);

  const review = { target: 'outcome:P5-SYSTEMS-ELECTRICAL-S-P2', action: 'confirm', reviewer: 'Test teacher', note: 'Checked against p.59.' };
  assert.equal((await call(`/api/bank/questions/${figureQuestion.id}/review`, review, {})).status, 403, 'tag review needs the session token');
  const reviewed = await call(`/api/bank/questions/${figureQuestion.id}/review`, review);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.question.outcomes.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-P2').status, 'confirmed');

  const cover = (await call('/api/coverage')).data;
  assert.equal(cover.bank, true);
  assert.equal(cover.topics.length, 18);
  const pilot = cover.topics.find(t => t.id === 'P5-SYSTEMS-ELECTRICAL');
  assert.deepEqual(pilot.sources, { suggested: 0, draft: 6, confirmed: 0, primary: 6 });
  const p2 = pilot.outcomeRows.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-P2');
  assert.deepEqual([p2.objective, p2.sources.draft, p2.sources.confirmed], ['P5-ELEC-VARIABLES', 2, 1]);
  const v1 = pilot.outcomeRows.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-V1');
  assert.deepEqual([v1.objective, v1.excludedFromPilot], [null, true]);
  const closed = pilot.outcomeRows.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-C2');
  assert.equal(closed.generated.total, 1, 'the seeded recorded item maps to P5-ELEC-CLOSED');
});

test('without a bank the pages explain how to build one and coverage still works', { skip }, async t => {
  const { call } = await serve(t, {});
  const info = await call('/api/bank');
  assert.equal(info.data.available, false);
  assert.match(info.data.reason, /No source bank/);
  assert.equal((await call('/api/bank/questions')).status, 409);
  const cover = await call('/api/coverage');
  assert.equal(cover.status, 200);
  assert.equal(cover.data.bank, false);
  assert.equal(cover.data.topics.find(t => t.id === 'P5-SYSTEMS-ELECTRICAL').outcomeRows.length, 6);
});

test('coverage counts each generated item once per mapped outcome', () => {
  const record = (status, ids) => ({ status, item: { syllabus_mapping: ids.map(id => ({ internal_mapping_id: id })) } });
  const result = coverage(null, [record('approved', ['P5-ELEC-VARIABLES', 'P5-ELEC-DIAGRAMS']), record('draft', ['P5-ELEC-VARIABLES'])], curriculum);
  const rows = result.topics.find(t => t.id === 'P5-SYSTEMS-ELECTRICAL').outcomeRows;
  assert.deepEqual(rows.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-P2').generated, { total: 2, approved: 1 });
  assert.deepEqual(rows.find(o => o.id === 'P5-SYSTEMS-ELECTRICAL-S-P1').generated, { total: 1, approved: 1 });
});

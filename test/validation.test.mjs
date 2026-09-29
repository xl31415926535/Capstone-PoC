import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFixtures } from '../fixtures.mjs';
import { validateItem, validateItemStructure } from '../validation.mjs';

const original = () => createFixtures()[0].item;
const result = (checks, id) => checks.results.find(r => r.id === id);

test('recorded original has one conditional solution but no human or originality certification', () => {
  const item = original();
  const checks = validateItem(item);
  assert.equal(checks.blocking, 0);
  assert.equal(checks.logic.assignmentsTested, 8);
  assert.deepEqual(checks.logic.matchingAssignments, [{ P: false, Q: true, R: true }]);
  assert.equal(checks.logic.optionId, 3);
  assert.equal(result(checks, 'local_similarity').status, 'not_run');
  assert.equal(result(checks, 'difficulty').status, 'warn');
  assert.equal(item.review_record.human_approval, 'Pending');
  assert.equal(item.review_record.ready_for_live_assessment, false);
});

test('three deliberate demonstration faults are blocked and truthfully marked', () => {
  const expected = { 'wrong-answer': 'answer_matches_logic', 'missing-assumption': 'assumptions', 'duplicate-options': 'options' };
  for (const fixture of createFixtures().slice(1)) {
    const checks = validateItem(fixture.item);
    assert.equal(fixture.mode, 'fixture');
    assert.ok(checks.blocking > 0, fixture.id);
    assert.equal(result(checks, expected[fixture.id]).status, 'fail', fixture.id);
    assert.match(fixture.item.generation_record.generator, /Deliberately modified/);
    assert.equal(fixture.item.review_record.human_reviewer, null);
  }
});

test('independent fixture calls do not share mutable item objects', () => {
  const first = createFixtures();
  first[0].item.answer.option_id = 1;
  assert.equal(first[1].item.student_question.options[0].text, 'P and Q only');
  assert.equal(createFixtures()[0].item.answer.option_id, 3);
});

test('solver derives result from observations instead of hardcoding option 3', () => {
  const item = original();
  item.student_question.observations[1].gap_X = 'P';
  item.answer.option_id = 2;
  item.answer.conductors = ['P', 'R'];
  item.answer.insulators = ['Q'];
  item.distractor_rationales = [1, 3, 4].map(option_id => ({ option_id, issue: 'Requires human review of this newly varied case.' }));
  const checks = validateItem(item);
  assert.equal(checks.logic.optionId, 2);
  assert.deepEqual(checks.logic.matchingAssignments, [{ P: true, Q: false, R: true }]);
  assert.equal(result(checks, 'answer_matches_logic').status, 'pass');
  assert.equal(checks.blocking, 0);
});

test('ambiguous and contradictory observation sets fail', () => {
  const ambiguous = original();
  ambiguous.student_question.observations[1].bulb = 'does not light';
  const a = validateItem(ambiguous);
  assert.ok(a.logic.matchingAssignments.length > 1);
  assert.equal(result(a, 'circuit_logic').status, 'fail');
  const contradictory = original();
  contradictory.student_question.observations[1].gap_X = 'P';
  contradictory.student_question.observations[1].gap_Y = 'Q';
  const b = validateItem(contradictory);
  assert.equal(b.logic.matchingAssignments.length, 0);
  assert.equal(result(b, 'circuit_logic').status, 'fail');
});

test('missing stem assumptions cannot be repaired by metadata claims', () => {
  const item = original();
  item.student_question.stem = item.student_question.stem.replace('The battery, bulb and wires work properly in both tests.', '');
  item.generation_blueprint += ' The battery, bulb and wires work properly in both tests.';
  const checks = validateItem(item);
  assert.equal(result(checks, 'assumptions').status, 'fail');
  assert.equal(result(checks, 'circuit_logic').status, 'not_run');
  assert.equal(checks.logic, null);
});

test('unsupported topology, question wording or natural-language options never receive a logic pass', () => {
  for (const mutate of [
    i => { i.student_question.stem += ' There is also a bypass wire.'; },
    i => { i.student_question.diagram_alt = 'The gaps lie in parallel branches.'; },
    i => { i.student_question.question = 'Which strips are electrical insulators?'; },
    i => { i.student_question.options[0].text = 'Any two strips are suitable'; },
  ]) {
    const item = original(); mutate(item);
    const checks = validateItem(item);
    assert.equal(result(checks, 'circuit_logic').status, 'not_run');
    assert.equal(checks.logic, null);
  }
});

test('equivalent conductor choices are duplicates even when wording order differs', () => {
  const item = original();
  item.student_question.options[3].text = 'R and Q only';
  const checks = validateItem(item);
  assert.equal(result(checks, 'options').status, 'fail');
  assert.equal(result(checks, 'circuit_logic').status, 'fail');
});

test('malformed nested inputs report failures without throwing', () => {
  const malformed = [null, undefined, {}, [], 'incorrect'];
  for (const value of malformed) assert.ok(validateItem(value).blocking > 0);
  for (const mutate of [
    i => { i.student_question = null; },
    i => { i.student_question.options = [null, {}, false, { id: 1, text: '' }]; },
    i => { i.student_question.observations = [null, {}]; },
    i => { i.answer = null; },
    i => { i.syllabus_mapping = [null]; },
    i => { i.sources = [null]; },
    i => { i.distractor_rationales = [null]; },
  ]) {
    const item = original(); mutate(item);
    assert.ok(validateItem(item).blocking > 0);
  }
});

test('wrong types, unknown fields, fake approval, absent choices and bad observations fail', () => {
  for (const mutate of [
    i => { i.student_question.options[0].id = '1'; },
    i => { i.answer.option_id = 99; },
    i => { i.student_question.observations[0].bulb = 'dim'; },
    i => { i.student_question.observations[0].gap_X = 'S'; },
    i => { i.student_question.observations[0].test = 2; },
    i => { i.student_question.observations[0].gap_Y = 'P'; },
    i => { i.unsupported_field = true; },
    i => { i.review_record.human_approval = 'Approved'; },
    i => { i.answer.explanation_en = '   '; },
  ]) {
    const item = original(); mutate(item);
    assert.ok(validateItem(item).blocking > 0);
  }
});

test('syllabus labels require both scoped objectives, explicit evidence, page and actual approved references', () => {
  for (const mutate of [
    i => { i.syllabus_mapping[0].internal_mapping_id = 'P5-INVENTED'; },
    i => { i.syllabus_mapping[0].item_evidence = ' '; },
    i => { i.syllabus_mapping[0].printed_page = 60; },
    i => { i.syllabus_mapping[0].official_code = 'Claimed official MOE code'; },
    i => { i.sources[0].url = 'https://example.com/fake-syllabus'; },
    i => { i.sources[0].url = 'javascript:alert(1)'; },
  ]) {
    const item = original(); mutate(item);
    assert.ok(validateItem(item).blocking > 0);
  }
});

test('lexical similarity is local-only and uses question text rather than metadata', () => {
  const item = original();
  const comparison = structuredClone(item);
  comparison.item_id = 'OTHER';
  comparison.generation_record.generator = 'Different metadata';
  const checks = validateItem(item, [{ id: 'local-record', item: comparison }]);
  assert.equal(checks.similarity.score, 1);
  assert.equal(checks.similarity.corpusSize, 1);
  assert.equal(checks.similarity.bestMatchId, 'local-record');
  assert.match(checks.similarity.method, /not an originality certificate/);
  assert.equal(result(checks, 'local_similarity').status, 'warn');
  const none = validateItem(item, [null, {}]);
  assert.equal(none.similarity.corpusSize, 0);
});

test('every output-schema object is strict with all properties required', () => {
  for (const file of ['schema.json', 'blind-schema.json']) {
    const schema = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    function walk(node) {
      if (node.type === 'object') {
        assert.equal(node.additionalProperties, false);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      }
      if (node.properties) Object.values(node.properties).forEach(walk);
      if (node.items) walk(node.items);
      if (node.anyOf) node.anyOf.forEach(walk);
    }
    walk(schema);
  }
});

test('persisted review states stay structurally valid while generation cannot claim approval', () => {
  for (const status of ['draft', 'approved', 'changes_requested', 'rejected']) {
    const item = original();
    item.status = status === 'draft' ? 'draft_pending_human_review' : status;
    item.review_record.human_approval = status;
    item.review_record.human_reviewer = status === 'draft' ? null : 'Prototype reviewer';
    const checks = validateItem(item);
    assert.equal(result(checks, 'structure').status, 'pass', status);
    assert.equal(checks.blocking, 0, status);
    assert.deepEqual(validateItemStructure(item), []);
    assert.ok(validateItemStructure(item, { generated: true }).length > 0);
  }
  assert.deepEqual(validateItemStructure(original(), { generated: true }), []);
});

test('persisted review fields reject unknown states and invalid types', () => {
  for (const mutate of [
    i => { i.status = 'published'; },
    i => { i.status = null; },
    i => { i.review_record.human_approval = 'approved_by_model'; },
    i => { i.review_record.human_approval = true; },
    i => { i.review_record.human_reviewer = {}; },
    i => { i.review_record.human_reviewer = 42; },
    i => { i.review_record.human_reviewer = '   '; },
    i => { i.review_record.ready_for_live_assessment = true; },
  ]) {
    const item = original(); mutate(item);
    assert.equal(result(validateItem(item), 'structure').status, 'fail');
  }
});

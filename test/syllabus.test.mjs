import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syllabus, outcomes, screenText } from '../syllabus.mjs';
import { validateItem } from '../validation.mjs';
import { draftToItem, draftSchema, generationPrompt, makePlan } from '../model-v2.mjs';
import { schemaErrors } from '../validation.mjs';

const curriculum = JSON.parse(fs.readFileSync(new URL('../curriculum.json', import.meta.url)));
const draft = (patch = {}) => ({
  title: 'Test-only series bulbs question', family: 'circuit_prediction', difficulty: 'Medium', skill: 'Application',
  context: 'One battery is connected to one bulb in a closed loop. A second identical bulb is then added in series in the same loop. All contacts are secure and every part works.',
  question: 'How does the brightness of the first bulb change?', table: { columns: [], rows: [] },
  options: [{ id: 1, text: 'It becomes dimmer.' }, { id: 2, text: 'It becomes brighter.' }, { id: 3, text: 'It stays the same.' }, { id: 4, text: 'It goes out.' }],
  answer: { optionId: 1, explanation: 'Adding a bulb in series makes the current in the loop smaller, so each bulb is dimmer.', steps: ['Both bulbs are in one loop.', 'More bulbs in series means a smaller current.'], distractors: [{ optionId: 2, reason: 'A smaller current cannot make the bulb brighter.' }, { optionId: 3, reason: 'The current changes when a bulb is added in series.' }, { optionId: 4, reason: 'The loop is still closed, so current still flows.' }] },
  mappings: [{ objectiveId: 'P5-ELEC-VARIABLES', evidence: 'Predicts the effect of adding a bulb in series.' }],
  design: { reasoningTask: 'Predict brightness after adding a series bulb', requiredKnowledge: ['More bulbs in series give a smaller current.'], originalityRationale: 'Test fixture only.' },
  ...patch,
});
const excluded = item => validateItem(item).results.find(r => r.id === 'excluded_content');

test('the full 2023 syllabus has 18 topics across P3-P6 with unique outcome IDs and page references', () => {
  assert.equal(syllabus.topics.length, 18);
  assert.deepEqual([...new Set(syllabus.topics.map(t => t.level))].sort(), ['P3', 'P4', 'P5', 'P6']);
  assert.deepEqual(syllabus.themes, ['Diversity', 'Cycles', 'Systems', 'Interactions', 'Energy']);
  const ids = syllabus.topics.flatMap(t => t.outcomes.map(o => o.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const topic of syllabus.topics) for (const o of topic.outcomes) {
    assert.ok(o.page >= 38 && o.page <= 80, o.id);
    assert.ok(Object.values(topic.streams).some(s => s.pages.includes(o.page)), o.id);
  }
  // P5 and P6 topics have Standard and Foundation pages, except Energy Conversion (Standard only).
  for (const topic of syllabus.topics.filter(t => t.level >= 'P5')) assert.equal(!!topic.streams.foundation, topic.id !== 'P6-ENERGY-CONVERSION', topic.id);
});

test('page 59 outcomes are quoted exactly and every pilot objective points at one of them', () => {
  const variables = outcomes.get('P5-SYSTEMS-ELECTRICAL-S-P2');
  assert.equal(variables.text, 'Investigate the effect of some variables on the current in a circuit.');
  assert.deepEqual(variables.points, ['Number of batteries (arranged in series)', 'Number of bulbs (arranged in series and parallel)']);
  assert.deepEqual(outcomes.get('P5-SYSTEMS-ELECTRICAL-F-P2').points, ['Number of batteries (arranged in series)', 'Number of bulbs (arranged in series)']);
  assert.equal(curriculum.objectives.length, 5);
  for (const objective of curriculum.objectives) {
    const outcome = outcomes.get(objective.outcomeId);
    assert.ok(outcome, objective.id);
    assert.equal(outcome.page, objective.page);
    assert.equal(outcome.stream, 'standard');
  }
  assert.ok(curriculum.excludedOutcomes.every(e => outcomes.has(e.outcomeId)));
});

test('each of the 22 "not required" notes is quoted verbatim from the outcome tables', () => {
  assert.equal(syllabus.exclusions.length, 22);
  const notes = syllabus.topics.flatMap(t => t.outcomes.flatMap(o => o.notes.map(note => ({ id: o.id, note }))));
  for (const exclusion of syllabus.exclusions) {
    assert.match(exclusion.note, /not required/, exclusion.id);
    for (const outcomeId of exclusion.outcomeIds) assert.ok(notes.some(n => n.id === outcomeId && n.note.includes(exclusion.note.slice(0, 40))), exclusion.id);
    for (const pattern of [...exclusion.block, ...exclusion.flag]) assert.doesNotThrow(() => new RegExp(pattern, 'i'));
  }
  const distinct = new Set(notes.filter(n => /not required/.test(n.note)).map(n => n.note.replace('xylem, phloem and stomata', 'xylem, phloem, stomata')));
  assert.equal(distinct.size, 22);
});

test('screening blocks precise excluded terms, warns on looser ones and allows in-scope circuit ideas', () => {
  const ids = text => screenText(text).map(h => `${h.id}:${h.severity}`);
  assert.deepEqual(ids('Water moves up the xylem.'), ['NR-P5-TRANSPORT-TERMS:block', 'NR-P5-XYLEM-PHLOEM:block']);
  assert.deepEqual(ids('Two batteries are connected in parallel.'), ['SCOPE-ELEC-BATTERIES-SERIES:block']);
  assert.deepEqual(ids('One battery lights two bulbs connected in parallel.'), []);
  assert.deepEqual(ids('The second circuit has a higher voltage.'), ['SCOPE-ELEC-QUALITATIVE:block']);
  assert.deepEqual(ids('A working low-voltage battery lights the bulb.'), ['SCOPE-ELEC-QUALITATIVE:flag']);
  assert.deepEqual(ids('A transparent sheet covers the bulb.'), ['NR-P3-TRANSPARENCY-TERMS:flag', 'NR-P4-TRANSPARENCY-TERMS:flag']);
  assert.deepEqual(ids('Which metal, copper or steel, gets hot faster when heated?'), ['NR-P4-HEAT-TRANSFER-RATES:flag']);
  assert.deepEqual(ids('An iron nail and a copper wire both conduct electricity.'), []);
});

test('generated items using excluded content fail the check; warnings never block', () => {
  assert.equal(excluded(draftToItem(draft(), curriculum)).status, 'pass');
  const blocked = draft();
  blocked.answer = { ...blocked.answer, explanation: 'Adding a bulb increases the resistance, so the current is smaller.' };
  const result = validateItem(draftToItem(blocked, curriculum));
  assert.equal(result.results.find(r => r.id === 'excluded_content').status, 'fail');
  assert.match(result.results.find(r => r.id === 'excluded_content').detail, /resistance/);
  const warned = draft({ context: 'A transparent box holds one battery and one bulb in a closed loop. A second identical bulb is then added in series.' });
  const warning = validateItem(draftToItem(warned, curriculum));
  assert.equal(warning.results.find(r => r.id === 'excluded_content').status, 'warn');
  assert.equal(warning.results.filter(r => r.status === 'fail').length, 0);
});

test('the new objectives flow from the draft schema into page 59 mappings', () => {
  const d = draft({ mappings: [{ objectiveId: 'P5-ELEC-VARIABLES', evidence: 'Series bulbs.' }, { objectiveId: 'P5-ELEC-DIAGRAMS', evidence: 'Reads the loop.' }, { objectiveId: 'P5-ELEC-SYSTEM', evidence: 'Names the parts.' }] });
  assert.deepEqual(schemaErrors({ questions: [d] }, draftSchema), []);
  const item = draftToItem(d, curriculum);
  assert.deepEqual(item.syllabus_mapping.map(m => [m.internal_mapping_id, m.printed_page, m.source_id]), [['P5-ELEC-VARIABLES', 59, 'MOE-2023'], ['P5-ELEC-DIAGRAMS', 59, 'MOE-2023'], ['P5-ELEC-SYSTEM', 59, 'MOE-2023']]);
  assert.equal(validateItem(item).results.find(r => r.id === 'syllabus_mapping').status, 'pass');
  assert.ok(schemaErrors({ questions: [draft({ mappings: [{ objectiveId: 'P5-ELEC-VOLTAGE', evidence: 'x' }] })] }, draftSchema).length);
});

test('the generation prompt carries official outcome wording and exclusions, not screening patterns', () => {
  const prompt = generationPrompt(makePlan(2), curriculum);
  const payload = JSON.parse(prompt.split('\n\n').at(-1));
  assert.match(payload.curriculum.objectives.find(o => o.id === 'P5-ELEC-VARIABLES').syllabusOutcome, /Number of bulbs \(arranged in series and parallel\)/);
  assert.equal(payload.curriculum.notRequired.length, 22);
  assert.ok(payload.curriculum.scope.some(s => /series only/.test(s)));
  assert.ok(!prompt.includes('\\b'));
  assert.ok(!/brightness comparisons/.test(prompt));
});

import { readFileSync } from 'node:fs';
import { draftToItem } from './model-v2.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

// Saved original demonstration, not a fresh model response or official exam item.
export function createFixtures() {
  const original = JSON.parse(readFileSync(new URL('./recorded-item.json', import.meta.url), 'utf8'));
  const build = (id, label, description, mutate) => {
    const item = structuredClone(original);
    if (mutate) {
      item.item_id = `${original.item_id}-${id.toUpperCase()}`;
      item.generation_record.generator = 'Deliberately modified local test fixture based on the saved assistant-authored demonstration';
      item.generation_record.design_summary = description;
      item.review_record.independent_review = 'The original item had a same-model blind review. This deliberately modified fixture has not been independently reviewed.';
      item.review_record.logic_check = 'Recalculate local checks for this modified fixture.';
      item.review_record.revision = description;
      item.review_record.originality_check = 'This deliberately modified fixture is derived from the recorded demonstration. It is not a new original item and has no independent originality clearance.';
      item.review_record.difficulty_check = 'Not calibrated; the deliberate defect makes difficulty claims unsuitable.';
      item.review_record.language_check = 'Modified test fixture; not independently checked for classroom use.';
      mutate(item);
    }
    item.status = 'draft_pending_human_review';
    item.review_record.human_reviewer = null;
    item.review_record.human_approval = 'Pending';
    item.review_record.ready_for_live_assessment = false;
    return { id, label, description, item, mode: mutate ? 'fixture' : 'replay' };
  };
  // Circuit-figure examples written by the project team (examples/circuit-examples.json).
  const curriculum = read('./curriculum.json');
  const constructed = (example, number, mode = 'constructed') => {
    const item = draftToItem(example.draft, curriculum);
    item.item_id = `SIMCC-DEMO-P5-ELEC-FIG-0${number}`;
    item.created_on = '2026-10-07';
    item.generation_record = { generator: 'Constructed by the project team to demonstrate circuit figures; not model output', external_commercial_model_api_calls: 0, source_paper_rewritten: false, question_observations: 'Constructed example; not measurements from a physical experiment.', design_summary: example.description };
    item.status = 'draft_pending_human_review';
    return { id: example.id, label: example.label, description: example.description, item, mode };
  };
  const [brightness, switchExample] = read('./examples/circuit-examples.json').drafts;
  const wrongKey = constructed(switchExample, 3, 'fixture');
  Object.assign(wrongKey, { id: 'circuit-wrong-key', label: 'Fault: circuit key ignores the open switch', description: 'Deliberate fault: the key says bulbs A, B and C all light, ignoring the open switch S1. The figure is unchanged.' });
  wrongKey.item.item_id += '-WRONG-KEY';
  wrongKey.item.generation_record.generator = 'Deliberately modified local test fixture based on a constructed circuit example';
  wrongKey.item.generation_record.design_summary = wrongKey.description;
  wrongKey.item.answer.option_id = 4;
  wrongKey.item.distractor_rationales = [
    { option_id: 1, issue: 'Leaves out bulbs B and C.' },
    { option_id: 2, issue: 'Leaves out bulb C.' },
    { option_id: 3, issue: 'Leaves out bulb A.' },
  ];
  return [
    build('original', 'Recorded original sample', 'Replay of the previously created original P5 electricity item. No live model call.'),
    build('wrong-answer', 'Fault: wrong answer key', 'Deliberate fault: the keyed answer is changed from option 3 to option 1. The observations are unchanged.', item => {
      item.answer.option_id = 1;
    }),
    build('missing-assumption', 'Fault: missing material assumption', 'Deliberate fault: the explicit good-conductor-or-insulator assumption is removed from the student-visible stem.', item => {
      item.student_question.stem = item.student_question.stem.replace(' Each strip is either a good electrical conductor or an electrical insulator.', '');
    }),
    build('duplicate-options', 'Fault: duplicate choices', 'Deliberate fault: option 4 is replaced with the same text as option 3, leaving two equivalent answer choices.', item => {
      item.student_question.options[3].text = item.student_question.options[2].text;
    }),
    constructed(brightness, 1),
    constructed(switchExample, 2),
    wrongKey,
  ];
}

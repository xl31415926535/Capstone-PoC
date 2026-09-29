import { readFileSync } from 'node:fs';

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
  ];
}

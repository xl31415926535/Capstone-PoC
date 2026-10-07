// Build the source-question bank (SQLite) from Utkarsh's olympiad database
// and/or curated JSON sources. The output is rebuilt from scratch each time;
// reviewer decisions in an existing output file are carried over.
//
//   node scripts/import-bank.mjs --olympiad olympiad_poc.sqlite --sources bank/sources --output data/question-bank.sqlite
//
// Keep real papers and the built file out of git (data/ is ignored).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildBank, bankSummary, openBank } from '../bank.mjs';

const { values } = parseArgs({
  options: {
    olympiad: { type: 'string', multiple: true, default: [] },
    sources: { type: 'string', multiple: true, default: [] },
    output: { type: 'string', default: path.join('data', 'question-bank.sqlite') },
    label: { type: 'string' },
    'no-carry': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: node scripts/import-bank.mjs [--olympiad file.sqlite]... [--sources file-or-folder]... [--output file] [--label text] [--no-carry]');
  process.exit(0);
}
try {
  const stats = buildBank({ output: values.output, olympiad: values.olympiad, sources: values.sources, label: values.label, previous: values['no-carry'] ? null : values.output });
  const db = openBank(values.output);
  const summary = bankSummary(db);
  db.close();
  console.log(`Built ${values.output}: ${summary.label}`);
  console.log(`  ${summary.counts.documents} documents, ${summary.counts.questions} questions (${summary.counts.primary} primary level, ${summary.counts.withKey} with an answer key, ${summary.counts.clean} without extraction warnings)`);
  console.log(`  ${summary.counts.pilot} tagged to the pilot topic; ${summary.counts.withFigure} with figures, ${stats.verifiedFigures} circuit figure(s) solved to the official key`);
  console.log(`  ${summary.counts.complete} marked complete for the practice UI; ${stats.carriedReviews} reviewer decision(s) carried over${stats.droppedReviews ? `, ${stats.droppedReviews} dropped (question no longer present)` : ''}`);
  for (const f of summary.flags) console.log(`  ${f.severity === 'warn' ? 'warning' : 'note'} ${f.code}: ${f.n}`);
} catch (error) {
  console.error('Import failed: ' + error.message);
  process.exitCode = 1;
}

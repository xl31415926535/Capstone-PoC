// Retrieval pilot: paired runs of the same plan with and without source
// questions in the generation prompt, through a running Science Studio.
//
//   node scripts/retrieval-pilot.mjs --dry-run [--bank data/question-bank.sqlite]
//   node scripts/retrieval-pilot.mjs --server http://127.0.0.1:4317 --provider codex --pairs 2 --count 5
//
// A dry run makes no model call: it prints the plan, the source questions that
// retrieval would add and the prompt sizes. A live run alternates the order
// (without then with, then with then without) and prints the pooled comparison
// for the runs it made. Human acceptance fills in as reviewers decide in the app;
// the Evaluation page shows the same comparison over all runs.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makePlan, retrievalQueries, generationPrompt } from '../model-v2.mjs';
import { compareConditions } from '../learning.mjs';
import { openBank, retrieveReferences, bankSummary } from '../bank.mjs';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'print-prompt': { type: 'boolean', default: false },
    bank: { type: 'string', default: process.env.SIMCC_BANK_DB || path.join('data', 'question-bank.sqlite') },
    server: { type: 'string', default: 'http://127.0.0.1:4317' },
    provider: { type: 'string', default: 'codex' },
    'blind-provider': { type: 'string' },
    pairs: { type: 'string', default: '1' },
    count: { type: 'string', default: '5' },
    family: { type: 'string', default: 'balanced' },
    difficulty: { type: 'string', default: 'Mixed' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: node scripts/retrieval-pilot.mjs --dry-run [--bank file] [--count 5] [--family balanced] [--difficulty Mixed] [--print-prompt]\n       node scripts/retrieval-pilot.mjs [--server url] [--provider codex] [--blind-provider id] [--pairs 1] [--count 5] [--family balanced] [--difficulty Mixed] [--out report.json]');
  process.exit(0);
}
const count = Number(values.count), pairs = Number(values.pairs);
const fail = message => { console.error(message); process.exit(1); };
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) fail('--pairs must be 1 to 10.');
let plan;
try { plan = makePlan(count, values.family, values.difficulty); } catch (error) { fail(error.message); }
const percent = n => n === null || n === undefined ? '—' : Math.round(n * 100) + '%';

if (values['dry-run']) {
  const curriculum = JSON.parse(fs.readFileSync(new URL('../curriculum.json', import.meta.url), 'utf8'));
  let db;
  try { db = openBank(values.bank); } catch (error) { fail(`${error.message} (looked for ${values.bank})`); }
  const queries = retrievalQueries(plan), references = retrieveReferences(db, queries, { k: 6 }), label = bankSummary(db).label;
  db.close();
  const families = [...new Set(plan.map(p => p.family))];
  console.log(`Dry run, no model call. Bank: ${label}`);
  console.log(`Plan: ${plan.length} question(s); families ${families.join(', ')}; difficulty ${values.difficulty}`);
  if (!references.length) console.log('Retrieval found no usable P5 electricity questions in this bank, so a live run with retrieval would be refused.');
  for (const r of references) console.log(`  ${r.ref} ${r.source}${r.matchedFor.length ? ` (matched ${r.matchedFor.join(', ')})` : ' (fills the set; no word match)'}\n     ${r.stem.replace(/\s+/g, ' ').slice(0, 150)}${r.stem.length > 150 ? '…' : ''}`);
  const without = generationPrompt(plan, curriculum), withRefs = generationPrompt(plan, curriculum, [], references);
  console.log(`Prompt size without retrieval: ${without.length} characters; with: ${withRefs.length} (the app also adds up to 12 existing drafts to both).`);
  if (values['print-prompt']) console.log('\n' + withRefs);
  process.exit(0);
}

// Live run against the local server.
const base = values.server.replace(/\/+$/, '');
let token;
async function call(route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status} from ${route}`);
  return data;
}
async function runBatch(retrieval) {
  const { jobId, batchId } = await call('/api/batches', { provider: values.provider, ...(values['blind-provider'] ? { blindProvider: values['blind-provider'] } : {}), count, family: values.family, difficulty: values.difficulty, retrieval });
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 30 * 60 * 1000) {
    const job = await call('/api/jobs/' + encodeURIComponent(jobId));
    if (job.stage !== last) { last = job.stage; console.log(`    ${job.stage}`); }
    if (job.status === 'completed' || job.status === 'failed') return { batchId, status: job.status, error: job.error || null };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('The run did not finish within 30 minutes. Check the server; it was not retried.');
}
try {
  const boot = await call('/api/bootstrap');
  token = boot.csrfToken;
  for (const id of [values.provider, values['blind-provider']].filter(Boolean)) if (!boot.providers.find(p => p.id === id)?.available) fail(`Provider ${id} is not configured on the server. Open Sources & setup in the app.`);
  if (!boot.bank?.available) fail('The server has no source bank, so the with-retrieval runs cannot be made. Build one with npm run bank:import.');
  const startedAt = new Date().toISOString(), runs = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const retrieval of pair % 2 === 0 ? [false, true] : [true, false]) {
      console.log(`Pair ${pair + 1} of ${pairs}: ${retrieval ? 'with' : 'without'} source questions`);
      runs.push({ pair: pair + 1, retrieval, ...await runBatch(retrieval) });
    }
  }
  const { batches } = await call('/api/evaluations');
  const mine = batches.filter(b => runs.some(r => r.batchId === b.id));
  const comparison = compareConditions(mine);
  console.log('\nCondition            runs  generated  local pass  blind agree  mean overlap  close/blocked');
  for (const c of comparison) console.log(`${(c.retrieval ? 'with sources' : 'without sources').padEnd(20)} ${String(c.runs).padStart(4)}  ${`${c.generated}/${c.requested}`.padStart(9)}  ${`${c.localPass}/${c.generated}`.padStart(10)}  ${`${c.blindAgreed}/${c.blindCompleted}`.padStart(11)}  ${percent(c.meanSourceOverlap).padStart(12)}  ${`${c.sourceClose}/${c.sourceBlocked}`.padStart(13)}`);
  console.log('\nHuman acceptance is pending until reviewers decide on these drafts in the app (Review queue, then Evaluation).');
  const out = values.out || path.join('runtime', `retrieval-pilot-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), server: base, settings: { provider: values.provider, blindProvider: values['blind-provider'] || values.provider, pairs, count, family: values.family, difficulty: values.difficulty }, runs, comparison, batches: mine.map(b => ({ id: b.id, retrieval: Boolean(b.retrieval?.enabled), status: b.status, metrics: b.metrics, references: b.retrieval?.references?.map(({ ref, bankId, sourceKey, source }) => ({ ref, bankId, sourceKey, source })) || [] })) }, null, 2));
  console.log(`Report: ${out}`);
} catch (error) {
  fail('Pilot stopped: ' + error.message);
}

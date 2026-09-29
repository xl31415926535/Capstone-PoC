import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
// Generated model output must never claim approval. Persisted records, however,
// mirror authoritative server review state into these display/audit fields.
// Keep the generation schema unchanged and widen only those derived fields here.
const persistedSchema = structuredClone(schema);
const schemaV2 = JSON.parse(readFileSync(new URL('./schema-v2.json', import.meta.url), 'utf8'));
const persistedV2 = structuredClone(schemaV2);
persistedSchema.properties.status.enum = ['draft_pending_human_review', 'approved', 'changes_requested', 'rejected'];
persistedSchema.properties.review_record.properties.human_approval.enum = ['Pending', 'draft', 'approved', 'changes_requested', 'rejected'];
persistedSchema.properties.review_record.properties.human_reviewer = { type: ['string', 'null'], minLength: 1 };
persistedV2.properties.status = persistedSchema.properties.status;
persistedV2.properties.review_record = persistedSchema.properties.review_record;
const LETTERS = ['P', 'Q', 'R'];
const MAPPINGS = new Set(['P5-ELEC-CLOSED', 'P5-ELEC-MATERIALS', 'PSLE2026-AOII-DATA']);
const normalize = value => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') : '';
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const canonicalStem = 'makes a circuit with one battery, one bulb and two gaps, X and Y, in the same loop. She has three strips, P, Q and R. Each strip is either a good electrical conductor or an electrical insulator. In each test, she places one strip across X and another across Y. Each strip touches both wire ends securely. The battery, bulb and wires work properly in both tests. Apart from the strips shown below, the circuit is unchanged.';
const canonicalDiagram = 'A single loop with one battery and one bulb. Two gaps, X and Y, lie in series in the same loop. A strip bridges each gap. There are no branches or bypass wires.';

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

// The small dependency-free validator implements precisely the schema keywords used here.
export function schemaErrors(value, spec, path = 'item') {
  if (spec.anyOf) {
    const alternatives = spec.anyOf.map(s => schemaErrors(value, s, path));
    return alternatives.some(e => e.length === 0) ? [] : [`${path} does not match an allowed structure`];
  }
  const errors = [];
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (spec.type && !types.some(t => typeMatches(value, t))) return [`${path} must be ${types.join(' or ')}`];
  if (spec.enum && !spec.enum.some(v => v === value)) errors.push(`${path} has an unsupported value`);
  if (typeof value === 'string' && spec.minLength !== undefined && value.trim().length < spec.minLength) errors.push(`${path} must not be blank`);
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) errors.push(`${path} is below its allowed minimum`);
    if (spec.maximum !== undefined && value > spec.maximum) errors.push(`${path} exceeds its allowed maximum`);
  }
  if (Array.isArray(value)) {
    if (spec.minItems !== undefined && value.length < spec.minItems) errors.push(`${path} has too few entries`);
    if (spec.maxItems !== undefined && value.length > spec.maxItems) errors.push(`${path} has too many entries`);
    value.forEach((v, i) => errors.push(...schemaErrors(v, spec.items, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const key of spec.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (spec.properties?.[key]) errors.push(...schemaErrors(v, spec.properties[key], `${path}.${key}`));
      else if (spec.additionalProperties === false) errors.push(`${path}.${key} is not an allowed field`);
    }
  }
  return errors;
}

export function validateItemStructure(item, { generated = false } = {}) {
  return schemaErrors(item, item?.model_version === 'science-v2' ? (generated ? schemaV2 : persistedV2) : (generated ? schema : persistedSchema));
}

function conductorSet(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/\.$/, '');
  // Intentionally narrow. Unsupported natural-language choices are not certified.
  if (!/^[PQR](?:,\s*[PQR])*(?:\s+and\s+[PQR])?(?:\s+only)?$/i.test(s)) return null;
  const values = s.toUpperCase().match(/\b[PQR]\b/g) || [];
  if (values.length !== new Set(values).size) return null;
  return values.sort().join('');
}

function questionText(item) {
  const q = item?.student_question;
  if (!q) return '';
  return [q.stem, q.diagram_alt, q.question,
    ...(Array.isArray(q.observations) ? q.observations.map(o => `${o?.test} ${o?.gap_X} ${o?.gap_Y} ${o?.bulb}`) : []),
    ...(Array.isArray(q.options) ? q.options.map(o => o?.text) : []),
    ...(Array.isArray(q.table?.rows) ? q.table.rows.flat() : []),
  ].filter(s => typeof s === 'string').join(' ');
}

function shingles(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  const result = new Set();
  if (tokens.length < 3) return new Set(tokens);
  for (let i = 0; i < tokens.length - 2; i++) result.add(tokens.slice(i, i + 3).join(' '));
  return result;
}

function compareCorpus(item, corpusRecords) {
  const target = shingles(questionText(item));
  let score = 0, bestMatchId = null, corpusSize = 0;
  for (const record of Array.isArray(corpusRecords) ? corpusRecords : []) {
    const other = record?.item || record;
    if (!other?.student_question) continue;
    corpusSize++;
    const comparison = shingles(questionText(other));
    let overlap = 0;
    for (const token of target) if (comparison.has(token)) overlap++;
    const union = target.size + comparison.size - overlap;
    const value = union ? overlap / union : 0;
    if (value > score) { score = value; bestMatchId = record.id || other.item_id || null; }
  }
  return { corpusSize, bestMatchId, score, method: 'Jaccard similarity of normalized 3-token shingles over student-visible question fields; only the supplied local corpus; not an originality certificate.' };
}

export function validateItem(item, corpusRecords = []) {
  const results = [];
  const add = (id, label, status, detail) => results.push({ id, label, status, detail });
  const errors = validateItemStructure(item);
  add('structure', 'Structured item contract', errors.length ? 'fail' : 'pass', errors.length ? errors.slice(0, 12).join('; ') : 'Required fields and supported item structure are present. This is a structural check, not a scientific review.');
  const q = item?.student_question;
  const options = Array.isArray(q?.options) ? q.options : [];
  const ids = options.map(o => o?.id);
  const texts = options.map(o => normalize(o?.text));
  const semanticSets = options.map(o => conductorSet(o?.text));
  const nonnullSets = semanticSets.filter(s => s !== null);
  const optionsOk = options.length === 4 && ids.every(id => Number.isInteger(id) && id >= 1 && id <= 4) && new Set(ids).size === 4 && texts.every(Boolean) && new Set(texts).size === 4 && new Set(nonnullSets).size === nonnullSets.length;
  add('options', 'Four distinct answer choices', optionsOk ? 'pass' : 'fail', optionsOk ? 'Four nonblank choices have distinct IDs and text; recognized conductor sets are also distinct.' : 'Require four unique IDs (1–4) and nonblank distinct choices. Duplicate text or equivalent conductor sets are invalid.');
  const answerExists = Number.isInteger(item?.answer?.option_id) && ids.includes(item.answer.option_id);
  add('answer_reference', 'Answer key references a choice', answerExists ? 'pass' : 'fail', answerExists ? `Answer key references option ${item.answer.option_id}. Correctness is checked separately.` : 'The keyed answer must reference exactly one available integer option ID.');

  const mappings = Array.isArray(item?.syllabus_mapping) ? item.syllabus_mapping : [];
  const sourceIds = new Set((Array.isArray(item?.sources) ? item.sources : []).map(s => s?.id));
  const idsMapped = mappings.map(m => m?.internal_mapping_id);
  const v2 = item?.model_version === 'science-v2';
  const mappingOk = (v2 ? idsMapped.some(id => ['P5-ELEC-CLOSED','P5-ELEC-MATERIALS'].includes(id)) : ['P5-ELEC-CLOSED', 'P5-ELEC-MATERIALS'].every(id => idsMapped.includes(id))) && new Set(idsMapped).size === mappings.length && mappings.every(m => MAPPINGS.has(m?.internal_mapping_id) && sourceIds.has(m?.source_id) && nonblank(m?.item_evidence) && nonblank(m?.outcome_paraphrase) && (m.internal_mapping_id.startsWith('P5-') ? m.source_id === 'MOE-2023' && m.printed_page === 59 && m.official_code === null : m.source_id === 'SEAB-2026' && m.pdf_page === 1));
  add('syllabus_mapping', 'Known syllabus mappings and evidence', mappingOk ? 'pass' : 'fail', mappingOk ? 'The mapped P5 electricity objectives include page 59 references and item evidence. Label membership is checked; semantic alignment still needs a teacher.' : (v2?'Require at least one relevant P5 electricity objective,':'Require both internal P5 electricity labels,')+' MOE page 59 source references, nonblank evidence, and no unknown or duplicate mappings.');
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const approvedUrls = {
    'MOE-2023': new Set(['https://www.moe.gov.sg/-/media/files/primary/syllabus/2023-primary-science.ashx', 'https://www.moe.gov.sg/api/media/ba3562d3-5b31-4459-8693-45cde7b97273/Primary-Science-Syllabus-2023_May24.pdf']),
    'SEAB-2026': new Set(['https://isomer-user-content.by.gov.sg/334/24bb2fea-a0e0-4aaf-9a11-ae1ef1b8840e/0009_y26_sy.pdf']),
  };
  const sourcesOk = sourceIds.size === sources.length && sources.every(s => {
    try {
      const url = new URL(s?.url);
      return url.protocol === 'https:' && !url.username && !url.password && (!approvedUrls[s.id] || approvedUrls[s.id].has(s.url));
    } catch { return false; }
  }) && Object.keys(approvedUrls).every(id => sourceIds.has(id));
  add('source_references', 'Curriculum source references', sourcesOk ? 'pass' : 'fail', sourcesOk ? 'MOE and SEAB references match the supplied official source URLs. URLs are not fetched during this local check; quoted claims still require review.' : 'Required official source references are missing, duplicated, or altered; all source URLs must be valid HTTPS links.');

  let logic = null;
  if(v2) {
    const table=q?.table;
    const validTable=Array.isArray(table?.columns)&&Array.isArray(table?.rows)&&table.rows.every(row=>Array.isArray(row)&&row.length===table.columns.length)&&(table.rows.length===0||table.columns.length>0);
    add('data_table','Student-visible data table',validTable?'pass':'fail',validTable?'All supplied rows have the declared number of columns.':'Table rows must match the declared columns.');
    add('circuit_logic','Deterministic scientific inference','not_run','This open-form reasoning task is outside the legacy Boolean checker. A blind solve and academic review are required; no symbolic proof is claimed.');
    add('design_review','Reasoning design and novelty','warn','The design rationale is a model claim. Compare the reasoning task, information structure and distractors with source questions; a low word-overlap score cannot establish originality.');
  } else {
  const stem = typeof q?.stem === 'string' ? q.stem : '';
  const assumptions = {
    materials: /(?:^|[.!?]\s+)Each strip is either a good electrical conductor or an electrical insulator\./i.test(stem),
    contact: /(?:^|[.!?]\s+)Each strip touches both wire ends securely\./i.test(stem),
    components: /(?:^|[.!?]\s+)The battery, bulb and wires work properly in both tests\./i.test(stem),
    unchanged: /(?:^|[.!?]\s+)Apart from the strips shown below, the circuit is unchanged\./i.test(stem),
  };
  const missing = Object.entries(assumptions).filter(([, value]) => !value).map(([key]) => key);
  add('assumptions', 'Student-visible circuit assumptions', missing.length ? 'fail' : 'pass', missing.length ? `Missing or unsupported explicit assumption wording in the actual stem: ${missing.join(', ')}. Metadata and answer explanations cannot supply missing question assumptions.` : 'The actual stem explicitly specifies conductor-or-insulator strips, secure contacts, working components, and an unchanged circuit.');
  const stemWithoutName = stem.trim().replace(/^[A-Za-z][A-Za-z' -]{0,39}\s+makes\b/, 'makes');
  const supportedText = normalize(stemWithoutName) === normalize(canonicalStem) && normalize(q?.diagram_alt) === normalize(canonicalDiagram) && normalize(q?.question) === 'which strips are electrical conductors';
  const observations = Array.isArray(q?.observations) ? q.observations : [];
  const observationsOk = observations.length === 2 && new Set(observations.map(o => o?.test)).size === 2 && observations.every(o => [1, 2].includes(o?.test) && LETTERS.includes(o?.gap_X) && LETTERS.includes(o?.gap_Y) && o.gap_X !== o.gap_Y && ['lights', 'does not light'].includes(o?.bulb));
  add('observations', 'Supported two-gap observations', observationsOk ? 'pass' : 'fail', observationsOk ? 'Two distinct tests identify different P/Q/R strips at each gap and use unambiguous bulb states.' : 'Require two distinct tests (1 and 2), each with two different P/Q/R strips and bulb state lights or does not light.');

  if (missing.length || !observationsOk || !supportedText || semanticSets.some(s => s === null)) {
    add('circuit_logic', 'Exhaustive circuit inference', 'not_run', missing.length ? 'Cannot infer strip properties without the explicit supported assumptions.' : !observationsOk ? 'Malformed observation data prevents enumeration.' : !supportedText ? 'The prose is outside the precisely supported single-loop template. No scientific correctness claim is made; manual review or a new deterministic checker is needed.' : 'At least one option uses unsupported text. The checker will not guess what the option means.');
  } else {
    const all = [];
    for (const P of [false, true]) for (const Q of [false, true]) for (const R of [false, true]) {
      const row = { P, Q, R };
      if (observations.every(o => (row[o.gap_X] && row[o.gap_Y]) === (o.bulb === 'lights'))) all.push(row);
    }
    const expectedSet = all.length === 1 ? LETTERS.filter(letter => all[0][letter]).join('') : null;
    const matchingOptions = expectedSet === null ? [] : options.filter((o, index) => semanticSets[index] === expectedSet);
    const optionId = matchingOptions.length === 1 ? matchingOptions[0].id : null;
    logic = { assignmentsTested: 8, matchingAssignments: all, optionId };
    const unique = all.length === 1 && matchingOptions.length === 1;
    add('circuit_logic', 'Exhaustive circuit inference', unique ? 'pass' : 'fail', all.length === 0 ? 'No conductor assignment satisfies the observations: the question is contradictory.' : all.length > 1 ? `${all.length} of 8 assignments satisfy the observations: conductor classification is ambiguous.` : matchingOptions.length !== 1 ? `One assignment satisfies the observations, but ${matchingOptions.length} answer choices represent it. Exactly one is required.` : `All 8 Boolean conductor assignments tested; only ${expectedSet.split('').join(', ')} conduct. This conditional model identifies option ${optionId}; physical lamp thresholds and real experiments are not tested.`);
    const conductors = Array.isArray(item?.answer?.conductors) ? [...item.answer.conductors].sort().join('') : null;
    const insulators = Array.isArray(item?.answer?.insulators) ? [...item.answer.insulators].sort().join('') : null;
    const expectedInsulators = all.length === 1 ? LETTERS.filter(letter => !all[0][letter]).join('') : null;
    const keyCorrect = unique && item?.answer?.option_id === optionId && conductors === expectedSet && insulators === expectedInsulators;
    add('answer_matches_logic', 'Answer agrees with inferred properties', keyCorrect ? 'pass' : 'fail', keyCorrect ? 'The keyed option and listed conductor/insulator sets agree with the unique conditional solution. Explanation prose is not automatically certified.' : 'The keyed option or stated conductor/insulator sets do not match a unique supported solution.');
  }
  }
  const rationales = Array.isArray(item?.distractor_rationales) ? item.distractor_rationales : [];
  const expectedDistractors = options.filter(o => o?.id !== item?.answer?.option_id).map(o => o?.id);
  const rationaleOk = rationales.length === 3 && new Set(rationales.map(r => r?.option_id)).size === 3 && rationales.every(r => expectedDistractors.includes(r?.option_id) && nonblank(r?.issue));
  add('rationales', 'Distractor explanation coverage', rationaleOk ? 'pass' : 'fail', rationaleOk ? 'Each unkeyed choice has a nonblank rationale. This checks coverage only; explanation accuracy needs review.' : 'Each of the three unkeyed choices needs exactly one nonblank rationale.');
  add('difficulty', 'Difficulty calibration', 'warn', 'Difficulty is provisional. Model agreement and Boolean solvability do not estimate pupil success rates; no teacher calibration or pupil trial has been performed.');
  const similarity = compareCorpus(item, corpusRecords);
  add('local_similarity', 'Limited local corpus similarity', similarity.corpusSize ? 'warn' : 'not_run', similarity.corpusSize ? `Compared with ${similarity.corpusSize} local items; highest 3-token Jaccard score ${(similarity.score * 100).toFixed(1)}%. This is a lexical overlap signal, not global originality clearance.` : 'No comparison items supplied. No originality conclusion can be drawn.');
  return { ranAt: new Date().toISOString(), blocking: results.filter(r => r.status === 'fail').length, results, logic, similarity };
}

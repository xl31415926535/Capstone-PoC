// Source-question bank: a SQLite file whose source_documents and questions
// tables match Utkarsh's olympiad_poc.sqlite (including the enrichment columns
// his practice UI reads), plus the full 2023 syllabus, topic and outcome tags,
// figure assets, quality flags, review events and a full-text index.
// The file is rebuilt from its inputs by scripts/import-bank.mjs; reviewer
// decisions are carried into each rebuild by source document and question number.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './store.mjs';
import { syllabus, outcomes, screenText } from './syllabus.mjs';
import { figureErrors, verifyFigure, describeFigure } from './circuit.mjs';

// node:sqlite ships with Node 22.5 and later. On older Node the bank is simply
// unavailable. Its one-off "experimental" warning is kept off the console.
async function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try { return await import('node:sqlite'); } catch { return null; } finally { process.emitWarning = emit; }
}
export const sqlite = await loadSqlite();
export const SCHEMA_VERSION = '1';
export const PILOT_TOPIC = 'P5-SYSTEMS-ELECTRICAL';
export const ENRICHMENT = ['explanation', 'subject', 'topic', 'subtopic', 'skill', 'difficulty', 'answer_source', 'depends_on_image', 'is_complete'];
const UTKARSH_QUESTION_COLUMNS = ['provider', 'competition', 'grade', 'grade_scope', 'source_question_number', 'section', 'stem', 'options_json', 'correct_option', 'raw_chunk', 'provenance_status'];
const DOCUMENT_COLUMNS = ['provider', 'competition', 'grade', 'grade_scope', 'document_kind', 'landing_url', 'download_url', 'local_path', 'sha256', 'page_count', 'extracted_at', 'attribution'];
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export const FLAG_CODES = ['no_answer', 'answer_not_in_options', 'few_options', 'option_noise', 'garbled_text', 'may_depend_on_image', 'excluded_content'];
const CURATED_ID_BASE = { document: 10000, question: 100000 };

const SCHEMA = `
CREATE TABLE bank_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source_documents (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  competition TEXT NOT NULL,
  grade INTEGER,
  grade_scope TEXT NOT NULL,
  document_kind TEXT NOT NULL CHECK(document_kind IN ('questions', 'solutions')),
  landing_url TEXT NOT NULL,
  download_url TEXT NOT NULL,
  local_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  extracted_at TEXT NOT NULL,
  attribution TEXT NOT NULL
);
CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  source_document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  competition TEXT NOT NULL,
  grade INTEGER,
  grade_scope TEXT NOT NULL,
  source_question_number INTEGER NOT NULL,
  section TEXT,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option TEXT,
  raw_chunk TEXT NOT NULL,
  provenance_status TEXT NOT NULL DEFAULT 'public_sample_private_poc',
  explanation TEXT,
  subject TEXT,
  topic TEXT,
  subtopic TEXT,
  skill TEXT,
  difficulty TEXT,
  answer_source TEXT,
  depends_on_image INTEGER,
  is_complete INTEGER,
  UNIQUE(source_document_id, source_question_number)
);
CREATE INDEX idx_questions_grade ON questions(grade);
CREATE INDEX idx_questions_provider ON questions(provider);
CREATE TABLE syllabus_topics (id TEXT PRIMARY KEY, theme TEXT NOT NULL, level TEXT NOT NULL, label TEXT NOT NULL, title TEXT NOT NULL, pages_json TEXT NOT NULL);
CREATE TABLE syllabus_outcomes (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES syllabus_topics(id), stream TEXT NOT NULL, dimension TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, points_json TEXT NOT NULL, notes_json TEXT NOT NULL);
CREATE TABLE syllabus_exclusions (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES syllabus_topics(id), summary TEXT NOT NULL, note TEXT NOT NULL, pages_json TEXT NOT NULL, outcome_ids_json TEXT NOT NULL, check_kind TEXT NOT NULL);
CREATE TABLE question_profile (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin IN ('olympiad_db', 'curated')),
  source_key TEXT NOT NULL UNIQUE,
  grade_min INTEGER, grade_max INTEGER,
  level_band TEXT NOT NULL CHECK(level_band IN ('primary', 'secondary', 'mixed', 'unknown')),
  page INTEGER
);
CREATE TABLE question_topics (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES syllabus_topics(id),
  method TEXT NOT NULL CHECK(method IN ('keyword', 'curated', 'reviewer')),
  score REAL,
  status TEXT NOT NULL CHECK(status IN ('suggested', 'draft', 'confirmed', 'rejected')),
  evidence TEXT NOT NULL,
  PRIMARY KEY (question_id, topic_id)
);
CREATE TABLE question_outcomes (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  outcome_id TEXT NOT NULL REFERENCES syllabus_outcomes(id),
  method TEXT NOT NULL CHECK(method IN ('keyword', 'curated', 'reviewer')),
  score REAL,
  status TEXT NOT NULL CHECK(status IN ('suggested', 'draft', 'confirmed', 'rejected')),
  evidence TEXT NOT NULL,
  PRIMARY KEY (question_id, outcome_id)
);
CREATE TABLE question_assets (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('figure_image', 'circuit_figure')),
  media_type TEXT, data BLOB, sha256 TEXT,
  page INTEGER, bbox_json TEXT,
  figure_json TEXT, check_json TEXT, check_status TEXT, check_detail TEXT,
  note TEXT NOT NULL
);
CREATE TABLE question_flags (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warn')),
  detail TEXT NOT NULL,
  PRIMARY KEY (question_id, code)
);
CREATE TABLE review_events (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  at TEXT NOT NULL, reviewer TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('confirm', 'reject')),
  target TEXT NOT NULL, note TEXT NOT NULL,
  carried_from TEXT
);
CREATE VIRTUAL TABLE questions_fts USING fts5(stem, options, tokenize = 'porter unicode61');
`;

// Keyword cues per syllabus topic. A match is a suggestion for a reviewer, never
// a label. A cue marked ~ is a common word that also turns up outside the topic
// ("the bulb of a thermometer", "a glass of water") and counts half.
export const TOPIC_CUES = {
  'P3-DIVERSITY-LIVING': ['living things?', 'non-living', 'classif(?:y|ied|ication)', 'fungi|fungus|mushrooms?|moulds?|yeast', 'bacteria', 'mammals?', 'reptiles?', 'amphibians?', '~insects?', 'flowering plants?|non-flowering', 'ferns?|mosses'],
  'P3-DIVERSITY-MATERIALS': ['materials?', '~plastic', '~rubber', '~glass', '~wood(?:en)?', '~fabric|cloth', 'ceramic', 'flexib(?:le|ility)', 'waterproof', '~strength|strong(?:er|est)?', 'hardness|harder'],
  'P3-CYCLES-LIFE': ['life cycles?', 'larva(?:e)?', 'pupa(?:e)?', 'nymphs?', 'caterpillars?', 'tadpoles?', 'metamorphosis', 'germinat(?:e|es|ed|ion|ing)', 'seedlings?', '~hatch(?:es|ed)?'],
  'P5-CYCLES-REPRODUCTION': ['reproduc(?:e|es|tion|tive)', 'pollinat(?:e|ed|ion|ors?)', 'pollen', 'fertili[sz](?:ed|ation)', 'dispers(?:al|ed)', 'stamens?|anthers?|stigmas?|ovar(?:y|ies)|ovules?', 'sperms?', 'spores?', '~fruits?'],
  'P4-CYCLES-MATTER': ['matter', 'solids?', 'liquids?', 'gas(?:es)?', '~mass', '~volume', 'occup(?:y|ies) space', 'states? of matter'],
  'P5-CYCLES-WATER': ['evaporat(?:e|es|ed|ion|ing)', 'condens(?:e|es|ed|ation|ing)', 'boil(?:s|ed|ing)?', 'melt(?:s|ed|ing)?', 'freez(?:e|es|ing)|froze', 'water cycle', 'water vapou?r', '~clouds?', '~rain(?:fall)?'],
  'P4-SYSTEMS-DIGESTIVE': ['digest(?:ion|ive|ed|s)?', 'stomach', 'intestines?', 'gullet|oesophagus|esophagus', 'saliva'],
  'P5-SYSTEMS-HUMAN-RESP-CIRC': ['lungs?', 'breath(?:e|es|ing)?', 'respiratory', 'heart(?:beat)?s?', 'blood', 'circulatory', 'windpipe', 'gills?', '~pulse'],
  'P4-SYSTEMS-PLANT-PARTS': ['roots?', 'leaf|leaves', '~stems?', 'parts? of (?:a|the) plant', '~flowers?'],
  'P5-SYSTEMS-PLANT-TRANSPORT': ['water-carrying|food-carrying', 'xylem|phloem', 'stomata', 'transport(?:s|ed)? (?:water|food)'],
  'P5-SYSTEMS-ELECTRICAL': ['circuits?', '~bulbs?', 'batter(?:y|ies)', '~switch(?:es)?', '~electric(?:al|ity)?', 'conductors?', 'insulators?', '~current'],
  'P3-INTERACTIONS-MAGNETS': ['magnet(?:s|ic|ism)?', '~attract(?:s|ed|ion)?', '~repel(?:s|led)?', '~poles?', 'compass', 'electromagnets?'],
  'P6-INTERACTIONS-FORCES': ['forces?', 'friction(?:al)?', 'gravit(?:y|ational)', 'springs?', 'elastic', '~weight', '~push(?:es|ed)?|pull(?:s|ed)?'],
  'P6-INTERACTIONS-ENVIRONMENT': ['food (?:chain|web)s?', 'habitats?', 'populations?', '~communit(?:y|ies)', 'ecosystems?', 'predators?|prey', 'producers?|consumers?|decomposers?', 'adapt(?:ed|ation|ations)', '~environment', 'pollution|deforestation'],
  'P4-ENERGY-LIGHT': ['light rays?|rays? of light|beams? of light|light sources?|sources? of light', 'shadows?', 'reflect(?:s|ed|ion)?', 'mirrors?', 'opaque', 'transparent|translucent', 'lens(?:es)?'],
  'P4-ENERGY-HEAT': ['heat(?:s|ed|ing)?', 'temperatures?', 'thermometers?', 'expand(?:s|ed)?|expansion', 'contract(?:s|ed|ion)', '~hot(?:ter)?|cold(?:er)?|warm(?:er)?'],
  'P6-ENERGY-PHOTOSYNTHESIS': ['photosynthe(?:sis|sise|size|tic)', 'chlorophyll', 'carbon dioxide', '~starch', 'makes? (?:its|their) own food'],
  'P6-ENERGY-CONVERSION': ['energy conversion', 'convert(?:s|ed)? .{0,30}energy', 'kinetic energy', 'potential energy', '(?:electrical|light|heat|sound|chemical|solar) energy', 'wind turbines?|solar (?:cells?|panels?)'],
};
// Outcome cues exist only for the pilot topic's Standard outcomes (syllabus p.59).
export const OUTCOME_CUES = {
  'P5-SYSTEMS-ELECTRICAL-S-C1': ['energy source', 'parts? of (?:an? |the )?(?:electric )?circuit', 'components?', 'electrical system', 'function of the (?:battery|switch|wire|bulb)'],
  'P5-SYSTEMS-ELECTRICAL-S-C2': ['closed circuit', 'open circuit', 'complete(?:d)? circuit', 'current (?:to )?flows?|flow of current|allows? current', 'switch(?:es)? (?:is |are )?(?:open|closed)|(?:opens?|closes?) the switch', 'light(?:s)? up|will light|does not light|not light'],
  'P5-SYSTEMS-ELECTRICAL-S-C3': ['conductors?', 'insulators?', 'conducts? electricity', 'good conductor|poor conductor'],
  'P5-SYSTEMS-ELECTRICAL-S-P1': ['circuit diagrams?', 'symbols?', 'diagrams? (?:below )?shows?'],
  'P5-SYSTEMS-ELECTRICAL-S-P2': ['bright(?:er|est|ness)?|dim(?:mer|mest)?|least bright', 'in series', 'in parallel', 'number of (?:batteries|bulbs|cells)', 'more batteries|more bulbs|additional (?:battery|bulb)'],
};
const compileCues = cues => Object.fromEntries(Object.entries(cues).map(([id, list]) => [id, list.map(cue => ({ weight: cue.startsWith('~') ? 0.5 : 1, re: new RegExp(`\\b(?:${cue.replace(/^~/, '')})\\b`, 'i') }))]));
const TOPIC_RES = compileCues(TOPIC_CUES), OUTCOME_RES = compileCues(OUTCOME_CUES);
const cueHits = (res, text) => Object.entries(res).map(([id, cues]) => {
  const found = cues.map(c => ({ c, term: text.match(c.re)?.[0]?.toLowerCase() })).filter(x => x.term);
  return { id, terms: [...new Set(found.map(x => x.term))], score: found.reduce((s, x) => s + x.c.weight, 0) };
}).filter(h => h.score > 0);

// Topics scoring at least one strong cue (or two weak ones), and at least half the best score.
export function suggestTopics(text) {
  const hits = cueHits(TOPIC_RES, text).filter(h => h.score >= 1).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.filter(h => h.score >= hits[0]?.score / 2).slice(0, 3).map(h => ({ id: h.id, score: h.score, evidence: 'Keyword cues: ' + h.terms.join(', ') }));
}
export function suggestOutcomes(text) {
  return cueHits(OUTCOME_RES, text).map(h => ({ id: h.id, score: h.score, evidence: 'Keyword cues: ' + h.terms.join(', ') }));
}

// Words that tell nothing about a question's content, left out of search queries.
const STOP = new Set('a an and any are as at be been being by can could did do does each either for from had has have how if in into is it its many may more most much must neither no nor not of off on one only or other our out over same should so some such than that the their them then there these they this those three through to two under up was we were what when where whether which while who whom whose why will with would you your'.split(' '));
export function ftsQuery(text, { any = false, prefix = false, max = 24 } = {}) {
  const words = [...new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1 && !STOP.has(w)))].slice(0, max);
  return words.map(w => `"${w}"${prefix ? '*' : ''}`).join(any ? ' OR ' : ' ');
}

// Real short words, roman numerals and units, so that only broken words count as fragments.
const SHORT_WORDS = new Set('a am an as at be by do go he if in is it me my no of on or ox so to up us we i ii iv vi ix cm mm km kg mg ml kj g h m s n w v l j'.split(' '));
export function qualityFlags(stem, options, correct, { hasFigure = false } = {}) {
  const flags = [];
  const warn = (code, detail) => flags.push({ code, severity: 'warn', detail });
  const keys = Object.keys(options);
  if (correct === null || correct === undefined || correct === '') warn('no_answer', 'The source gives no answer key for this question.');
  else if (!keys.includes(String(correct))) warn('answer_not_in_options', `The key "${correct}" is not one of the extracted options.`);
  if (keys.length < 3) warn('few_options', `Only ${keys.length} option${keys.length === 1 ? ' was' : 's were'} extracted.`);
  const noisy = keys.filter(k => { const v = String(options[k] ?? ''); return v.length > 140 || /sample paper|www\.|https?:\/\/|\bpage \d+\b|\bclass[- ]\d+\b/i.test(v) || /\s[A-H][.)]\s+\S/.test(v); });
  if (noisy.length) warn('option_noise', `Option${noisy.length > 1 ? 's' : ''} ${noisy.join(', ')} may hold page headers, footers or merged options.`);
  const text = [stem, ...Object.values(options)].join(' ');
  const words = text.match(/[A-Za-z]+/g) || [];
  const fragments = words.filter(w => /^[a-z]{1,2}$/.test(w) && !SHORT_WORDS.has(w)).length;
  if (/[\u{1D400}-\u{1D7FF}]/u.test(text) || (words.length >= 8 && fragments / words.length > 0.2)) warn('garbled_text', 'Extraction damage such as broken letter spacing or mathematical glyphs.');
  if (/\b(?:figure|fig\.|diagram|picture|graph|table|image|illustration|photograph|shown (?:below|above|here)|given below|following (?:set-?up|apparatus))\b/i.test(stem)) {
    if (hasFigure) flags.push({ code: 'may_depend_on_image', severity: 'info', detail: 'The stem refers to a figure; the figure is stored with the question.' });
    else warn('may_depend_on_image', 'The stem refers to a figure, table or picture that the text does not include.');
  }
  const hits = screenText(text);
  if (hits.length) flags.push({ code: 'excluded_content', severity: 'info', detail: 'Uses wording the 2023 syllabus marks not required or the pilot leaves out: ' + hits.map(h => `"${h.terms.join('", "')}" (${h.id})`).join('; ') + '.' });
  return flags;
}

export function gradeRange(grade, scope) {
  const s = String(scope || '').trim();
  if (/^primary$/i.test(s)) return [1, 6];
  const m = s.match(/(\d+)\s*(?:[-–]\s*(\d+))?/);
  if (m) return [Number(m[1]), Number(m[2] || m[1])];
  return Number.isInteger(grade) ? [grade, grade] : [null, null];
}
const levelBand = ([lo, hi]) => lo === null ? 'unknown' : hi <= 6 ? 'primary' : lo >= 7 ? 'secondary' : 'mixed';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const parseOptions = json => {
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value)) return Object.fromEntries(value.map((v, i) => [String.fromCharCode(65 + i), String(v?.text ?? v)]));
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v ?? '')])) : {};
  } catch { return {}; }
};
const optionText = options => Object.entries(options).map(([k, v]) => `${k}. ${v}`).join('\n');
const httpsOrNull = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };

function insertSyllabus(db) {
  const topic = db.prepare('INSERT INTO syllabus_topics VALUES (?, ?, ?, ?, ?, ?)');
  const outcome = db.prepare('INSERT INTO syllabus_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const exclusion = db.prepare('INSERT INTO syllabus_exclusions VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const t of syllabus.topics) {
    topic.run(t.id, t.theme, t.level, t.label, t.title, JSON.stringify(Object.values(t.streams).flatMap(s => s.pages)));
    for (const o of t.outcomes) outcome.run(o.id, t.id, o.stream, o.dimension, o.page, o.text, JSON.stringify(o.points), JSON.stringify(o.notes));
  }
  for (const e of syllabus.exclusions) exclusion.run(e.id, e.topicId, e.summary, e.note, JSON.stringify(e.pages), JSON.stringify(e.outcomeIds), e.check);
}

// ---- Inputs ----

function readOlympiad(file) {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const docColumns = columns('source_documents'), questionColumns = columns('questions');
    const missing = [...DOCUMENT_COLUMNS.filter(c => !docColumns.includes(c)), ...UTKARSH_QUESTION_COLUMNS.filter(c => !questionColumns.includes(c))];
    if (missing.length) throw new Error(`${path.basename(file)} is not an olympiad question bank: missing ${missing.join(', ')}.`);
    const enrichment = ENRICHMENT.filter(c => questionColumns.includes(c));
    return {
      documents: db.prepare(`SELECT id, ${DOCUMENT_COLUMNS.join(', ')} FROM source_documents ORDER BY id`).all(),
      questions: db.prepare(`SELECT id, source_document_id, ${[...UTKARSH_QUESTION_COLUMNS, ...enrichment].join(', ')} FROM questions ORDER BY id`).all(),
      enrichment,
    };
  } finally { db.close(); }
}

function curatedFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target).filter(name => name.endsWith('.json')).sort().map(name => path.join(target, name));
}

const requireString = (value, where) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a non-empty string.`); return value; };
function readCurated(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`${file}: ${error.message}`); }
  if (data?.format !== 'simcc-source-bank/1' || !Array.isArray(data.documents)) throw new Error(`${file}: expected {"format": "simcc-source-bank/1", "documents": [...]}.`);
  const dir = path.dirname(file);
  const documents = data.documents.map((doc, d) => {
    const where = `${path.basename(file)} document ${doc?.key || d + 1}`;
    requireString(doc.key, `${where}: key`);
    for (const field of ['provider', 'competition', 'grade_scope', 'landing_url', 'download_url', 'local_path', 'extracted_at', 'attribution']) requireString(doc[field], `${where}: ${field}`);
    if (!httpsOrNull(doc.landing_url) || !httpsOrNull(doc.download_url)) throw new Error(`${where}: landing_url and download_url must be https links.`);
    if (!Number.isInteger(doc.page_count) || doc.page_count < 1) throw new Error(`${where}: page_count must be a positive integer.`);
    if (doc.grade != null && !Number.isInteger(doc.grade)) throw new Error(`${where}: grade must be an integer or null.`);
    let digest = doc.sha256;
    if (doc.file) {
      const original = path.resolve(dir, doc.file);
      if (!fs.existsSync(original)) throw new Error(`${where}: file ${doc.file} not found.`);
      digest = sha256(fs.readFileSync(original));
      if (doc.sha256 && doc.sha256 !== digest) throw new Error(`${where}: sha256 does not match ${doc.file}.`);
    }
    if (!/^[0-9a-f]{64}$/.test(digest || '')) throw new Error(`${where}: give sha256 or a file to hash.`);
    if (!Array.isArray(doc.questions) || !doc.questions.length) throw new Error(`${where}: questions must be a non-empty list.`);
    const numbers = doc.questions.map(q => q?.number);
    if (new Set(numbers).size !== numbers.length) throw new Error(`${where}: question numbers must be unique.`);
    return { ...doc, sha256: digest, document_kind: doc.document_kind || 'questions', page_count: doc.page_count, questions: doc.questions.map(q => readCuratedQuestion(q, `${where} Q${q?.number}`, dir)) };
  });
  return { file, label: data.label, notice: data.notice, documents };
}

function readCuratedQuestion(q, where, dir) {
  if (!Number.isInteger(q.number)) throw new Error(`${where}: number must be an integer.`);
  requireString(q.stem, `${where}: stem`);
  if (!q.options || typeof q.options !== 'object' || Array.isArray(q.options) || Object.keys(q.options).length < 2) throw new Error(`${where}: options must map option keys to text.`);
  if (q.correct_option != null && !Object.hasOwn(q.options, String(q.correct_option))) throw new Error(`${where}: correct_option must be one of the option keys.`);
  for (const t of q.topics || []) if (!syllabus.topics.some(x => x.id === t.id)) throw new Error(`${where}: unknown syllabus topic ${t.id}.`);
  for (const o of q.outcomes || []) if (!outcomes.has(o.id)) throw new Error(`${where}: unknown syllabus outcome ${o.id}.`);
  for (const tag of [...(q.topics || []), ...(q.outcomes || [])]) if (tag.status && !['draft', 'confirmed'].includes(tag.status)) throw new Error(`${where}: tag status must be draft or confirmed.`);
  const assets = (q.assets || []).map((asset, i) => {
    if (asset.kind === 'figure_image') {
      const media = MEDIA[path.extname(asset.file || '').toLowerCase()];
      if (!media) throw new Error(`${where}: figure ${i + 1} must be a PNG, JPEG or WebP file.`);
      const file = path.resolve(dir, asset.file);
      if (!fs.existsSync(file)) throw new Error(`${where}: figure file ${asset.file} not found.`);
      return { ...asset, media, data: fs.readFileSync(file) };
    }
    if (asset.kind === 'circuit_figure') {
      const errors = figureErrors(asset.figure);
      if (errors.length) throw new Error(`${where}: circuit figure: ${errors.join(' ')}`);
      return asset;
    }
    throw new Error(`${where}: unknown asset kind ${asset.kind}.`);
  });
  return { ...q, assets };
}

// Reviewer decisions from an earlier build, keyed by source document and question number.
function previousReviews(file) {
  if (!file || !fs.existsSync(file)) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'review_events'").get()) return [];
    return db.prepare('SELECT p.source_key, e.at, e.reviewer, e.action, e.target, e.note, e.carried_from FROM review_events e JOIN question_profile p ON p.question_id = e.question_id ORDER BY e.id').all();
  } catch { return []; } finally { db?.close(); }
}

function applyReview(db, questionId, target, action) {
  const [kind, tagId] = target.split(':');
  const table = kind === 'topic' ? 'question_topics' : 'question_outcomes', column = kind === 'topic' ? 'topic_id' : 'outcome_id';
  const status = action === 'confirm' ? 'confirmed' : 'rejected';
  const found = db.prepare(`SELECT 1 FROM ${table} WHERE question_id = ? AND ${column} = ?`).get(questionId, tagId);
  if (found) db.prepare(`UPDATE ${table} SET status = ? WHERE question_id = ? AND ${column} = ?`).run(status, questionId, tagId);
  else db.prepare(`INSERT INTO ${table} (question_id, ${column}, method, score, status, evidence) VALUES (?, ?, 'reviewer', NULL, ?, 'Added by a reviewer.')`).run(questionId, tagId, status);
}

// ---- Build ----

export function buildBank({ output, olympiad = [], sources = [], label, previous = output, now = new Date().toISOString() }) {
  if (!sqlite) throw new Error('The source bank needs Node 22.5 or later (built-in node:sqlite).');
  if (!output) throw new Error('Give an output file.');
  if (!olympiad.length && !sources.length) throw new Error('Give at least one input: --olympiad <file.sqlite> or --sources <file or folder>.');
  const olympiadInputs = olympiad.map(file => ({ file, ...readOlympiad(file) }));
  const curatedInputs = sources.flatMap(curatedFiles).map(readCurated);
  const carried = previousReviews(previous);
  const paths = [...olympiadInputs.flatMap(i => i.documents.map(d => d.local_path)), ...curatedInputs.flatMap(i => i.documents.map(d => d.local_path))];
  const keys = curatedInputs.flatMap(i => i.documents.map(d => d.key));
  const twice = [...paths.filter((p, i) => paths.indexOf(p) !== i), ...keys.filter((k, i) => keys.indexOf(k) !== i)];
  if (twice.length) throw new Error(`Duplicate source document ${twice[0]}. Import each document once.`);

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  const temp = `${output}.${process.pid}.building`;
  fs.rmSync(temp, { force: true });
  const db = new sqlite.DatabaseSync(temp);
  const stats = { documents: 0, questions: 0, assets: 0, verifiedFigures: 0, carriedReviews: 0, droppedReviews: 0 };
  try {
    db.exec('PRAGMA foreign_keys = ON;' + SCHEMA);
    db.exec('BEGIN');
    insertSyllabus(db);
    const insertDocument = db.prepare(`INSERT INTO source_documents (id, ${DOCUMENT_COLUMNS.join(', ')}) VALUES (${Array(DOCUMENT_COLUMNS.length + 1).fill('?').join(', ')})`);
    const questionColumns = ['id', 'source_document_id', ...UTKARSH_QUESTION_COLUMNS, ...ENRICHMENT];
    const insertQuestion = db.prepare(`INSERT INTO questions (${questionColumns.join(', ')}) VALUES (${questionColumns.map(() => '?').join(', ')})`);
    const insertProfile = db.prepare('INSERT INTO question_profile VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertTopic = db.prepare('INSERT OR REPLACE INTO question_topics VALUES (?, ?, ?, ?, ?, ?)');
    const insertOutcome = db.prepare('INSERT OR REPLACE INTO question_outcomes VALUES (?, ?, ?, ?, ?, ?)');
    const insertFlag = db.prepare('INSERT INTO question_flags VALUES (?, ?, ?, ?)');
    const insertAsset = db.prepare('INSERT INTO question_assets (question_id, kind, media_type, data, sha256, page, bbox_json, figure_json, check_json, check_status, check_detail, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertText = db.prepare('INSERT INTO questions_fts (rowid, stem, options) VALUES (?, ?, ?)');
    const seenKeys = new Set();

    // Shared steps for every question: profile, full-text row, flags and suggested tags.
    const finish = (id, row, origin, sourceKey, page, curated = {}) => {
      if (seenKeys.has(sourceKey)) throw new Error(`Duplicate source question ${sourceKey}. Import each document once.`);
      seenKeys.add(sourceKey);
      const options = parseOptions(row.options_json);
      const range = gradeRange(row.grade, row.grade_scope);
      insertProfile.run(id, origin, sourceKey, range[0], range[1], levelBand(range), page ?? null);
      insertText.run(id, row.stem, optionText(options));
      for (const f of qualityFlags(row.stem, options, row.correct_option, { hasFigure: !!curated.assets?.length })) insertFlag.run(id, f.code, f.severity, f.detail);
      const text = [row.stem, ...Object.values(options)].join(' ');
      const topics = curated.topics?.length ? curated.topics.map(t => ({ ...t, method: 'curated' })) : suggestTopics(text).map(t => ({ ...t, method: 'keyword' }));
      for (const t of topics) insertTopic.run(id, t.id, t.method, t.score ?? null, t.method === 'curated' ? t.status || 'draft' : 'suggested', t.evidence || 'Tagged by the project team.');
      if (curated.outcomes?.length) for (const o of curated.outcomes) insertOutcome.run(id, o.id, 'curated', null, o.status || 'draft', o.evidence || 'Tagged by the project team.');
      else if (topics.some(t => t.id === PILOT_TOPIC)) for (const o of suggestOutcomes(text)) insertOutcome.run(id, o.id, 'keyword', o.score, 'suggested', o.evidence);
      stats.questions++;
    };

    const inputs = [];
    for (const input of olympiadInputs) {
      const ids = new Set();
      for (const doc of input.documents) {
        if (doc.id >= CURATED_ID_BASE.document) throw new Error(`${path.basename(input.file)}: document id ${doc.id} collides with the range kept for curated sources.`);
        insertDocument.run(doc.id, ...DOCUMENT_COLUMNS.map(c => doc[c]));
        ids.add(doc.id); stats.documents++;
      }
      const shaById = new Map(input.documents.map(d => [d.id, d.sha256]));
      for (const q of input.questions) {
        if (q.id >= CURATED_ID_BASE.question) throw new Error(`${path.basename(input.file)}: question id ${q.id} collides with the range kept for curated sources.`);
        insertQuestion.run(q.id, q.source_document_id, ...UTKARSH_QUESTION_COLUMNS.map(c => q[c]), ...ENRICHMENT.map(c => input.enrichment.includes(c) ? q[c] : null));
        finish(q.id, q, 'olympiad_db', `${shaById.get(q.source_document_id)}#${q.source_question_number}`, null);
      }
      inputs.push({ kind: 'olympiad_db', file: path.basename(input.file), sha256: sha256(fs.readFileSync(input.file)), documents: input.documents.length, questions: input.questions.length, enrichment: input.enrichment });
    }
    let documentId = CURATED_ID_BASE.document, questionId = CURATED_ID_BASE.question;
    for (const input of curatedInputs) {
      let count = 0;
      for (const doc of input.documents) {
        const docId = ++documentId;
        insertDocument.run(docId, ...DOCUMENT_COLUMNS.map(c => c === 'sha256' ? doc.sha256 : c === 'document_kind' ? doc.document_kind : doc[c] ?? null));
        stats.documents++;
        for (const q of doc.questions) {
          const id = ++questionId;
          const row = {
            provider: doc.provider, competition: doc.competition, grade: doc.grade ?? null, grade_scope: doc.grade_scope,
            source_question_number: q.number, section: q.section ?? null, stem: q.stem, options_json: JSON.stringify(q.options),
            correct_option: q.correct_option == null ? null : String(q.correct_option),
            raw_chunk: q.raw_chunk || [q.stem, optionText(q.options)].join('\n'),
            provenance_status: doc.provenance_status || 'curated_private_poc',
            explanation: q.explanation ?? null, subject: q.subject ?? null, topic: q.topic ?? null, subtopic: q.subtopic ?? null,
            skill: q.skill ?? null, difficulty: q.difficulty ?? null, answer_source: q.answer_source ?? null,
            depends_on_image: q.depends_on_image ?? null, is_complete: q.is_complete ?? null,
          };
          insertQuestion.run(id, docId, ...UTKARSH_QUESTION_COLUMNS.map(c => row[c]), ...ENRICHMENT.map(c => row[c]));
          finish(id, row, 'curated', `${doc.key}#${q.number}`, q.page, q);
          const optionList = Object.entries(q.options).map(([key, text], i) => ({ id: /^\d+$/.test(key) ? Number(key) : i + 1, key, text }));
          const keyId = optionList.find(o => o.key === row.correct_option)?.id ?? null;
          for (const asset of q.assets) {
            if (asset.kind === 'figure_image') insertAsset.run(id, 'figure_image', asset.media, asset.data, sha256(asset.data), asset.page ?? q.page ?? null, asset.bbox ? JSON.stringify(asset.bbox) : null, null, null, null, null, asset.note || 'Figure cropped from the source page.');
            else {
              const result = verifyFigure(asset.figure, asset.check || { kind: 'none', options: [], targetLit: [] }, optionList, keyId);
              if (result.status === 'pass') stats.verifiedFigures++;
              insertAsset.run(id, 'circuit_figure', null, null, null, null, null, JSON.stringify(asset.figure), JSON.stringify(asset.check || null), result.status, result.detail, asset.note || 'Circuit redrawn as structured data for the solver.');
            }
            stats.assets++;
          }
          count++;
        }
      }
      inputs.push({ kind: 'curated', file: path.basename(input.file), sha256: sha256(fs.readFileSync(input.file)), documents: input.documents.length, questions: count, label: input.label || null });
    }

    const insertReview = db.prepare('INSERT INTO review_events (question_id, at, reviewer, action, target, note, carried_from) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const bySourceKey = db.prepare('SELECT question_id FROM question_profile WHERE source_key = ?');
    for (const event of carried) {
      const found = bySourceKey.get(event.source_key);
      const [kind, tagId] = String(event.target).split(':');
      if (!found || !(kind === 'topic' ? syllabus.topics.some(t => t.id === tagId) : outcomes.has(tagId))) { stats.droppedReviews++; continue; }
      applyReview(db, found.question_id, event.target, event.action);
      insertReview.run(found.question_id, event.at, event.reviewer, event.action, event.target, event.note, event.carried_from || path.basename(previous));
      stats.carriedReviews++;
    }

    const notices = curatedInputs.map(i => i.notice).filter(Boolean);
    const meta = {
      schema_version: SCHEMA_VERSION, built_at: now, builder: 'scripts/import-bank.mjs',
      label: label || curatedInputs.find(i => i.label)?.label || 'Source question bank',
      notice: [...new Set(notices)].join(' ') || 'Private PoC data built from third-party papers. Do not commit or publish this file.',
      syllabus_id: syllabus.id, syllabus_edition: syllabus.edition, inputs: JSON.stringify(inputs), stats: JSON.stringify(stats),
    };
    const insertMeta = db.prepare('INSERT INTO bank_meta VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) insertMeta.run(key, String(value));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
  db.close();
  fs.renameSync(temp, output);
  return stats;
}

// ---- Reading ----

export function bankFileStatus(file) {
  if (!sqlite) return { available: false, reason: 'The source bank needs Node 22.5 or later (built-in node:sqlite).' };
  if (!file || !fs.existsSync(file)) return { available: false, reason: 'No source bank has been built yet.', hint: 'Run npm run bank:sample for the constructed sample, or node scripts/import-bank.mjs with your sources.' };
  return { available: true };
}

export function openBank(file, { write = false } = {}) {
  const status = bankFileStatus(file);
  if (!status.available) throw new AppError(status.reason + (status.hint ? ' ' + status.hint : ''), 409, 'BANK_UNAVAILABLE');
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: !write });
    db.exec('PRAGMA foreign_keys = ON');
    const version = db.prepare("SELECT value FROM bank_meta WHERE key = 'schema_version'").get()?.value;
    if (version !== SCHEMA_VERSION) throw new Error('version');
  } catch {
    db?.close();
    throw new AppError('The configured file is not a Science Studio source bank. Rebuild it with scripts/import-bank.mjs.', 409, 'BANK_UNAVAILABLE');
  }
  return db;
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
export function bankSummary(db) {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM bank_meta').all().map(r => [r.key, r.value]));
  return {
    available: true, label: meta.label, notice: meta.notice, builtAt: meta.built_at, syllabus: meta.syllabus_id,
    inputs: JSON.parse(meta.inputs || '[]'),
    counts: {
      documents: count(db, 'SELECT count(*) n FROM source_documents'),
      questions: count(db, 'SELECT count(*) n FROM questions'),
      primary: count(db, "SELECT count(*) n FROM question_profile WHERE level_band = 'primary'"),
      withKey: count(db, 'SELECT count(*) n FROM questions WHERE correct_option IS NOT NULL'),
      clean: count(db, "SELECT count(*) n FROM questions q WHERE NOT EXISTS (SELECT 1 FROM question_flags f WHERE f.question_id = q.id AND f.severity = 'warn')"),
      withFigure: count(db, 'SELECT count(DISTINCT question_id) n FROM question_assets'),
      verifiedFigures: count(db, "SELECT count(*) n FROM question_assets WHERE kind = 'circuit_figure' AND check_status = 'pass'"),
      complete: count(db, 'SELECT count(*) n FROM questions WHERE is_complete = 1'),
      pilot: count(db, "SELECT count(DISTINCT question_id) n FROM question_topics WHERE topic_id = ? AND status <> 'rejected'", PILOT_TOPIC),
      reviewed: count(db, 'SELECT count(DISTINCT question_id) n FROM review_events'),
    },
    providers: db.prepare('SELECT provider, competition, count(*) n FROM questions GROUP BY provider, competition ORDER BY n DESC, provider').all().map(r => ({ ...r })),
    flags: db.prepare('SELECT code, severity, count(*) n FROM question_flags GROUP BY code, severity ORDER BY n DESC').all().map(r => ({ ...r })),
    levels: db.prepare('SELECT level_band AS level, count(*) n FROM question_profile GROUP BY level_band ORDER BY n DESC').all().map(r => ({ ...r })),
  };
}

const tagRows = (db, table, column, ids) => {
  const rows = new Map(ids.map(id => [id, []]));
  if (!ids.length) return rows;
  for (const r of db.prepare(`SELECT question_id, ${column} AS id, method, score, status, evidence FROM ${table} WHERE question_id IN (${ids.map(() => '?').join(', ')}) ORDER BY status = 'rejected', score DESC, ${column}`).all(...ids)) rows.get(r.question_id).push({ id: r.id, method: r.method, score: r.score, status: r.status, evidence: r.evidence });
  return rows;
};

export function searchQuestions(db, { q = '', topic = '', level = '', flag = '', limit = 25, offset = 0 } = {}) {
  const where = [], params = [];
  let from = 'questions q JOIN question_profile p ON p.question_id = q.id', order = 'q.id';
  const match = ftsQuery(q, { prefix: true });
  if (match) { from += ' JOIN questions_fts ON questions_fts.rowid = q.id'; where.push('questions_fts MATCH ?'); params.push(match); order = 'bm25(questions_fts), q.id'; }
  if (topic) { where.push("EXISTS (SELECT 1 FROM question_topics t WHERE t.question_id = q.id AND t.topic_id = ? AND t.status <> 'rejected')"); params.push(topic); }
  if (level) { where.push('p.level_band = ?'); params.push(level); }
  if (flag === 'clean') where.push("NOT EXISTS (SELECT 1 FROM question_flags x WHERE x.question_id = q.id AND x.severity = 'warn')");
  else if (flag === 'figure') where.push('EXISTS (SELECT 1 FROM question_assets a WHERE a.question_id = q.id)');
  else if (flag) { where.push('EXISTS (SELECT 1 FROM question_flags x WHERE x.question_id = q.id AND x.code = ?)'); params.push(flag); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = count(db, `SELECT count(*) n FROM ${from}${clause}`, ...params);
  const rows = db.prepare(`SELECT q.id, q.provider, q.competition, q.grade_scope, q.source_question_number AS number, q.stem, q.correct_option, p.level_band, p.origin, (SELECT count(*) FROM question_assets a WHERE a.question_id = q.id) AS assets FROM ${from}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const ids = rows.map(r => r.id);
  const topics = tagRows(db, 'question_topics', 'topic_id', ids);
  const flags = new Map(ids.map(id => [id, []]));
  if (ids.length) for (const f of db.prepare(`SELECT question_id, code, severity FROM question_flags WHERE question_id IN (${ids.map(() => '?').join(', ')})`).all(...ids)) flags.get(f.question_id).push({ code: f.code, severity: f.severity });
  return {
    total, limit, offset,
    questions: rows.map(r => ({ id: r.id, provider: r.provider, competition: r.competition, gradeScope: r.grade_scope, number: r.number, stem: r.stem.length > 220 ? r.stem.slice(0, 217) + '…' : r.stem, hasKey: r.correct_option !== null, level: r.level_band, origin: r.origin, assets: r.assets, topics: topics.get(r.id).filter(t => t.status !== 'rejected').map(t => ({ id: t.id, status: t.status })), flags: flags.get(r.id) })),
  };
}

export function getQuestion(db, id) {
  const q = db.prepare(`SELECT q.*, p.origin, p.source_key, p.grade_min, p.grade_max, p.level_band, p.page, d.landing_url, d.attribution, d.document_kind, d.page_count, d.extracted_at FROM questions q JOIN question_profile p ON p.question_id = q.id JOIN source_documents d ON d.id = q.source_document_id WHERE q.id = ?`).get(id);
  if (!q) throw new AppError('Source question not found.', 404, 'NOT_FOUND');
  const assets = db.prepare('SELECT id, kind, media_type, page, figure_json, check_json, check_status, check_detail, note FROM question_assets WHERE question_id = ? ORDER BY id').all(id);
  return {
    id: q.id, provider: q.provider, competition: q.competition, grade: q.grade, gradeScope: q.grade_scope, number: q.source_question_number, section: q.section,
    stem: q.stem, options: parseOptions(q.options_json), correctOption: q.correct_option, answerSource: q.answer_source, explanation: q.explanation,
    enrichment: Object.fromEntries(ENRICHMENT.filter(c => !['explanation', 'answer_source'].includes(c)).map(c => [c, q[c]])),
    provenanceStatus: q.provenance_status, rawChunk: q.raw_chunk.length > 4000 ? q.raw_chunk.slice(0, 4000) + '…' : q.raw_chunk,
    document: { landingUrl: httpsOrNull(q.landing_url), attribution: q.attribution, kind: q.document_kind, pageCount: q.page_count, extractedAt: q.extracted_at },
    profile: { origin: q.origin, sourceKey: q.source_key, gradeMin: q.grade_min, gradeMax: q.grade_max, level: q.level_band, page: q.page },
    topics: tagRows(db, 'question_topics', 'topic_id', [id]).get(id).map(t => ({ ...t, label: syllabus.topics.find(x => x.id === t.id)?.label })),
    outcomes: tagRows(db, 'question_outcomes', 'outcome_id', [id]).get(id).map(o => ({ ...o, text: outcomes.get(o.id)?.text, page: outcomes.get(o.id)?.page })),
    flags: db.prepare('SELECT code, severity, detail FROM question_flags WHERE question_id = ? ORDER BY severity DESC, code').all(id).map(r => ({ ...r })),
    assets: assets.map(a => ({ id: a.id, kind: a.kind, page: a.page, note: a.note, ...(a.kind === 'figure_image' ? { url: `/api/bank/assets/${a.id}`, mediaType: a.media_type } : { figure: JSON.parse(a.figure_json), check: JSON.parse(a.check_json), checkStatus: a.check_status, checkDetail: a.check_detail, description: describeFigure(JSON.parse(a.figure_json)) }) })),
    reviews: db.prepare('SELECT at, reviewer, action, target, note, carried_from FROM review_events WHERE question_id = ? ORDER BY id').all(id).map(r => ({ ...r })),
  };
}

export function assetData(db, id) {
  const asset = db.prepare("SELECT media_type, data FROM question_assets WHERE id = ? AND kind = 'figure_image'").get(id);
  if (!asset || !Object.values(MEDIA).includes(asset.media_type)) throw new AppError('Figure not found.', 404, 'NOT_FOUND');
  return { mediaType: asset.media_type, data: Buffer.from(asset.data) };
}

const TARGET = /^(topic|outcome):([A-Z0-9-]{3,80})$/;
export function reviewTag(db, questionId, { target, action, reviewer, note }, at = new Date().toISOString()) {
  const m = TARGET.exec(typeof target === 'string' ? target : '');
  if (!m || (m[1] === 'topic' ? !syllabus.topics.some(t => t.id === m[2]) : !outcomes.has(m[2]))) throw new AppError('Choose a syllabus topic or outcome to review.');
  if (!['confirm', 'reject'].includes(action)) throw new AppError('Choose confirm or reject.');
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 120 || typeof note !== 'string' || !note.trim() || note.length > 1000) throw new AppError('A reviewer name and a short reason are required.');
  if (!db.prepare('SELECT 1 FROM questions WHERE id = ?').get(questionId)) throw new AppError('Source question not found.', 404, 'NOT_FOUND');
  db.exec('BEGIN');
  try {
    applyReview(db, questionId, target, action);
    db.prepare('INSERT INTO review_events (question_id, at, reviewer, action, target, note, carried_from) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(questionId, at, reviewer.trim(), action, target, note.trim());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getQuestion(db, questionId);
}

// Syllabus coverage: source questions per topic (all topics) and per outcome
// (pilot topic), next to the generated items mapped to each pilot outcome.
export function coverage(db, records, curriculum) {
  const objectiveOutcome = new Map(curriculum.objectives.map(o => [o.id, o.outcomeId]));
  const generated = new Map();
  for (const record of records) {
    const mapped = new Set((record.item?.syllabus_mapping || []).map(m => objectiveOutcome.get(m.internal_mapping_id)).filter(Boolean));
    for (const id of mapped) {
      const g = generated.get(id) || { total: 0, approved: 0 };
      g.total++; if (record.status === 'approved') g.approved++;
      generated.set(id, g);
    }
  }
  const empty = () => ({ suggested: 0, draft: 0, confirmed: 0, primary: 0 });
  const topicCounts = new Map(), outcomeCounts = new Map();
  if (db) {
    for (const r of db.prepare("SELECT t.topic_id AS id, t.status, p.level_band, count(*) n FROM question_topics t JOIN question_profile p ON p.question_id = t.question_id WHERE t.status <> 'rejected' GROUP BY 1, 2, 3").all()) {
      const c = topicCounts.get(r.id) || empty(); c[r.status] += r.n; if (r.level_band === 'primary') c.primary += r.n; topicCounts.set(r.id, c);
    }
    for (const r of db.prepare("SELECT o.outcome_id AS id, o.status, p.level_band, count(*) n FROM question_outcomes o JOIN question_profile p ON p.question_id = o.question_id WHERE o.status <> 'rejected' GROUP BY 1, 2, 3").all()) {
      const c = outcomeCounts.get(r.id) || empty(); c[r.status] += r.n; if (r.level_band === 'primary') c.primary += r.n; outcomeCounts.set(r.id, c);
    }
  }
  const excluded = new Set((curriculum.excludedOutcomes || []).map(e => e.outcomeId));
  return {
    bank: !!db, pilotTopic: PILOT_TOPIC, themes: syllabus.themes,
    topics: syllabus.topics.map(t => ({
      id: t.id, theme: t.theme, level: t.level, label: t.label, pages: Object.values(t.streams).flatMap(s => s.pages),
      outcomes: t.outcomes.length, exclusions: syllabus.exclusions.filter(e => e.topicId === t.id).length,
      sources: topicCounts.get(t.id) || empty(),
      outcomeRows: t.id === PILOT_TOPIC ? t.outcomes.filter(o => o.stream === 'standard').map(o => ({
        id: o.id, dimension: o.dimension, text: o.text, points: o.points, page: o.page,
        objective: curriculum.objectives.find(x => x.outcomeId === o.id)?.id || null, excludedFromPilot: excluded.has(o.id),
        sources: outcomeCounts.get(o.id) || empty(), generated: generated.get(o.id) || { total: 0, approved: 0 },
      })) : [],
    })),
  };
}

// Candidate source questions for comparing a draft against the bank.
export function similarSources(db, text, limit = 25) {
  const match = ftsQuery(text, { any: true, max: 32 });
  if (!match) return [];
  return db.prepare('SELECT q.id, p.source_key, q.provider, q.competition, q.source_question_number AS number, q.stem, q.options_json FROM questions_fts JOIN questions q ON q.id = questions_fts.rowid JOIN question_profile p ON p.question_id = q.id WHERE questions_fts MATCH ? ORDER BY bm25(questions_fts) LIMIT ?').all(match, limit)
    .map(r => ({ id: r.id, sourceKey: r.source_key, label: `${r.provider} · ${r.competition} · Q${r.number}`, text: [r.stem, ...Object.values(parseOptions(r.options_json))].join(' ') }));
}

// Reference questions for retrieval-grounded generation: pilot-topic questions
// without extraction damage, best full-text match first.
export function retrieveReferences(db, query, { k = 4, topic = PILOT_TOPIC } = {}) {
  const filters = "EXISTS (SELECT 1 FROM question_topics t WHERE t.question_id = q.id AND t.topic_id = ? AND t.status <> 'rejected') AND p.level_band <> 'secondary' AND NOT EXISTS (SELECT 1 FROM question_flags f WHERE f.question_id = q.id AND f.code IN ('garbled_text', 'option_noise', 'few_options'))";
  const columns = 'q.id, p.source_key, q.provider, q.competition, q.grade_scope, q.source_question_number AS number, q.stem, q.options_json, q.correct_option';
  const match = ftsQuery(query, { any: true, max: 32 });
  const ranked = match ? db.prepare(`SELECT ${columns} FROM questions_fts JOIN questions q ON q.id = questions_fts.rowid JOIN question_profile p ON p.question_id = q.id WHERE questions_fts MATCH ? AND ${filters} ORDER BY bm25(questions_fts), q.id LIMIT ?`).all(match, topic, k) : [];
  const rest = ranked.length < k ? db.prepare(`SELECT ${columns} FROM questions q JOIN question_profile p ON p.question_id = q.id WHERE ${filters} ORDER BY q.id`).all(topic).filter(r => !ranked.some(x => x.id === r.id)).slice(0, k - ranked.length) : [];
  const figure = db.prepare("SELECT figure_json FROM question_assets WHERE question_id = ? AND kind = 'circuit_figure' ORDER BY id LIMIT 1");
  const image = db.prepare("SELECT 1 FROM question_assets WHERE question_id = ? AND kind = 'figure_image' LIMIT 1");
  return [...ranked, ...rest].map((r, i) => {
    const circuit = figure.get(r.id);
    return {
      ref: `S${i + 1}`, bankId: r.id, sourceKey: r.source_key, source: `${r.provider} · ${r.competition} · ${r.grade_scope} · Q${r.number}`,
      stem: r.stem, options: parseOptions(r.options_json), hasKey: r.correct_option !== null,
      figure: circuit ? describeFigure(JSON.parse(circuit.figure_json)) : image.get(r.id) ? 'The source has a figure that is not reproduced here.' : null,
      matched: i < ranked.length,
    };
  });
}

// Build syllabus/primary-science-2023.json from the learning outcomes that
// extract_outcomes.py reads out of the MOE syllabus PDF. Developer tool: the app
// only reads the JSON this writes, so the PDF is never needed at runtime.
//
//   python3 scripts/syllabus/extract_outcomes.py SYLLABUS.pdf > outcomes-raw.json
//   node scripts/syllabus/build-syllabus.mjs outcomes-raw.json [SYLLABUS.pdf]
//
// Every "not required" note below is located in the extracted text, so a quote
// can never drift from the syllabus wording. Term patterns are ours: they are
// a screening aid for reviewers, not part of the syllabus.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const SHA256 = '0556023ceb55fe80de75ae044011b8c77ea7ea494a1873d2b224a9b2b8083ab0';
const [rawPath, pdfPath] = process.argv.slice(2);
if (!rawPath) throw new Error('Usage: node scripts/syllabus/build-syllabus.mjs outcomes-raw.json [SYLLABUS.pdf]');
if (pdfPath && createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex') !== SHA256) throw new Error('This builder is written for the January 2026 update of the 2023 syllabus.');
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

// [id, theme, level, short label, start of the printed topic title]
const TOPICS = [
  ['P3-DIVERSITY-LIVING', 'Diversity', 'P3', 'Living and non-living things', 'Diversity of Living and Non-Living Things'],
  ['P3-DIVERSITY-MATERIALS', 'Diversity', 'P3', 'Materials', 'Diversity of Materials'],
  ['P3-CYCLES-LIFE', 'Cycles', 'P3', 'Life cycles', 'Cycles in Plants and Animals (Life Cycles)'],
  ['P5-CYCLES-REPRODUCTION', 'Cycles', 'P5', 'Reproduction', 'Cycles in Plants and Animals (Reproduction)'],
  ['P4-CYCLES-MATTER', 'Cycles', 'P4', 'Matter', 'Cycles in Matter and Water (Matter)'],
  ['P5-CYCLES-WATER', 'Cycles', 'P5', 'Water', 'Cycles in Matter and Water (Water)'],
  ['P4-SYSTEMS-DIGESTIVE', 'Systems', 'P4', 'Human digestive system', 'Human System (Digestive System)'],
  ['P5-SYSTEMS-HUMAN-RESP-CIRC', 'Systems', 'P5', 'Human respiratory and circulatory systems', 'Human System (Respiratory'],
  ['P4-SYSTEMS-PLANT-PARTS', 'Systems', 'P4', 'Plant parts and functions', 'Plant System (Plant parts'],
  ['P5-SYSTEMS-PLANT-TRANSPORT', 'Systems', 'P5', 'Plant transport system', 'Plant System (Respiratory'],
  ['P5-SYSTEMS-ELECTRICAL', 'Systems', 'P5', 'Electrical system', 'Electrical System'],
  ['P3-INTERACTIONS-MAGNETS', 'Interactions', 'P3', 'Magnets', 'Interaction of Forces (Magnets)'],
  ['P6-INTERACTIONS-FORCES', 'Interactions', 'P6', 'Forces', 'Interaction of Forces (Frictional'],
  ['P6-INTERACTIONS-ENVIRONMENT', 'Interactions', 'P6', 'Interactions within the environment', 'Interactions within the Environment'],
  ['P4-ENERGY-LIGHT', 'Energy', 'P4', 'Light', 'Energy Forms and Uses (Light)'],
  ['P4-ENERGY-HEAT', 'Energy', 'P4', 'Heat', 'Energy Forms and Uses (Heat)'],
  ['P6-ENERGY-PHOTOSYNTHESIS', 'Energy', 'P6', 'Photosynthesis', 'Energy Forms and Uses (Photosynthesis)'],
  ['P6-ENERGY-CONVERSION', 'Energy', 'P6', 'Energy conversion', 'Energy Conversion'],
];
const DIMENSIONS = [['C', 'core_ideas'], ['P', 'practices'], ['V', 'values_ethics_attitudes']];
const STREAM_CODES = { all: 'A', standard: 'S', foundation: 'F' };

// Corrections to the extracted text, checked against the PDF by eye.
const fixText = text => text.replace(/(\d+) o C\b/g, '$1 °C'); // superscript degree sign
const MERGED_POINT = 'A force can stop a moving object. A force may change the shape of an object.'; // two bullets on page 65
const fixPoints = points => points.flatMap(p => p === MERGED_POINT ? ['A force can stop a moving object.', 'A force may change the shape of an object.'] : [fixText(p)]);

// Every "is/are not required" note in the syllabus outcome tables (22 distinct
// notes; a note repeated on the Standard and Foundation pages is one entry).
// block: a match fails the item's excluded-content check. flag: a match is a
// warning for the reviewer. Notes with no patterns are reviewer reminders.
const PAIR_METALS = '(?:copper|alumin(?:i)?um|silver|gold|brass|bronze|zinc|iron|steel)';
const EXCLUSIONS = [
  { id: 'NR-P3-LIVING-NAMES', topic: 'P3-DIVERSITY-LIVING', find: 'Recall of names of specific living things', summary: 'Recalling names and characteristics of specific living things', block: [], flag: [] },
  { id: 'NR-P3-DENSITY', topic: 'P3-DIVERSITY-MATERIALS', find: 'The concept of density is not required', summary: 'Density', block: ['\\bdensit(?:y|ies)\\b', '\\b(?:more|less) dense\\b', '\\bdenser\\b', '\\bdensest\\b'], flag: [] },
  { id: 'NR-P3-TRANSPARENCY-TERMS', topic: 'P3-DIVERSITY-MATERIALS', find: 'transparent/ translucent/ opaque is not required', summary: 'The terms transparent, translucent and opaque', block: [], flag: ['\\btransparent\\b', '\\btranslucent\\b', '\\bopaque\\b'] },
  { id: 'NR-P5-POLLINATION-TERMS', topic: 'P5-CYCLES-REPRODUCTION', find: '(“self-pollination” and “cross-pollination”)', summary: 'The terms self-pollination and cross-pollination', block: ['\\bself[- ]?pollinat', '\\bcross[- ]?pollinat'], flag: [] },
  { id: 'NR-P5-POLLEN-TUBE', topic: 'P5-CYCLES-REPRODUCTION', find: 'Knowledge of the pollen tube formation', summary: 'Pollen tube formation', block: ['\\bpollen[- ]tubes?\\b'], flag: [] },
  { id: 'NR-P5-FERTILISATION-SITE', topic: 'P5-CYCLES-REPRODUCTION', find: 'The specific location where fertilisation takes place', summary: 'Where fertilisation takes place in the female reproductive system', block: [], flag: ['\\bfallopian\\b', '\\boviducts?\\b', '\\bfertili[sz](?:ation|ed|es|e)\\b[^.?!]{0,60}\\b(?:in|inside|within) the (?:ovules?|ovary|ovaries|style|stigma|oviducts?)\\b'] },
  { id: 'NR-P5-FOETAL-DEVELOPMENT', topic: 'P5-CYCLES-REPRODUCTION', find: 'Foetal development and the mechanism', summary: 'Foetal development and the umbilical cord', block: [], flag: ['\\bf(?:o)?et(?:us|uses|al)\\b', '\\bumbilical\\b', '\\bplacenta\\b'] },
  { id: 'NR-P5-VEGETATIVE-PROPAGATION', topic: 'P5-CYCLES-REPRODUCTION', find: 'Vegetative propagation methods', summary: 'Vegetative propagation, such as stem cutting', block: [], flag: ['\\bvegetative\\b', '\\bstem cuttings?\\b', '\\bgraft(?:s|ed|ing)?\\b', '\\brhizomes?\\b'] },
  { id: 'NR-P4-MUSCULOSKELETAL-DETAIL', topic: 'P4-SYSTEMS-DIGESTIVE', find: 'Detailed knowledge of the muscular and skeletal systems', summary: 'Names of bones and muscles; how the muscular and skeletal systems work', block: [], flag: ['\\b(?:femur|tibia|fibula|humerus|ulna|patella|sternum|clavicle|scapula|pelvis|vertebrae?|cranium|biceps|triceps|quadriceps|hamstrings?|deltoids?|ligaments?|tendons?|cartilage)\\b'] },
  { id: 'NR-P5-RESP-CIRC-DETAIL', topic: 'P5-SYSTEMS-HUMAN-RESP-CIRC', find: 'Detailed knowledge of respiratory system', summary: 'Detailed respiratory and circulatory structures (alveoli, heart chambers and valves)', block: ['\\balveol(?:i|us|ar)\\b', '\\bbronch(?:i|us|ioles?|ial)\\b', '\\b(?:left|right) atri(?:um|a)\\b', '\\batria\\b', '\\bventricles?\\b', '\\b(?:heart|cardiac) (?:valves?|chambers?)\\b', '\\b(?:valves?|chambers?) (?:of|in) the heart\\b'], flag: ['\\bdiaphragm\\b'] },
  { id: 'NR-P5-TRANSPORT-TERMS', topic: 'P5-SYSTEMS-HUMAN-RESP-CIRC', find: 'The use of specific terms (xylem, phloem', summary: 'The terms xylem, phloem, stomata, artery, vein and capillary', block: ['\\bxylem\\b', '\\bphloem\\b', '\\bstomat(?:a|al|es?)\\b', '\\bstoma\\b', '\\barter(?:y|ies|ial)\\b', '\\bcapillar(?:y|ies)\\b'], flag: ['\\bveins?\\b'] },
  { id: 'NR-P5-TUBE-POSITIONS', topic: 'P5-SYSTEMS-PLANT-TRANSPORT', find: 'Recall of the relative positions', summary: 'Relative positions of the water-carrying and food-carrying tubes', block: [], flag: ['\\bvascular bundles?\\b', '\\b(?:water|food)[- ]carrying tubes?\\b[^.?!]{0,60}\\b(?:inner|outer|innermost|outermost|(?:nearer|closer) to the (?:centre|center|surface|outside))\\b', '\\b(?:inner|outer|innermost|outermost)\\b[^.?!]{0,40}\\b(?:water|food)[- ]carrying tubes?\\b'] },
  { id: 'NR-P5-XYLEM-PHLOEM', topic: 'P5-SYSTEMS-PLANT-TRANSPORT', find: 'The use of specific terms (xylem and phloem)', summary: 'The terms xylem and phloem', block: ['\\bxylem\\b', '\\bphloem\\b'], flag: [] },
  { id: 'NR-P5-TRANSPIRATION-PULL', topic: 'P5-SYSTEMS-PLANT-TRANSPORT', find: 'The concept of transpiration pull', summary: 'Transpiration pull', block: ['\\btranspiration pull\\b'], flag: ['\\btranspir(?:ation|es?|ed|ing)\\b'] },
  { id: 'NR-P3-NICKEL-COBALT', topic: 'P3-INTERACTIONS-MAGNETS', find: 'Recall of magnetic materials such as nickel and cobalt', summary: 'Recalling nickel and cobalt as magnetic materials', block: [], flag: ['\\bnickel\\b', '\\bcobalt\\b'] },
  { id: 'NR-P3-SHIELDING-INDUCTION', topic: 'P3-INTERACTIONS-MAGNETS', find: 'Magnetic shielding and magnetic induction', summary: 'Magnetic shielding and magnetic induction', block: ['\\bmagnetic(?:ally)? (?:shield(?:s|ed|ing)?|induc(?:tion|ed))\\b', '\\binduced (?:magnets?|magnetism|poles?)\\b'], flag: ['\\binduction\\b', '\\bshield(?:s|ed|ing)?\\b[^.?!]{0,40}\\bmagnet'] },
  { id: 'NR-P6-ROLLING-FRICTION', topic: 'P6-INTERACTIONS-FORCES', find: 'Direction of frictional force for “rolling objects”', summary: 'Direction of friction on rolling objects such as wheels and balls', block: [], flag: ['\\bdirection of (?:the )?friction(?:al)?(?: force)?\\b[^.?!]{0,80}\\b(?:roll(?:s|ing)?|wheels?|balls?)\\b', '\\b(?:roll(?:s|ing)?|wheels?|balls?)\\b[^.?!]{0,80}\\bdirection of (?:the )?friction'] },
  { id: 'NR-P6-RESISTANCE-TERMS', topic: 'P6-INTERACTIONS-FORCES', find: '‘air resistance’ and ‘water resistance’', summary: 'The terms air resistance and water resistance', block: ['\\bair resistance\\b', '\\bwater resistance\\b'], flag: [] },
  { id: 'NR-P4-LAW-OF-REFLECTION', topic: 'P4-ENERGY-LIGHT', find: 'The law of reflection is not required', summary: 'The law of reflection', block: ['\\blaws? of reflection\\b', '\\bangles? of (?:incidence|reflection)\\b', '\\bincident (?:rays?|angles?)\\b'], flag: ['\\breflected rays?\\b', '\\bnormal line\\b'] },
  { id: 'NR-P4-TRANSPARENCY-TERMS', topic: 'P4-ENERGY-LIGHT', find: '(transparent, translucent, opaque) is not required', summary: 'The terms transparent, translucent and opaque', block: [], flag: ['\\btransparent\\b', '\\btranslucent\\b', '\\bopaque\\b'] },
  { id: 'NR-P4-HEAT-TRANSFER-RATES', topic: 'P4-ENERGY-HEAT', find: 'Recall of the rate of heat transfer', summary: 'Comparing how fast specific metals conduct heat', block: [], flag: [`^(?=[\\s\\S]*\\b(?:heat\\w*|hot(?:ter)?|warm\\w*|cold\\w*)\\b)[\\s\\S]*?\\b(${PAIR_METALS.slice(3, -1)})\\b[\\s\\S]*\\b(?!\\1\\b)${PAIR_METALS}\\b`] },
  { id: 'NR-P6-POTENTIAL-ENERGY-TERMS', topic: 'P6-ENERGY-CONVERSION', find: 'chemical potential energy, gravitational potential energy', summary: 'The terms chemical, gravitational and elastic potential energy', block: ['\\b(?:chemical|gravitational|elastic) potential energy\\b'], flag: ['\\bchemical energy\\b', '\\bstrain energy\\b'] },
];

const topics = TOPICS.map(([id, theme, level, label, prefix]) => {
  const blocks = raw.filter(b => b.level === level && b.name.startsWith(prefix));
  if (!blocks.length) throw new Error(`No outcome pages found for ${id}.`);
  const streams = {}, outcomes = [];
  for (const block of blocks) {
    if (streams[block.stream]) throw new Error(`${id} has two ${block.stream} blocks.`);
    streams[block.stream] = { title: block.name, pages: block.pages };
    block.columns.forEach((items, column) => {
      const [code, dimension] = DIMENSIONS[column];
      items.forEach((item, index) => {
        if (item.kind !== 'outcome') throw new Error(`${id}: unexpected ${item.kind} text "${item.text}"`);
        outcomes.push({ id: `${id}-${STREAM_CODES[block.stream]}-${code}${index + 1}`, stream: block.stream, dimension, page: item.page, text: fixText(item.text), points: fixPoints(item.points), notes: item.notes.map(fixText) });
      });
    });
  }
  const topic = { id, theme, level, label, title: blocks[0].name, streams, outcomes };
  if (level >= 'P5' && !streams.foundation) topic.foundationNote = 'The syllabus has no Foundation outcome page for this topic; it is not required for Foundation Science.';
  return topic;
});

const exclusions = EXCLUSIONS.map(({ id, topic: topicId, find, summary, block, flag }) => {
  const topic = topics.find(t => t.id === topicId);
  const hits = topic.outcomes.flatMap(o => o.notes.filter(n => n.includes(find)).map(note => ({ outcome: o, note })));
  if (!hits.length) throw new Error(`${id}: note "${find}" not found in ${topicId}.`);
  for (const pattern of [...block, ...flag]) new RegExp(pattern, 'i');
  return {
    id, topicId, summary,
    note: hits[0].note,
    pages: [...new Set(hits.map(h => h.outcome.page))],
    streams: [...new Set(hits.map(h => h.outcome.stream))],
    outcomeIds: hits.map(h => h.outcome.id),
    check: block.length ? 'block' : flag.length ? 'flag' : 'review',
    block, flag,
  };
});
const allNotes = topics.flatMap(t => t.outcomes.flatMap(o => o.notes.filter(n => /\bnot required\b/i.test(n)).map(n => `${t.id}: ${n}`)));
const covered = new Set(exclusions.flatMap(e => topics.find(t => t.id === e.topicId).outcomes.filter(o => e.outcomeIds.includes(o.id)).flatMap(o => o.notes.filter(n => n.includes(EXCLUSIONS.find(x => x.id === e.id).find)).map(n => `${e.topicId}: ${n}`))));
const missing = allNotes.filter(n => !covered.has(n) && !/introduced in the topic/.test(n));
if (missing.length) throw new Error('Notes without an exclusion entry:\n' + missing.join('\n'));

const syllabus = {
  schemaVersion: 1,
  id: 'MOE-2023-PRIMARY-SCIENCE',
  title: 'Science Teaching and Learning Syllabus, Primary Three to Six, Standard / Foundation',
  edition: 'Implementation starting with the 2023 Primary Three cohort; updated January 2026',
  publisher: 'Curriculum Planning and Development Division, Ministry of Education, Singapore',
  copyright: '© 2022 Curriculum Planning and Development Division. The syllabus permits reproduction for personal or non-commercial educational use. Its learning outcomes are quoted here for curriculum alignment in a non-commercial student prototype; the PDF itself is not redistributed.',
  officialUrl: 'https://www.moe.gov.sg/-/media/files/primary/syllabus/2023-primary-science.ashx',
  source: { sha256: SHA256, pdfPages: 87, printedPage: 'printed page number = PDF page number - 1', outcomePages: '38-80', extractedWith: 'scripts/syllabus/extract_outcomes.py, then scripts/syllabus/build-syllabus.mjs' },
  ids: 'Topic and outcome IDs are internal labels for this prototype, not official MOE codes. Outcome ID = topic ID, stream (A all pupils in P3-P4, S Standard, F Foundation), dimension (C core ideas, P practices, V values, ethics and attitudes) and position on the page.',
  exclusionNote: 'Exclusions quote every "not required" note in the outcome tables. The block and flag term patterns are a screening aid written for this prototype, not syllabus text; a teacher still judges scope.',
  themes: ['Diversity', 'Cycles', 'Systems', 'Interactions', 'Energy'],
  topics,
  exclusions,
};
fs.writeFileSync(new URL('../../syllabus/primary-science-2023.json', import.meta.url), JSON.stringify(syllabus, null, 1) + '\n');
console.log(`${topics.length} topics, ${topics.reduce((n, t) => n + t.outcomes.length, 0)} outcomes, ${exclusions.length} exclusion notes (${exclusions.filter(e => e.check !== 'review').length} with term patterns).`);

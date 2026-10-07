import { readFileSync } from 'node:fs';

// Full 2023 primary science syllabus (see scripts/syllabus) and the pilot topic.
export const syllabus = JSON.parse(readFileSync(new URL('./syllabus/primary-science-2023.json', import.meta.url), 'utf8'));
const curriculum = JSON.parse(readFileSync(new URL('./curriculum.json', import.meta.url), 'utf8'));
export const outcomes = new Map(syllabus.topics.flatMap(t => t.outcomes.map(o => [o.id, { ...o, topicId: t.id, topicLabel: t.label, level: t.level }])));

// Screening rules: every "not required" note in the syllabus, plus the pilot
// topic's own scope rules. Patterns are case-insensitive.
const compile = (rule, source) => ({
  id: rule.id, source, summary: rule.summary || rule.text, pages: rule.pages || [],
  block: (rule.block || []).map(p => new RegExp(p, 'i')), flag: (rule.flag || []).map(p => new RegExp(p, 'i')),
});
export const screeningRules = [
  ...syllabus.exclusions.map(rule => compile(rule, 'syllabus')),
  ...(curriculum.scopeRules || []).map(rule => compile(rule, 'curriculum')),
];
export const reviewOnlyNotes = syllabus.exclusions.filter(e => e.check === 'review');

const shorten = term => term.length > 40 ? '…' + term.slice(-30) : term;
export function screenText(text) {
  const hits = [];
  for (const rule of screeningRules) {
    const blocked = rule.block.map(r => text.match(r)?.[0]).filter(Boolean);
    const flagged = blocked.length ? [] : rule.flag.map(r => text.match(r)?.[0]).filter(Boolean);
    if (blocked.length || flagged.length) hits.push({ id: rule.id, source: rule.source, severity: blocked.length ? 'block' : 'flag', terms: [...new Set([...blocked, ...flagged].map(shorten))], summary: rule.summary, pages: rule.pages });
  }
  return hits;
}

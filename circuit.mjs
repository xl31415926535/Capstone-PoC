// Circuit figures for P5 electricity questions: structure checks, a nodal
// solver, an SVG drawing and a plain-text description. It has no imports, so
// the browser loads this same file (served at /circuit.mjs).
//
// A figure has 1-4 panels. Each panel is one loop, listed in order around the
// loop. A loop part is a battery, bulb, switch, gap or wire, or a parallel
// section of 2-3 branches; a branch is a short series of bulbs, switches, gaps
// or wires. Batteries stay in the main loop (page 59: batteries in series).

export const COMPONENTS = ['battery', 'bulb', 'switch', 'gap', 'wire'];
export const BRANCH_COMPONENTS = ['bulb', 'switch', 'gap', 'wire'];
export const VERIFICATIONS = ['none', 'lit_bulbs', 'brightest_bulb', 'dimmest_bulb', 'brightest_circuit', 'dimmest_circuit', 'switch_setting'];
const LABEL = /^[A-Z][0-9]?$/;

// Identical cells and bulbs. Wires, closed switches, conducting strips and the
// cells' internal resistance are tiny, so ideal-circuit answers come out.
const EMF = 1, R_BULB = 1, R_SMALL = 1e-4;
const LIT_CURRENT = 0.01;    // single cell and bulb = 1; a bypassed bulb carries ~1e-4
const SHORT_CURRENT = 100;   // normal circuits stay below ~12
const SAME = 0.03;           // brightness values within 3% count as equal

const partsOf = panel => (panel.elements || []).flatMap(el => el.kind === 'parallel' ? (el.branches || []).flat() : [el]);
const panelName = panel => panel.label ? `Circuit ${panel.label}` : 'The circuit';
const listWords = words => words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words.at(-1);

export function figureErrors(figure) {
  const errors = [];
  if (!figure || !Array.isArray(figure.panels) || !figure.panels.length) return ['The figure has no circuit.'];
  if (figure.panels.length > 4) errors.push('Use at most four circuit panels.');
  const panelLabels = figure.panels.map(p => p.label);
  if (figure.panels.length > 1 && (panelLabels.some(l => !LABEL.test(l || '')) || new Set(panelLabels).size !== panelLabels.length)) errors.push('Label each circuit panel with a different letter, such as A, B, C and D.');
  for (const panel of figure.panels) {
    const name = panelName(panel), elements = Array.isArray(panel.elements) ? panel.elements : [];
    if (elements.length < 2 || elements.length > 8) errors.push(`${name} needs 2-8 parts in its loop.`);
    for (const el of elements) {
      if (el.kind === 'parallel') {
        const branches = Array.isArray(el.branches) ? el.branches : [];
        if (branches.length < 2 || branches.length > 3) errors.push(`${name}: a parallel section needs two or three branches.`);
        for (const branch of branches) {
          if (!Array.isArray(branch) || !branch.length || branch.length > 4) errors.push(`${name}: each parallel branch needs 1-4 parts.`);
          for (const part of branch || []) if (!BRANCH_COMPONENTS.includes(part?.kind)) errors.push(`${name}: a parallel branch cannot hold a ${part?.kind}; batteries stay in series in the main loop.`);
        }
      } else if (!COMPONENTS.includes(el?.kind)) errors.push(`${name}: unknown part "${el?.kind}".`);
      else if (el.branches?.length) errors.push(`${name}: only a parallel section has branches.`);
    }
    const parts = partsOf(panel).filter(p => p && typeof p === 'object');
    const batteries = parts.filter(p => p.kind === 'battery').length;
    if (!batteries) errors.push(`${name} has no battery.`);
    if (batteries > 4) errors.push(`${name}: use at most four batteries.`);
    if (!parts.some(p => p.kind === 'bulb')) errors.push(`${name} has no bulb.`);
    const labelled = parts.filter(p => ['bulb', 'switch', 'gap'].includes(p.kind));
    if (labelled.some(p => !LABEL.test(p.label || ''))) errors.push(`${name}: give every bulb, switch and gap a short label such as A, S1 or X.`);
    if (new Set(labelled.map(p => p.label)).size !== labelled.length) errors.push(`${name}: labels must be different within one circuit.`);
    for (const p of parts) {
      if (p.kind === 'switch' && !['open', 'closed'].includes(p.state)) errors.push(`${name}: switch ${p.label} must be open or closed.`);
      if (p.kind === 'gap' && !['conductor', 'insulator', 'none'].includes(p.material)) errors.push(`${name}: gap ${p.label} needs a conductor, an insulator or nothing across it.`);
    }
  }
  return [...new Set(errors)];
}

function network(panel, closedSwitches) {
  let next = 1;
  const edges = [];
  const closed = part => closedSwitches ? closedSwitches.includes(part.label) : part.state === 'closed';
  const conductance = part => part.kind === 'bulb' ? 1 / R_BULB
    : part.kind === 'battery' || part.kind === 'wire' ? 1 / R_SMALL
    : part.kind === 'switch' ? (closed(part) ? 1 / R_SMALL : 0)
    : part.material === 'conductor' ? 1 / R_SMALL : 0;
  // Going round the loop in listed order, each battery raises the potential.
  const add = (part, a, b) => edges.push({ part, a, b, g: conductance(part) });
  const elements = panel.elements;
  let node = 0;
  elements.forEach((el, i) => {
    const end = i === elements.length - 1 ? 0 : next++;
    if (el.kind === 'parallel') for (const branch of el.branches) {
      let from = node;
      branch.forEach((part, j) => { const to = j === branch.length - 1 ? end : next++; add(part, from, to); from = to; });
    }
    else add(el, node, end);
    node = end;
  });
  return { nodes: next, edges };
}

function gauss(matrix, rhs) {
  const n = rhs.length, m = matrix.map((row, i) => [...row, rhs[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      if (f) for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

// Nodal analysis with each cell as a source behind a tiny resistance. Only
// nodes joined to the first cell's negative end are solved; parts cut off by
// open switches or insulators carry no current.
export function solvePanel(panel, closedSwitches = null) {
  const { nodes, edges } = network(panel, closedSwitches);
  const ground = edges.find(e => e.part.kind === 'battery').a;
  const links = Array.from({ length: nodes }, () => []);
  for (const e of edges) if (e.g > 0) { links[e.a].push(e.b); links[e.b].push(e.a); }
  const reached = new Set([ground]), stack = [ground];
  while (stack.length) for (const n of links[stack.pop()]) if (!reached.has(n)) { reached.add(n); stack.push(n); }
  const index = new Map([...reached].filter(n => n !== ground).map((n, i) => [n, i]));
  const g = Array.from({ length: index.size }, () => new Array(index.size).fill(0)), injected = new Array(index.size).fill(0);
  for (const e of edges) {
    if (!e.g || !reached.has(e.a)) continue;
    const i = index.get(e.a), j = index.get(e.b);
    if (i !== undefined) g[i][i] += e.g;
    if (j !== undefined) g[j][j] += e.g;
    if (i !== undefined && j !== undefined) { g[i][j] -= e.g; g[j][i] -= e.g; }
    if (e.part.kind === 'battery') {
      if (j !== undefined) injected[j] += EMF * e.g;
      if (i !== undefined) injected[i] -= EMF * e.g;
    }
  }
  const v = index.size ? gauss(g, injected) : [];
  const potential = n => n === ground ? 0 : v[index.get(n)];
  const current = e => !e.g || !reached.has(e.a) ? 0 : (potential(e.a) - potential(e.b)) * e.g + (e.part.kind === 'battery' ? EMF * e.g : 0);
  const bulbs = edges.filter(e => e.part.kind === 'bulb').map(e => {
    const i = Math.abs(current(e));
    return { label: e.part.label, lit: i > LIT_CURRENT, brightness: Math.round(i * i * R_BULB * 100) / 100 };
  });
  const batteryCurrent = Math.max(...edges.filter(e => e.part.kind === 'battery').map(e => Math.abs(current(e))));
  return { label: panel.label || '', bulbs, shortCircuit: batteryCurrent > SHORT_CURRENT };
}

const same = (a, b) => Math.abs(a - b) <= SAME * Math.max(a, b, 1e-9);
const set = list => [...new Set(list)].sort();
const equalSets = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const bulbWords = labels => labels.length ? listWords(labels) : 'no bulb';

// Which labels an option's own words name. Returns null when the wording is
// too free to read safely ("all except B", "the bulb nearest the battery").
function namedLabels(text, known, kind) {
  const words = String(text || '').replace(/^A (?=(?!and\b|or\b|only\b|alone\b)[a-z])/, ''); // "A bulb ...": an article, not bulb A
  if (/\b(?:except|apart from|other than|but not|not)\b/i.test(words) || (kind === 'switch' && /\bopen\b/i.test(words))) return null;
  const found = set((words.match(/\b[A-Z][0-9]?\b/g) || []).filter(t => known.includes(t)));
  if (found.length) return found;
  if (/\b(?:none|neither|no (?:bulbs?|switch(?:es)?))\b/i.test(words)) return [];
  if (/\b(?:all|every|both)\b/i.test(words)) return set(known);
  return null;
}

// Check the keyed answer of a figure question against the solved circuit.
// `check` is the generator's statement of what each option means.
export function verifyFigure(figure, check, options, keyOptionId) {
  const errors = figureErrors(figure);
  if (errors.length) return { status: 'fail', detail: 'The circuit figure cannot be used: ' + errors.join(' '), solution: null };
  const panels = figure.panels.map(p => solvePanel(p));
  const solution = { kind: 'circuit_solution', panels, verification: check?.kind || 'none', expected: null, optionId: null };
  const shorted = panels.filter(p => p.shortCircuit);
  if (shorted.length) return { status: 'fail', detail: `${listWords(shorted.map(p => p.label ? `Circuit ${p.label}` : 'The circuit'))} short-circuits the battery: wires, closed switches or conductors join its two ends with no bulb in the path. Short circuits are outside the P5 scope.`, solution };
  if (!check || check.kind === 'none') return { status: 'not_run', detail: 'The figure was drawn and solved, but the question is not one of the machine-checkable types. The blind solve and the reviewer must check the answer.', solution };
  if (!VERIFICATIONS.includes(check.kind)) return { status: 'fail', detail: `Unknown verification type "${check.kind}".`, solution };
  const ids = (options || []).map(o => o.id);
  const meanings = new Map((check.options || []).map(o => [o.optionId, o]));
  if (ids.length !== 4 || ids.some(id => !meanings.has(id)) || meanings.size !== ids.length) return { status: 'fail', detail: 'The verification must state what each of the four options means.', solution };
  const multi = ['brightest_circuit', 'dimmest_circuit'].includes(check.kind);
  if (multi ? figure.panels.length < 2 : figure.panels.length !== 1) return { status: 'fail', detail: multi ? 'Comparing circuits needs two to four labelled panels.' : 'This verification type needs exactly one circuit panel.', solution };
  const panel = figure.panels[0], solved = panels[0];
  const bulbs = partsOf(panel).filter(p => p.kind === 'bulb').map(p => p.label);
  const switches = partsOf(panel).filter(p => p.kind === 'switch').map(p => p.label);
  const fail = detail => ({ status: 'fail', detail, solution });
  let truth, describe, matches, mismatches = [], unread = [];

  const textCheck = (option, expectedLabels, known, kindWord) => {
    const named = namedLabels(option.text, known, kindWord);
    if (named === null) unread.push(option.id);
    else if (!equalSets(named, expectedLabels)) mismatches.push(`option ${option.id} reads "${option.text}" but is mapped to ${expectedLabels.length ? listWords(expectedLabels) : 'none'}`);
  };

  if (check.kind === 'lit_bulbs') {
    truth = set(solved.bulbs.filter(b => b.lit).map(b => b.label));
    const unlit = solved.bulbs.filter(b => !b.lit).map(b => b.label);
    describe = `${bulbWords(truth)} ${truth.length === 1 ? 'lights' : 'light'}${unlit.length ? `; ${listWords(unlit)} ${unlit.length === 1 ? 'does' : 'do'} not` : ''}`;
    for (const option of options) {
      const mapped = set(meanings.get(option.id).bulbs || []);
      if (mapped.some(l => !bulbs.includes(l))) return fail(`Option ${option.id} is mapped to a bulb that is not in the figure.`);
      textCheck(option, mapped, bulbs, 'bulb');
    }
    matches = options.filter(o => equalSets(set(meanings.get(o.id).bulbs || []), truth)).map(o => o.id);
  } else if (check.kind === 'brightest_bulb' || check.kind === 'dimmest_bulb') {
    const brightest = check.kind === 'brightest_bulb';
    if (!brightest && solved.bulbs.some(b => !b.lit)) return fail(`${listWords(solved.bulbs.filter(b => !b.lit).map(b => b.label))} does not light, so "dimmest" is ambiguous.`);
    const lit = solved.bulbs.filter(b => b.lit);
    if (!lit.length) return fail('No bulb lights in this circuit.');
    const extreme = lit.reduce((a, b) => (brightest ? b.brightness > a.brightness : b.brightness < a.brightness) ? b : a);
    const ties = lit.filter(b => same(b.brightness, extreme.brightness)).map(b => b.label);
    if (ties.length > 1) return fail(`${listWords(ties)} are equally ${brightest ? 'bright' : 'dim'}, so no single bulb is the ${brightest ? 'brightest' : 'dimmest'}.`);
    truth = extreme.label;
    describe = `bulb ${truth} is the ${brightest ? 'brightest' : 'dimmest'} (${solved.bulbs.map(b => `${b.label} ${b.lit ? b.brightness : 'unlit'}`).join(', ')}; one cell with one bulb = 1)`;
    for (const option of options) {
      const mapped = meanings.get(option.id).bulbs || [];
      if (mapped.length !== 1 || !bulbs.includes(mapped[0])) return fail(`Option ${option.id} must be mapped to exactly one bulb in the figure.`);
      textCheck(option, mapped, bulbs, 'bulb');
    }
    matches = options.filter(o => meanings.get(o.id).bulbs[0] === truth).map(o => o.id);
  } else if (multi) {
    const brightest = check.kind === 'brightest_circuit';
    const levels = [];
    for (const p of panels) {
      if (!brightest && p.bulbs.some(b => !b.lit)) return fail(`A bulb in Circuit ${p.label} does not light, so "dimmest" is ambiguous.`);
      const values = p.bulbs.map(b => b.lit ? b.brightness : 0);
      if (values.some(x => !same(x, values[0]))) return fail(`The bulbs in Circuit ${p.label} differ in brightness. Ask about one named bulb instead.`);
      levels.push({ label: p.label, value: values[0] });
    }
    const extreme = levels.reduce((a, b) => (brightest ? b.value > a.value : b.value < a.value) ? b : a);
    const ties = levels.filter(l => same(l.value, extreme.value)).map(l => l.label);
    if (ties.length > 1) return fail(`Circuits ${listWords(ties)} are equally ${brightest ? 'bright' : 'dim'}.`);
    truth = extreme.label;
    describe = `the bulbs in Circuit ${truth} are the ${brightest ? 'brightest' : 'dimmest'} (${levels.map(l => `${l.label} ${l.value}`).join(', ')}; one cell with one bulb = 1)`;
    const panelLabels = figure.panels.map(p => p.label);
    for (const option of options) {
      const mapped = meanings.get(option.id).circuit;
      if (!panelLabels.includes(mapped)) return fail(`Option ${option.id} must be mapped to one of Circuits ${listWords(panelLabels)}.`);
      const named = String(option.text).trim() === mapped ? mapped : String(option.text).match(/\b(?:circuit|set-?up|arrangement)\s+([A-Z][0-9]?)\b/i)?.[1];
      if (!named) unread.push(option.id);
      else if (named !== mapped) mismatches.push(`option ${option.id} reads "${option.text}" but is mapped to Circuit ${mapped}`);
    }
    matches = options.filter(o => meanings.get(o.id).circuit === truth).map(o => o.id);
  } else {
    if (!switches.length) return fail('A switch-setting question needs at least one switch.');
    truth = set(check.targetLit || []);
    if (truth.some(l => !bulbs.includes(l))) return fail('The target bulbs must be bulbs in the figure.');
    describe = `the target is ${truth.length ? `${listWords(truth)} lit and no other bulb` : 'no bulb lit'}`;
    matches = [];
    for (const option of options) {
      const closed = set(meanings.get(option.id).closedSwitches || []);
      if (closed.some(l => !switches.includes(l))) return fail(`Option ${option.id} closes a switch that is not in the figure.`);
      const result = solvePanel(panel, closed);
      if (result.shortCircuit) return fail(`Closing ${listWords(closed)} (option ${option.id}) short-circuits the battery. Short circuits are outside the P5 scope.`);
      if (equalSets(set(result.bulbs.filter(b => b.lit).map(b => b.label)), truth)) matches.push(option.id);
      textCheck(option, closed, switches, 'switch');
    }
  }
  solution.expected = truth;
  if (mismatches.length) return fail(`The options do not match their stated meanings: ${mismatches.join('; ')}.`);
  if (matches.length !== 1) return fail(`Solved: ${describe}. ${matches.length ? `Options ${listWords(matches.map(String))} all match` : 'No option matches'}, so the question has no single correct answer.`);
  solution.optionId = matches[0];
  if (matches[0] !== keyOptionId) return fail(`Solved: ${describe}. That is option ${matches[0]}, but the key says option ${keyOptionId}.`);
  return { status: 'pass', detail: `Solved: ${describe}. Only option ${matches[0]} matches, and it is the key.${unread.length ? ` The wording of option${unread.length > 1 ? 's' : ''} ${listWords(unread.map(String))} was not machine-read; the reviewer should confirm it.` : ''} Ideal identical cells and bulbs are assumed.`, solution };
}

function partName(part, inBranch) {
  if (part.kind === 'battery') return 'a battery';
  if (part.kind === 'bulb') return `bulb ${part.label}`;
  if (part.kind === 'switch') return `switch ${part.label} (${part.state === 'closed' ? 'closed' : 'open'})`;
  if (part.kind === 'gap') return part.material === 'none' ? `an empty gap ${part.label}` : `object ${part.label} placed across a gap`;
  return inBranch ? 'a wire' : null;
}
function seriesWords(parts, inBranch) {
  const words = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].kind === 'battery') {
      let n = 1;
      while (parts[i + n]?.kind === 'battery') n++;
      words.push(n === 1 ? 'a battery' : `${['', '', 'two', 'three', 'four'][n]} batteries in series`);
      i += n - 1;
    } else {
      const word = partName(parts[i], inBranch);
      if (word) words.push(word);
    }
  }
  return words;
}

// What a pupil sees, in words: the alt text and the blind solver's view.
// Gap materials are never stated, because the drawing does not show them.
export function describeFigure(figure) {
  return figure.panels.map(panel => {
    const words = [];
    const plain = [];
    const flush = () => { if (plain.length) words.push(...seriesWords(plain.splice(0), false)); };
    for (const el of panel.elements) {
      if (el.kind !== 'parallel') { plain.push(el); continue; }
      flush();
      words.push(`a parallel section with ${el.branches.length === 2 ? 'two' : 'three'} branches (${el.branches.map((b, i) => `branch ${i + 1}: ${listWords(seriesWords(b, true))}`).join('; ')})`);
    }
    flush();
    return `${panel.label ? `Circuit ${panel.label}` : 'Circuit'}: one loop with ${listWords(words)}, connected in that order and back to the start.`;
  }).join(' ');
}

// The question as a blind solver reads it: the drawing replaced by its description.
export function textOnlyQuestion(studentQuestion) {
  const { figure, ...rest } = studentQuestion || {};
  return rest;
}

// Pupils see that something bridges a gap, not what it is made of.
export function pupilFigure(figure) {
  if (!figure) return figure;
  const hide = part => part.kind === 'gap' && part.material !== 'none' ? { ...part, material: 'unknown' } : part;
  return { panels: figure.panels.map(p => ({ ...p, elements: p.elements.map(el => el.kind === 'parallel' ? { ...el, branches: el.branches.map(b => b.map(hide)) } : hide(el)) })) };
}

export function figureMaterials(figure) {
  return (figure?.panels || []).flatMap(p => partsOf(p).filter(x => x.kind === 'gap' && ['conductor', 'insulator'].includes(x.material)).map(x => `${p.label ? `Circuit ${p.label}, ` : ''}${x.label}: ${x.material}`));
}

// ---- Drawing ----
const W = { bulb: 56, switch: 60, gap: 64, wire: 28 };
const CELL = 22;
const SPACING = 22, BRANCH_GAP = 58, RAIL = 18, SIDE = 30, INK = '#16272a';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const width = el => el.kind === 'parallel' ? 2 * RAIL + Math.max(...el.branches.map(b => b.reduce((s, p) => s + (W[p.kind] || 28), 0) + SPACING * (b.length - 1))) : el.kind === 'pack' ? CELL * el.count + 22 : (W[el.kind] || 28);
const depth = el => el.kind === 'parallel' ? (el.branches.length - 1) * BRANCH_GAP : 0;
const rowWidth = row => row.reduce((s, el) => s + width(el), 0) + SPACING * Math.max(0, row.length - 1);

function drawPart(part, cx, y, dir, labelBelow, out) {
  const text = part.label && part.kind !== 'battery' && part.kind !== 'wire'
    ? `<text x="${cx}" y="${labelBelow ? y + 30 : y - 20}" text-anchor="middle" fill="${INK}" stroke="none" font-size="14" font-weight="600">${esc(part.label)}</text>` : '';
  if (part.kind === 'pack') {
    // Cells in series, drawn side by side; the long plate is the positive end.
    for (let i = 0; i < part.count; i++) {
      const cell = cx + dir * (i - (part.count - 1) / 2) * CELL, pos = cell + 5 * dir, neg = cell - 5 * dir;
      out.push(`<rect x="${cell - 5}" y="${y - 3}" width="10" height="6" fill="#fff" stroke="none"/>`,
        `<line x1="${pos}" y1="${y - 17}" x2="${pos}" y2="${y + 17}"/>`,
        `<line x1="${neg}" y1="${y - 8}" x2="${neg}" y2="${y + 8}" stroke-width="5"/>`);
      if (i === part.count - 1) out.push(`<text x="${pos + 9 * dir}" y="${y - 12}" text-anchor="middle" fill="${INK}" stroke="none" font-size="12">+</text>`);
    }
  } else if (part.kind === 'bulb') {
    out.push(`<circle cx="${cx}" cy="${y}" r="12" fill="#fff"/>`,
      `<line x1="${cx - 8.5}" y1="${y - 8.5}" x2="${cx + 8.5}" y2="${y + 8.5}"/>`,
      `<line x1="${cx - 8.5}" y1="${y + 8.5}" x2="${cx + 8.5}" y2="${y - 8.5}"/>`, text);
  } else if (part.kind === 'switch') {
    const a = cx - 15, b = cx + 15;
    out.push(`<rect x="${a}" y="${y - 3}" width="30" height="6" fill="#fff" stroke="none"/>`,
      part.state === 'closed' ? `<line x1="${a}" y1="${y}" x2="${b}" y2="${y}"/>` : `<line x1="${a}" y1="${y}" x2="${b - 1}" y2="${y - 16}"/>`,
      `<circle cx="${a}" cy="${y}" r="3" fill="#fff"/>`, `<circle cx="${b}" cy="${y}" r="3" fill="#fff"/>`, text);
  } else if (part.kind === 'gap') {
    const a = cx - 17, b = cx + 17;
    out.push(`<rect x="${a}" y="${y - 3}" width="34" height="6" fill="#fff" stroke="none"/>`,
      `<circle cx="${a}" cy="${y}" r="3" fill="${INK}"/>`, `<circle cx="${b}" cy="${y}" r="3" fill="${INK}"/>`);
    if (part.material !== 'none') out.push(`<rect x="${a - 7}" y="${y - 6}" width="${b - a + 14}" height="12" rx="2" fill="#e9e1cc"/>`);
    out.push(text);
  }
}

function drawRow(row, x0, x1, y, dir, edgeBelow, out) {
  const free = (x1 - x0 - rowWidth(row) + SPACING * Math.max(0, row.length - 1)) / (row.length + 1);
  let x = dir > 0 ? x0 + free : x1 - free;
  for (const el of row) {
    const w = width(el), left = dir > 0 ? x : x - w, right = left + w;
    if (el.kind === 'parallel') {
      const sign = edgeBelow ? -1 : 1, bottom = y + sign * depth(el);
      out.push(`<line x1="${left}" y1="${y}" x2="${left}" y2="${bottom}"/>`, `<line x1="${right}" y1="${y}" x2="${right}" y2="${bottom}"/>`);
      el.branches.forEach((branch, k) => {
        const by = y + sign * k * BRANCH_GAP;
        if (k) out.push(`<line x1="${left}" y1="${by}" x2="${right}" y2="${by}"/>`);
        const total = branch.reduce((s, p) => s + (W[p.kind] || 28), 0) + SPACING * (branch.length - 1);
        let px = dir > 0 ? left + (w - total) / 2 : right - (w - total) / 2;
        for (const part of branch) {
          const pw = W[part.kind] || 28;
          drawPart(part, dir > 0 ? px + pw / 2 : px - pw / 2, by, dir, edgeBelow && k === 0, out);
          px += dir * (pw + SPACING);
        }
      });
    } else drawPart(el, left + w / 2, y, dir, edgeBelow, out);
    x += dir * (w + free);
  }
}

// Consecutive batteries are laid out together as one pack of cells.
const units = elements => elements.reduce((out, el) => {
  if (el.kind === 'battery' && out.at(-1)?.kind === 'pack') out.at(-1).count++;
  else out.push(el.kind === 'battery' ? { kind: 'pack', count: 1 } : el);
  return out;
}, []);

function panelLayout(panel) {
  const els = units(panel.elements), widths = els.map(width);
  const total = rowWidth(els);
  let k = 0, used = 0;
  while (k < els.length && (k === 0 || used + widths[k] <= total / 2 + 1)) { used += widths[k] + SPACING; k++; }
  if (k === els.length && els.length > 1) k = els.length - 1;
  const top = els.slice(0, k), bottom = els.slice(k);
  const inner = Math.max(rowWidth(top), rowWidth(bottom), 130);
  const height = Math.max(100, Math.max(0, ...top.map(depth)) + Math.max(0, ...bottom.map(depth)) + 70);
  return { top, bottom, inner, height, width: inner + 2 * SIDE, full: height + (panel.label ? 74 : 56) };
}

export function renderFigureSvg(figure, { title } = {}) {
  const layouts = figure.panels.map(panelLayout);
  const cols = figure.panels.length === 1 ? 1 : 2, gap = 36, pad = 14;
  const cellW = Math.max(...layouts.map(l => l.width)), cellH = Math.max(...layouts.map(l => l.full));
  const rows = Math.ceil(figure.panels.length / cols);
  const vw = cols * cellW + (cols - 1) * gap + 2 * pad, vh = rows * cellH + (rows - 1) * gap + 2 * pad;
  const out = [];
  figure.panels.forEach((panel, i) => {
    const l = layouts[i], ox = pad + (i % cols) * (cellW + gap) + (cellW - l.width) / 2, oy = pad + Math.floor(i / cols) * (cellH + gap);
    const top = (panel.label ? 50 : 32), bottom = top + l.height, left = 0, right = l.width;
    out.push(`<g transform="translate(${ox} ${oy})">`);
    if (panel.label) out.push(`<text x="${left}" y="16" fill="${INK}" stroke="none" font-size="15" font-weight="700">Circuit ${esc(panel.label)}</text>`);
    out.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="none"/>`);
    drawRow(l.top, left + SIDE, right - SIDE, top, 1, false, out);
    drawRow(l.bottom, left + SIDE, right - SIDE, bottom, -1, true, out);
    out.push('</g>');
  });
  const alt = title || describeFigure(figure);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" role="img" aria-label="${esc(alt)}" style="max-width:100%;height:auto;background:#fff"><g fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" font-family="system-ui, sans-serif">${out.join('')}</g></svg>`;
}

if (typeof window !== 'undefined') window.SimccCircuit = { renderFigureSvg, describeFigure, figureMaterials };

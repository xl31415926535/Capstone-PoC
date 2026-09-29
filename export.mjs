export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
export function printableRecord(record) {
  const e = escapeHtml, item = record.item, q = item.student_question || {};
  const rows = (q.observations || []).map(o => `<tr><td>${e(o.test)}</td><td>${e(o.gap_X)}</td><td>${e(o.gap_Y)}</td><td>${e(o.bulb)}</td></tr>`).join('');
  const sources = (item.sources || []).map(s => `<li>${e(s.title)} — ${e(s.url)}</li>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIMCC review — ${e(record.id)}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#16272a}h1{font-size:26px}h2{font-size:19px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #ccd5d3;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace}.stem{white-space:pre-wrap}.status{border:2px solid #536f6b;padding:14px}li{margin:8px 0}@media print{body{margin:0;max-width:none}h2,tr{break-inside:avoid}.print-note{display:none}}</style><body>
  <p class="print-note">Use your browser's Print → Save as PDF. This review sheet is not an official MOE examination paper.</p>
  <p>SIMCC / SCIENCE STUDIO · PROTOTYPE REVIEW SHEET</p><h1>${e(record.title)}</h1>
  <div class="status"><strong>${e(record.status.toUpperCase())} · Version ${e(record.version)}</strong><br>${e(record.provenance.label)}<br>Record ${e(record.id)} · ${e(record.updatedAt)}</div>
  <p>${e(item.grade)} / ${e(item.stream)} / ${e(item.topic)} · ${e(item.format)} · Difficulty ${e(item.difficulty_estimate)} (provisional)</p>
  <h2>Student question</h2><div class="stem">${e(q.stem)}</div><p>${e(q.diagram_alt)}</p>
  ${rows?`<table><thead><tr><th>Test</th><th>Gap X</th><th>Gap Y</th><th>Bulb</th></tr></thead><tbody>${rows}</tbody></table>`:''}
  ${q.table?.rows?.length?`<table><thead><tr>${q.table.columns.map(c=>`<th>${e(c)}</th>`).join('')}</tr></thead><tbody>${q.table.rows.map(row=>`<tr>${row.map(cell=>`<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:''}
  <p><strong>${e(q.question)}</strong></p><ol>${(q.options || []).map(o => `<li value="${e(o.id)}">${e(o.text)}</li>`).join('')}</ol>
  <h2>Answer and distractors</h2><p>Option ${e(item.answer?.option_id)}. ${e(item.answer?.explanation_en)}</p><ul>${(item.distractor_rationales || []).map(d => `<li>Option ${e(d.option_id)}: ${e(d.issue)}</li>`).join('')}</ul>
  ${item.solution_steps?.length?`<h2>Student-facing solution steps</h2><ol>${item.solution_steps.map(s=>`<li>${e(s)}</li>`).join('')}</ol>`:''}
  ${record.labels?`<h2>Current academic labels</h2><pre>${e(JSON.stringify(record.labels,null,2))}</pre>`:''}
  <h2>Curriculum mapping</h2><ul>${(item.syllabus_mapping || []).map(m => `<li>${e(m.internal_mapping_id)} — ${e(m.outcome_paraphrase)}<br>${e(m.item_evidence)}<br>Page ${e(m.printed_page ?? m.pdf_page)} · ${e(m.source_id)}</li>`).join('')}</ul>
  <h2>Executed checks</h2><ul>${(record.checks?.results || []).map(c => `<li><strong>${e(c.status.toUpperCase())} · ${e(c.label)}</strong>: ${e(c.detail)}</li>`).join('')}</ul>
  <p>Similarity is limited to the local comparison corpus and is not an originality certificate.</p>
  <h2>Independent solve</h2><pre>${e(record.blindReview ? JSON.stringify(record.blindReview, null, 2) : 'Not run for this version.')}</pre>
  <h2>Jev signals</h2><pre>${e(record.jevReview ? JSON.stringify(record.jevReview, null, 2) : 'Not run. Optional and not a substitute for human approval.')}</pre>
  <h2>Review history</h2><pre>${e(JSON.stringify(record.reviewEvents, null, 2))}</pre>
  <h2>Provenance</h2><pre>${e(JSON.stringify(record.provenance, null, 2))}</pre><h2>Sources</h2><ul>${sources}</ul>
  </body></html>`;
}

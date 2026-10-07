# Science Studio v2 implementation contract

Node.js >=20, no package dependencies (the source bank needs Node.js 22.5+ for built-in `node:sqlite`). Vanilla HTML/CSS/JS, server bound to 127.0.0.1. Generation covers the five P5 Standard Electrical System outcomes on syllabus page 59; the full 2023 primary science syllabus is loaded for tagging and exclusion screening. This is a generation/review application using existing models, not a trained base model or production LMS.

## Records and versions

A record contains id, title, status, version, createdAt, updatedAt, item, checks, provenance, blindReview, jevReview, reviewEvents and optional labels. Status is draft, approved, changes_requested or rejected. Content edits and academic-label corrections increment the version, clear model reviews and withdraw approval. Events are appended, never rewritten by the UI. Pending metadata is set by the server; model output cannot claim human approval.

Legacy item schema remains supported. `schema-v2.json` adds model_version=science-v2, question_family, title, design, solution_steps and student_question.table; legacy observations must be empty. One to three relevant objective mappings are allowed. `draft-schema.json` defines generated batches; `batch-blind-schema.json` defines independent results keyed by record ID. Rebuild generated schemas with `node scripts/build-schemas.mjs` after changing their definitions.

Five families: material_inference, circuit_prediction, fault_diagnosis, test_design, claim_evaluation. Difficulty is Easy/Medium/Hard and always provisional. Learning-objective IDs are internal labels, not official MOE codes.

V2 open-form items do not receive a legacy Boolean circuit proof. Local checks validate structure, references, tables, options, explanations, syllabus exclusions (precise "not required" terms fail, looser ones warn) and local similarity. An item with `student_question.figure` is solved by `circuit.mjs` against `figure_check`; a disagreeing key, an ambiguous or unmatched option, mislabelled options or a short circuit fail `circuit_logic`. When a source bank is available, `source_similarity` compares the pupil-visible text with the 25 closest bank questions plus any questions in the item's prompt (labels and numbers masked; 60% of the shorter text's word pairs and 15 pairs fail, 35% and 8 pairs warn); without a bank it is not_run. `checks.sourceSimilarity` keeps the closest match. Missing blind review or answer disagreement blocks approval. Other model concerns are warnings for human judgment. A completed model result is attached only to the version it evaluated.

## Teacher API

- GET /api/bootstrap: csrfToken, curriculum, families, providers, records, fixtures, batches (evaluation reports), comparison (retrieval pilot), calibration (pupil responses) and bank (available, label, question count).
- POST /api/batches: provider (codex/gemini/openai), optional blindProvider (defaults to provider), count 1–10, family (balanced or family ID), difficulty (Mixed/Easy/Medium/Hard), optional retrieval (boolean). Returns jobId and batchId. A batch runs generation then blind solving, retains failed slots, usage, durations and initial results. No replay substitution. With retrieval, up to six eligible source questions (one full-text query per family in the plan) go into the generation prompt; the batch stores `retrieval` {enabled, bank, queries, references} and each record's `provenance.retrieval.references` keeps ref, bankId, sourceKey and source. Retrieval without a bank is 409 BANK_UNAVAILABLE; a bank with no eligible question is 409 NO_REFERENCES. Entries keep initialSourceStatus, initialSourceOverlap and initialSourceMatch.
- GET /api/jobs/:id: real stage, job status and final recordId/batchId/recordIds. A completed batch job means its report was saved; inspect batch status and slot errors for generation success.
- GET /api/evaluations and /api/evaluations/:id/export: initial-run outcomes plus current-version human decisions. No human decisions means null acceptance/time, not 0% or 100%. Withdrawn approvals do not count as currently approved. Times are self-reported, not measured. The list also returns `comparison` (finished runs pooled with and without retrieval, including source-overlap counts and reviewer issue codes) and `calibration`.
- GET /api/calibration and /api/calibration/export: per question version, the answers by option, the share who chose the key with a 95% Wilson interval, and from 20 answers a band (Easy ≥80%, Medium ≥50%, Hard below) compared with the label, with flags for a disagreeing label, a distractor chosen more than the key and a distractor chosen by under 5%. The export adds the raw anonymous entries.
- GET /api/bank: bank summary (counts, inputs, flags, levels) or the reason it is unavailable. GET /api/bank/questions: q (≤200 characters), topic, level, flag, limit 1–50, offset. GET /api/bank/questions/:id: one question with document, tags, flags, assets and review events. GET /api/bank/assets/:id: a stored figure image. POST /api/bank/questions/:id/review: target (topic:ID or outcome:ID), action (confirm/reject), reviewer and note; recorded as an event and carried into rebuilds. GET /api/coverage: source and generated-draft counts per syllabus topic and pilot outcome.
- POST /api/generate: legacy single-question generation/replay endpoint; current live UI uses /api/batches. Replay fixtures: original, wrong-answer, missing-assumption, duplicate-options, circuit-brightness, circuit-switch, circuit-wrong-key.
- GET /api/records and /api/records/:id: current records.
- PUT /api/records/:id: version and full item. Resets review state and labels; stale versions are rejected.
- POST /api/records/:id/check: version. Failed checks withdraw approval.
- POST /api/records/:id/blind-review: version and provider. Only student_question and curriculum go to the solver, never the answer or generator rationale.
- POST /api/records/:id/jev-review: version. Optional vendor text assessment, never automatic approval.
- POST /api/records/:id/labels: version, reviewer, note, difficulty, skill, objectives. Requires a reason and valid objective IDs; saves before/after labels and resets review/version.
- POST /api/records/:id/review: version, action, reviewer, note, attestations, optional reviewSeconds and issueCodes. Approving requires zero blocking checks and all four attestations (science/alignment/originality/difficulty).
- GET /api/records/:id/export?format=json|html: complete audit record or printable review sheet.
- GET /api/export: approved current versions with zero blocking checks only.
- GET /api/feedback/export: records with feedback and their event histories. Feedback is not automatically accepted training data.

## Student API

The /practice page does not fetch the teacher bootstrap. GET /api/practice/config returns available filters, counts, curriculum and CSRF. POST /api/practice/start accepts count, difficulty, objective and skill; draws only approved, unblocked current versions; returns fewer items if needed and says how many were available. No answer/explanation is sent initially.

POST /api/practice/:sessionId/submit accepts an answers object keyed by record ID. Every question must have a valid option. Returns marks, explanations, brief solution steps, distractor rationales and suggested objectives. Identical repeated submissions are idempotent; changed resubmissions are rejected. Current approval/version is checked again at submission. A modified/withdrawn question invalidates the session.

Sessions expire after one hour and are held in memory. On the first scored submission of a non-demo session the server appends one anonymous entry (id, at, and per question recordId, recordVersion, selected, keyed, correct) to `responses/records.json`; the result reports `responseSaved`. No names, accounts, device details or free text are collected, and a repeated identical submission is not saved again. Explicit demo=true uses a separately labelled unreviewed example, never creates approved bank entries and is never saved. The student path makes no model calls.

## Operations and safeguards

All mutations require JSON and X-CSRF-Token. Host and supplied Origin are checked. Errors are JSON with an appropriate 4xx/5xx status. Source links are limited to HTTPS; content is escaped. Local teacher/student page separation is not multi-user authentication or authorization.

Records, batches and anonymous responses persist under the configured data directory (`records.json`, `evaluations/`, `responses/`). The source bank is a SQLite file (`question-bank.sqlite` beside the records, or `SIMCC_BANK_DB`) built by `scripts/import-bank.mjs` and opened per request, read-only except for tag reviews; see docs/BANK.md. Interrupted runs are marked on restart with existing evidence retained and no automatic retry. One model job runs at a time; each provider call has a six-minute timeout. Model names and usage may be null when the provider does not report them; never substitute an assumed model name.

The optional recorded demo launcher uses a new isolated directory, imports saved actual evidence as explicitly marked replay, and disables all online providers. No credentials, real bank data or runtime logs belong in the source archive. Existing synthetic question snapshots are allowed and must keep their pending human status.

Run `node --test test/*.test.mjs`. See VALIDATION.md for executed results.
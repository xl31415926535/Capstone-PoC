# Science Studio v2 implementation contract

Node.js >=20, no package dependencies. Vanilla HTML/CSS/JS, server bound to 127.0.0.1. The scope is two P5 Standard electricity objectives. This is a generation/review application using existing models, not a trained base model or production LMS.

## Records and versions

A record contains id, title, status, version, createdAt, updatedAt, item, checks, provenance, blindReview, jevReview, reviewEvents and optional labels. Status is draft, approved, changes_requested or rejected. Content edits and academic-label corrections increment the version, clear model reviews and withdraw approval. Events are appended, never rewritten by the UI. Pending metadata is set by the server; model output cannot claim human approval.

Legacy item schema remains supported. `schema-v2.json` adds model_version=science-v2, question_family, title, design, solution_steps and student_question.table; legacy observations must be empty. One or two relevant objective mappings are allowed. `draft-schema.json` defines generated batches; `batch-blind-schema.json` defines independent results keyed by record ID. Rebuild generated schemas with `node scripts/build-schemas.mjs` after changing their definitions.

Five families: material_inference, circuit_prediction, fault_diagnosis, test_design, claim_evaluation. Difficulty is Easy/Medium/Hard and always provisional. Learning-objective IDs are internal labels, not official MOE codes.

V2 open-form items do not receive a legacy Boolean circuit proof. Local checks validate structure, references, tables, options, explanations and local similarity. Missing blind review or answer disagreement blocks approval. Other model concerns are warnings for human judgment. A completed model result is attached only to the version it evaluated.

## Teacher API

- GET /api/bootstrap: csrfToken, curriculum, families, providers, records, fixtures, batches (evaluation reports).
- POST /api/batches: provider (codex/gemini/openai), count 1–10, family (balanced or family ID), difficulty (Mixed/Easy/Medium/Hard). Returns jobId and batchId. A batch runs generation then blind solving, retains failed slots, usage, durations and initial results. No replay substitution.
- GET /api/jobs/:id: real stage, job status and final recordId/batchId/recordIds. A completed batch job means its report was saved; inspect batch status and slot errors for generation success.
- GET /api/evaluations and /api/evaluations/:id/export: initial-run outcomes plus current-version human decisions. No human decisions means null acceptance/time, not 0% or 100%. Withdrawn approvals do not count as currently approved. Times are self-reported, not measured.
- POST /api/generate: legacy single-question generation/replay endpoint; current live UI uses /api/batches. Replay fixtures: original, wrong-answer, missing-assumption, duplicate-options.
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

Sessions expire after one hour and are held in memory. No student identities or persistent attempt history are collected. Explicit demo=true uses a separately labelled unreviewed example and never creates approved bank entries. The student path makes no model calls.

## Operations and safeguards

All mutations require JSON and X-CSRF-Token. Host and supplied Origin are checked. Errors are JSON with an appropriate 4xx/5xx status. Source links are limited to HTTPS; content is escaped. Local teacher/student page separation is not multi-user authentication or authorization.

Records and batches persist under the configured data directory. Interrupted runs are marked on restart with existing evidence retained and no automatic retry. One model job runs at a time; each provider call has a six-minute timeout. Model names and usage may be null when the provider does not report them; never substitute an assumed model name.

The optional recorded demo launcher uses a new isolated directory, imports saved actual evidence as explicitly marked replay, and disables all online providers. No credentials, real bank data or runtime logs belong in the source archive. Existing synthetic question snapshots are allowed and must keep their pending human status.

Run `node --test test/*.test.mjs`. See VALIDATION.md for executed results and the unresolved v2 browser visual/click verification limitation.
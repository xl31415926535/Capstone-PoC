# Pilots

Two pilots are built into the app. Neither has run with real teachers or pupils yet; this page says how to run them and how to read the results.

## 1. Retrieval pilot

**Question.** Do drafts get better when the generator sees real source questions as examples, and do they stay original?

**What changes between the two conditions.** With retrieval on, the generation prompt also carries up to six P5 electricity questions from the source bank, chosen by one full-text query per reasoning family in the plan. The prompt tells the model to use them only for reading level, the kind of reasoning P5 papers reward and the misconceptions their wrong options target, and never to reuse their wording, scenario, labels, numbers, options or diagram. Everything else (plan, curriculum, checks, blind solve) is the same. Every draft is compared with the bank in both conditions.

**Run it.**

```bash
# See what retrieval would add, without calling a model
node scripts/retrieval-pilot.mjs --dry-run --bank data/question-bank.sqlite --count 10

# Paired live runs through a running server (one model job at a time)
node server.mjs
node scripts/retrieval-pilot.mjs --provider codex --pairs 3 --count 5
```

A live run alternates the order (without then with, then with then without) so that time of day or quota drift does not favour one condition. Add `--blind-provider gemini` (or `openai`) to send the blind solve to a different provider. The script prints the comparison for its own runs and saves a report under `runtime/`. You can also tick **Show the generator matching source questions** in Studio for a single run.

**Measures**, pooled by condition on the Evaluation page:

| Measure | Read it as |
| --- | --- |
| Local rules passed | Structure, scope and circuit checks. Not scientific proof. |
| Blind answer agreement | Another model call reached the same key. Stronger with a different provider. |
| Human acceptance and review time | The main outcome. Pending until reviewers decide on every draft. |
| Reviewer issue codes | Especially "superficial rewrite" and "scientific error". |
| Overlap with source questions | Mean overlap, drafts close to a source (35% or more) and drafts blocked as near copies (60% or more). |

**Reading the result.** Retrieval helps only if acceptance rises (or review time falls) without more drafts close to their sources or flagged as superficial rewrites. With a few runs of five questions each, treat differences as leads for teacher review, not findings; review every draft in both conditions so acceptance compares like with like.

**Current limit.** The private bank built on 7 October 2026 has 4 eligible P5 electricity examples, so a run sees almost the same examples whatever the plan. About 30 more P5 questions (school prelims or past papers, typed into a curated file with figures) would make the pilot meaningful.

## 2. Teacher review and pupil practice

**Question.** Are generated questions acceptable to a teacher, and is their difficulty label right for pupils?

**Steps.**

1. Generate review sets in Studio (or with the pilot script).
2. A teacher reviews each draft: approve, request changes or reject, with a note, the issues found and the active minutes spent. Approval needs all four confirmations and no blocking check.
3. Approved questions appear on the practice page (`/practice`). Pupils answer them; nobody signs in.
4. For each approved question version the server keeps the option each pupil chose and whether it was the key. No names, accounts or device details are stored, and answers to the unreviewed demo are not kept.
5. Once a version has 20 answers, the Evaluation page and the question's evidence show a difficulty band: Easy when 80% or more chose the key, Medium from 50%, Hard below. A band that disagrees with the label, a wrong option chosen more often than the key, or a wrong option almost nobody chose, is flagged for the teacher.
6. The teacher corrects the label in **Academic labels & corrections** if the evidence supports it. That creates a new version, which needs a fresh blind solve and approval and starts its own count of answers.

**Exports.** Evaluation reports, reviewer feedback and the anonymous pupil responses (`/api/calibration/export`) can be downloaded for analysis.

**Before running with pupils.** Agree the pilot with the school and follow its consent rules. Twenty answers per question is a minimum for a rough band; the 95% interval shown next to each share says how uncertain it still is.

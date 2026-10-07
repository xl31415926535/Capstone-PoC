# Source question bank

The source bank is a SQLite file of real questions from past papers and olympiads. Science Studio uses it in four places:

- the **Source bank** page, to search questions, see their figures and confirm or reject syllabus tags;
- the **Syllabus coverage** page, to count source questions and generated drafts for each 2023 syllabus topic and each P5 electricity outcome;
- the **source-overlap check**, which compares every draft with the bank and blocks near copies;
- the **retrieval pilot**, which can show the generator matching source questions as examples (see [PILOT.md](PILOT.md)).

The bank needs Node.js 22.5 or later (built-in `node:sqlite`). On older versions those pages say so and the rest of the app works as before.

## Build it

```bash
# Constructed sample (9 questions written by the team, not real papers)
npm run bank:sample

# Utkarsh's olympiad database plus curated sources
node scripts/import-bank.mjs --olympiad olympiad_poc.sqlite --sources bank/sources --output data/question-bank.sqlite --label "Private source bank"
```

- `--olympiad` takes a SQLite file with Utkarsh's `source_documents` and `questions` tables. Repeat it for several files.
- `--sources` takes a curated JSON file or a folder of them (format below). Repeat it for several.
- `--output` defaults to `data/question-bank.sqlite`, which is where the server looks. Set `SIMCC_BANK_DB` to use another file.
- `--no-carry` starts without the reviewer decisions held in the existing output file.

The file is rebuilt from scratch on every run and written to a temporary file first, so a failed import leaves the old bank in place. The server opens the bank per request, so a rebuilt bank is used at once without a restart.

The recorded demo builds the constructed sample into its own demo folder.

**Keep real papers and the built file out of Git.** `data/` and `runtime/` are ignored. The repository is public, and third-party papers are for this private PoC only.

## Compatibility with the olympiad database

Utkarsh's two tables are created with the same columns, so his practice query runs on the bank unchanged:

- olympiad document and question ids are kept;
- the enrichment columns (`explanation`, `subject`, `topic`, `subtopic`, `skill`, `difficulty`, `answer_source`, `depends_on_image`, `is_complete`) are copied only when the input has them;
- raw rows are never marked complete, so the practice UI only shows rows his enrichment step completed;
- curated rows use ids from 10000 (documents) and 100000 (questions), so they never collide with olympiad ids.

Everything Science Studio adds lives in its own tables: syllabus topics, outcomes and "not required" notes, a profile per question (origin, grade range, level band, page), syllabus tags, figures, quality flags, reviewer decisions and a full-text index.

## Curated sources

Use a curated file for questions typed in from a paper, for example a school prelim paper. `examples/bank-sample/sample-sources.json` is a complete example.

```json
{
  "format": "simcc-source-bank/1",
  "label": "Private source bank",
  "notice": "Who may use this data and how.",
  "documents": [{
    "key": "acs-junior-2025-p6-prelim",
    "provider": "Anglo-Chinese School (Junior)",
    "competition": "P6 Science Preliminary Examination 2025",
    "grade": 6, "grade_scope": "P6",
    "landing_url": "https://…", "download_url": "https://…",
    "local_path": "papers/acs-2025.pdf", "file": "papers/acs-2025.pdf",
    "page_count": 40, "extracted_at": "2026-10-07",
    "attribution": "Transcribed by the project team from …",
    "questions": [{
      "number": 18,
      "stem": "The diagram shows four circuits …",
      "options": { "1": "A", "2": "B", "3": "C", "4": "D" },
      "correct_option": "1", "answer_source": "official_key",
      "topics": [{ "id": "P5-SYSTEMS-ELECTRICAL", "evidence": "Compares bulb brightness." }],
      "outcomes": [{ "id": "P5-SYSTEMS-ELECTRICAL-S-P2", "evidence": "Bulbs and batteries in series and parallel." }],
      "assets": [{ "kind": "figure_image", "file": "figures/acs-q18.png", "page": 12, "note": "Cropped from page 12." }]
    }]
  }]
}
```

- `sha256` is computed from `file` when it is given; otherwise give `sha256` yourself.
- Links must be https. Question numbers must be unique within a document.
- Topic and outcome ids must exist in the 2023 syllabus (`syllabus/primary-science-2023.json`). A curated tag is a draft until a reviewer confirms it, unless you set `"status": "confirmed"`.
- `answer_source` is `official_key`, `author_key` or `inferred`.
- An asset is either a `figure_image` (PNG, JPEG or WebP, stored in the bank) or a `circuit_figure`: the same panel structure the generator uses, with a `check` saying what each option claims. The importer solves the circuit and records whether the solver agrees with the key. ACS Q18 is solved to its official key this way.

## Syllabus tags

A curated question carries the tags written in its file; any other question gets up to three keyword suggestions. Every tag records where it came from:

| Method | Status | Meaning |
| --- | --- | --- |
| keyword | suggested | Matched topic cue words. A suggestion only. |
| curated | draft or confirmed | Written in the curated file by the team. |
| reviewer | confirmed or rejected | A reviewer's decision on the Source bank page, with name and reason. |

Reviewer decisions are stored as events and carried into the next build by source key (the document hash or key plus the question number). A decision for a question that is no longer in the inputs is dropped, and the import summary counts it. A rejected tag leaves the coverage counts and the retrieval pool.

## Quality flags

| Flag | Severity | Raised when |
| --- | --- | --- |
| `no_answer` | warning | The source gives no key. |
| `answer_not_in_options` | warning | The key is not one of the extracted options. |
| `few_options` | warning | Fewer than three options have text. |
| `option_noise` | warning | An option is blank, very long, or holds a page header, footer or merged option. |
| `garbled_text` | warning | Broken letter spacing or maths glyphs from PDF extraction. |
| `may_depend_on_image` | warning, or note when a figure is stored | The stem mentions a figure, table or picture. |
| `excluded_content` | note | Wording the 2023 syllabus marks "not required", or that the pilot leaves out. |

## How generation uses the bank

**Overlap check.** Each draft is compared with the 25 bank questions that share the most words with it, plus any questions that were in its prompt. Labels (A, S1) and numbers are masked, so renaming bulbs or changing values does not hide a copy. The score is the share of the shorter text's word pairs that the other repeats. 60% or more (and at least 15 shared pairs) blocks approval; 35% or more (and at least 8 pairs) is a warning. On the project bank, renamed or reordered copies of the 12 real electricity questions scored 0.89 to 1.0, and the recorded example questions at most 0.16 against any bank question. Overlap cannot catch a copied idea written in new words, so the reviewer's originality confirmation still matters.

**Retrieval.** A question is eligible as an example when it is tagged to P5 Electrical System (not rejected), is not secondary level, and has none of `garbled_text`, `option_noise`, `few_options`, `answer_not_in_options` or `excluded_content`. On 7 October 2026 the private bank had 12 questions tagged to the topic and 4 eligible examples, so more P5 papers would make retrieval far more useful.

## Limitations

- Keyword tags and flags are heuristics; a teacher should confirm the tags that matter.
- Olympiad papers come from several syllabuses. Level bands use the grade range, not the Singapore syllabus.
- Figures exist only where the team cropped or described them; most olympiad questions that need a figure are flagged instead.

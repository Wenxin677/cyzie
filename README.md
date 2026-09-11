# Cyzie

Cyzie is a study companion that reads your lecture slides and teaches them back to you —
one page at a time, with questions, and with answers to whatever you ask.

Upload a `.pptx`, `.pdf`, `.docx`, `.txt` or `.md` file. Cyzie reads every slide, then for each one:

1. **Teaches it** — the slide's own points, in a short readable block, with speaker notes if the deck has them.
2. **Asks you about it** — multiple choice, fill-in-the-blank, true/false, open recall and "which of these is not on this slide", generated from that slide's text.
3. **Marks your answer** — with partial credit, the missing ideas named, the slide line quoted back, and one retry before it reveals the answer.
4. **Moves on** — slide summary, score, then the next page. At the end: what you were strong at, what to revisit, and a downloadable study sheet.

You can interrupt at any time — Cyzie answers questions without losing your place in the lesson.

## The home screen

Opening Cyzie shows an agent-style landing page rather than an empty box: a greeting that follows
the clock, one drop target, and three suggested openings. Drag a file anywhere onto the window, or
click the drop zone. Clicking the mark in the top-left always returns here.

## What a lesson looks like

Each taught slide arrives as a card in the conversation, not a wall of text:

- **The slide itself** — for a PDF, the real rendered page image; for PowerPoint and Word, the
  slide's points with its bullet levels, plus speaker notes if it has them.
- **Code blocks** — syntax highlighted, with a copy button, and read line by line on request.
- **Questions** — with the options as buttons, a hint, and the slide line quoted when you answer.
- **The context panel** — where you are in the deck, the slide's key terms, question dots for the
  current slide, and the slide strip for jumping around.

## What it understands

| You type | Cyzie does |
|---|---|
| `next` · `back` · `repeat` | move between slides |
| `hint` · `show answer` · `skip` | help when a question is not coming |
| `go to slide 7` | jump anywhere in the deck |
| `what is machine learning?` | answers from the deck, citing the slide |
| `where is ethics mentioned?` | finds the pages that cover it |
| `explain that simpler` · `give me an example` | slows down and unpacks the current slide |
| `explain this code` | walks a code block line by line |
| `code task` | sets coding drills: predict output, fill the keyword, spot the bug, write the line from memory |
| `summary` · `progress` · `glossary` | the bigger picture, and every definition Cyzie mined |
| `agenda` · `objectives` | what the deck says it covers, and how you did against it |
| `quiz me` · `quiz me on my misses` | extra questions, weighted to what you got wrong |
| `study sheet` | downloads a markdown revision sheet (glossary + slide notes + missed questions) |
| `help` | the full list |

## What it reads

Anything a lecturer puts on a slide, including the structure of the deck itself:

- **Deck structure** — the cover, agenda, objectives, section dividers, exercises, recaps,
  references and closing slides are recognised and treated differently. Cyzie announces the
  roadmap, checks the stated learning objectives at the end, and never quizzes you on a
  contents slide.
- **Coding slides** — code blocks are detected and language-tagged (Python, Java, JavaScript,
  C, C++, C#, SQL, HTML, CSS, Shell), syntax highlighted, read line by line, and turned into
  coding questions. Simple counter loops are even evaluated, so "what does this print?" has a
  real answer — worked out from the slide's own code, never guessed.
- **Speaker notes** — PowerPoint notes are quoted alongside the slide.
- **Images** — picture-only slides are called out as such rather than quizzed.

## Privacy and security

- **Nothing leaves the device.** Files are parsed locally, lessons and progress live in your
  browser's IndexedDB, and there is no server, account, API key or analytics. The page ships a
  `Content-Security-Policy` with `default-src 'none'` and `connect-src 'none'`, so the browser
  itself blocks any attempt to phone home — and the self-test asserts that zero external
  resources are requested.
- **Untrusted input is treated as untrusted.** Slide text is escaped before it reaches the DOM
  (a script tag inside a slide renders as text), archives are size-capped against decompression
  bombs, XML entity/encoding attacks are ignored rather than evaluated (there is no DTD or
  external entity handling at all), file types are whitelisted, and every parser runs under
  explicit memory and length limits.
- **No eval.** pdf.js is configured with `isEvalSupported: false`.

## How it works (no AI service involved)

Cyzie is a small offline engine, all of it in `docs/js/`:

| File | Job |
|---|---|
| `parse-pdf.js` | pdf.js text extraction, line reconstruction, heading/bullet detection, cached page rendering |
| `zip.js` + `parse-pptx.js` | its own ZIP reader (via `DecompressionStream`) and OOXML scanner for `.pptx`/`.docx`, including SmartArt and speaker notes |
| `parse-text.js` | markdown/plain text, section by heading |
| `code.js` | language detection, code-block extraction, syntax highlighting, line-by-line reading, a narrow output simulator |
| `deck-intel.js` | what each slide is FOR: cover, agenda, objectives, section, content, code, exercise, recap, closing; plus the roadmap and objectives tracking |
| `extract.js` | mines terms, definitions, lists and facts from each page |
| `questions.js` | builds the question set per slide (cloze, MCQ, true/false, open recall, code prediction/blank/bug/recall) |
| `grade.js` | marks free-text, code and sequence answers with partial credit |
| `retrieve.js` | BM25 search over the deck so "what is X?" lands on the right slide |
| `tutor.js` | the conversation: intents, lesson flow, feedback voice |
| `limits.js` | the hard caps that keep a hostile or huge file from freezing the tab |

Because there is no language model, Cyzie never invents content: every sentence it says comes from
your file. When a question is not covered by the deck, it says so instead of guessing.

## Running it

Live: **https://wenxin677.github.io/cyzie/**

Or locally:

```bash
cd docs
python -m http.server 8000     # then open http://localhost:8000
```

(`serve.bat` does the same on Windows.) Opening `docs/index.html` straight from disk will not work —
browsers block ES modules and PDF workers on `file://`.

## Tests

```bash
# engine checks (parsers, extraction, question generation, grading, retrieval, tutor flow)
node tools/dev/checks.mjs docs/tests/fixtures/sample.pptx docs/tests/fixtures/sample.pdf \
  docs/tests/fixtures/code-java.md docs/tests/fixtures/code-python.md docs/tests/fixtures/sample-notes.md

# browser harnesses, headless, reported to disk
node tools/dev/harness-server.mjs 8131 &
node tools/dev/headless-run.mjs "http://127.0.0.1:8131/tests/selftest.html" selftest 300
node tools/dev/headless-run.mjs "http://127.0.0.1:8131/tests/fuzz.html?light=1" fuzz-final 600
```

`tests/selftest.html` drives the real app in an iframe: uploads `.pptx`, `.pdf` and markdown decks,
answers questions by clicking options, runs every command, exports a study sheet, checks the home
screen and the animated layout, and measures 390 px and 1280 px. `tests/fuzz.html` is the hostile
side: renamed and truncated files, empty archives, a zip bomb, XSS payloads in slide text, emoji,
bad settings, a 30-slide deck, storage blocked, and deleting the open lesson. Both post their results
to `tools/dev/harness-server.mjs`, which writes `tools/dev/reports/*.json`.

`tests/diag.html` is the module-load and upload diagnostic, `tests/diag-narrow.html` the narrow
viewport one, and `tests/reset.html` wipes everything Cyzie stored in the current browser profile.

Fixtures in `docs/tests/fixtures/` are generated by `tools/dev/make-fixtures.mjs` and
`tools/dev/make-pdf-fixture.mjs`, so nothing private is ever published.

## Credit

Built by Sok Panha with AI assistance.

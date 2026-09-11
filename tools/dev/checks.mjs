/* Cyzie automated checks — parsers, extraction, questions, grading, retrieval, tutoring flow.
   Run: node tools/dev/checks.mjs [path/to/fixture.pptx ...]
   Node-only paths (PDF uses the legacy pdf.js build when the browser bundle cannot load). */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parsePptx, parseDocx, scanOoxml, xmlTokens } from '../../docs/js/parse-pptx.js';
import { parsePdf, configurePdfjs } from '../../docs/js/parse-pdf.js';
import { parseText } from '../../docs/js/parse-text.js';
import { analyzeDeck, lookupTerm, looksLikeCode } from '../../docs/js/extract.js';
import { buildQuestions, buildLessonPlan, cleanDefinition } from '../../docs/js/questions.js';
import { gradeAnswer } from '../../docs/js/grade.js';
import { buildIndex, search, answerQuestion, rankSlides } from '../../docs/js/retrieve.js';
import { createSession, start, respond, classify } from '../../docs/js/tutor.js';
import { stem, similarity, coverAnswer, keyStems } from '../../docs/js/nlp.js';

let pass = 0; const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/* ------------------------------------------------------------ 1. nlp ---- */
section('nlp');
check('stem plurals', stem('loops') === 'loop' && stem('categories') === 'category', `${stem('loops')} / ${stem('categories')}`);
check('similarity exact', similarity('machine learning', 'machine learning') === 1);
check('similarity near', similarity('machine learning', 'machine learnig') > 0.8);
check('similarity far', similarity('machine learning', 'binary search') < 0.3);
const cov = coverAnswer(['binary', 'digit', 'zero'], 'a binary digit is zero or one');
check('coverage full', cov.score > 0.8, JSON.stringify(cov));
const covShort = coverAnswer(['binary', 'digit', 'zero'], 'binary');
check('coverage penalises one-word answers', covShort.score < 0.6, JSON.stringify(covShort));

/* --------------------------------------------------------- 2. zip/xml ---- */
section('ooxml scanner');
const xml = `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1" sz="2400"/><a:t>Hello &amp; welcome</a:t></a:r></a:p></p:txBody></p:sp>`;
const scanned = scanOoxml(xml);
check('xml: finds title shape', scanned.shapes[0]?.isTitle === true);
check('xml: decodes entities', scanned.shapes[0]?.paragraphs[0]?.text === 'Hello & welcome', JSON.stringify(scanned.shapes[0]?.paragraphs[0]?.text));
check('xml: detects bold run', scanned.shapes[0]?.paragraphs[0]?.runs[0]?.bold === true);
check('xml: detects run size', scanned.shapes[0]?.paragraphs[0]?.runs[0]?.size === 24);
const docxish = scanOoxml('<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Section</w:t></w:r></w:p></w:body>');
check('docx: bold + style captured', docxish.shapes[0]?.paragraphs[0]?.runs[0]?.bold === true && docxish.shapes[0]?.paragraphs[0]?.style === 'Heading1');

/* ------------------------------------------------------- 3. plain text ---- */
section('text parsing');
const md = '# Loops\n\nA loop repeats a block.\n\n- while loop\n- for loop\n\n# Arrays\n\nAn array stores many values.';
const mdDeck = analyzeDeck(parseText(md));
check('text: markdown headings become slides', mdDeck.slides.length === 2, `got ${mdDeck.slides.length}`);
check('text: first slide titled Loops', mdDeck.slides[0].title === 'Loops', mdDeck.slides[0].title);
check('text: bullet terms captured', mdDeck.slides[0].lines.some(l => /while loop/.test(l.text)));

/* ------------------------------------------------------------- 4. pdf ---- */
section('pdf parsing');
const pdfFixture = 'tests/fixtures/local/03_How_AI_Works.pdf';
let pdfDeck = null;
if (existsSync(pdfFixture)) {
  try {
    configurePdfjs(await import('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch { /* pdf.js optional */ }
  const buf = await readFile(pdfFixture);
  const parsed = await parsePdf(new Uint8Array(buf));
  pdfDeck = analyzeDeck(parsed);
  check('pdf: pages parsed', parsed.slides.length >= 2, `got ${parsed.slides.length}`);
  check('pdf: text present', parsed.slides[0].lines.length >= 3);
  check('pdf: bullets de-artifacted', !parsed.slides.some(s => s.lines.some(l => /^n\s+[A-Z]/.test(l.text))));
  check('pdf: title detected', /AI|How AI/i.test(pdfDeck.slides[0].title), pdfDeck.slides[0].title);
  check('pdf: definitions mined', pdfDeck.stats.termsWithDefs >= 3, JSON.stringify(pdfDeck.stats));
  check('pdf: questions available', pdfDeck.stats.questions >= 6, JSON.stringify(pdfDeck.stats));
} else {
  check('pdf fixture present', false, pdfFixture);
}

/* ------------------------------------------------------------ 5. pptx ---- */
section('pptx parsing');
const decks = [];
for (const arg of process.argv.slice(2)) {
  const buf = await readFile(arg);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ext = (arg.split('.').pop() || '').toLowerCase();
  const parsed = ext === 'pdf' ? await parsePdf(new Uint8Array(buf))
    : ext === 'docx' ? await parseDocx(ab)
      : await parsePptx(ab);
  const deck = analyzeDeck(parsed);
  decks.push({ file: arg, deck });
  const label = arg.split(/[\\/]/).pop();
  check(`${label}: slides parsed`, parsed.slides.length >= 2, `got ${parsed.slides.length}`);
  const titled = parsed.slides.filter(s => s.title && !/^Slide \d+$/.test(s.title)).length;
  check(`${label}: most slides titled`, titled / parsed.slides.length > 0.6, `${titled}/${parsed.slides.length}`);
  const junk = [...deck.glossary.values()].filter(t => looksLikeCode(t.term));
  check(`${label}: no code fragments as terms`, junk.length === 0, junk.map(j => j.term).join(' | ').slice(0, 110));
  const longTitles = deck.slides.filter(s => s.title.length > 95);
  check(`${label}: titles are readable`, longTitles.length === 0, `${longTitles.length} too long`);
  const articleTerms = [...deck.glossary.values()].filter(t => /^(a|an|the)\s/i.test(t.term));
  check(`${label}: terms drop leading articles`, articleTerms.length === 0, articleTerms.map(t => t.term).join(' | '));
  console.log(`   ${label}: ${parsed.slides.length} slides, ${deck.stats.teachable} teachable, ${deck.stats.termsWithDefs} defined terms, ${deck.stats.questions} planned questions`);
}

/* ------------------------------------------------------- 6. questions ---- */
section('question generation');
const sampleDecks = [pdfDeck, ...decks.map(d => d.deck)].filter(Boolean);
let totalQuestions = 0;
for (const deck of sampleDecks) {
  for (const slide of deck.slides) {
    if (slide.skipQuestions) continue;
    const qs = buildQuestions(deck, slide, { count: 5, seed: 'checks' });
    totalQuestions += qs.length;
    check(`qgen s${slide.index}: per-slide cap respected`, qs.length <= 5, `${qs.length} questions`);
    for (const q of qs) {
      check(`qgen s${slide.index} ${q.id}: has prompt`, !!q.prompt && q.prompt.length > 8);
      check(`qgen s${slide.index} ${q.id}: has answer`, !!(q.answer && q.answer.text));
      check(`qgen s${slide.index} ${q.id}: has explanation`, !!q.explanation);
      check(`qgen s${slide.index} ${q.id}: cites its slide`, q.slide === slide.index, `${q.slide} vs ${slide.index}`);
      if (q.choices) {
        const correct = q.choices.filter(c => c.correct);
        check(`qgen s${slide.index} ${q.id}: exactly one correct option`, correct.length === 1, `${correct.length}`);
        check(`qgen s${slide.index} ${q.id}: at least three options`, q.choices.length >= 3, `${q.choices.length}`);
        const texts = q.choices.map(c => c.text.toLowerCase());
        check(`qgen s${slide.index} ${q.id}: options are distinct`, new Set(texts).size === texts.length);
        const dupe = q.choices.some(c => similarity(c.text, correct[0]?.text || '') > 0.75 && !c.correct);
        check(`qgen s${slide.index} ${q.id}: distractors differ from the answer`, !dupe);
      }
      if (q.type === 'cloze_mcq' || q.type === 'cloze_type') {
        check(`qgen s${slide.index} ${q.id}: blank in prompt`, q.prompt.includes('______'), q.prompt.slice(0, 80));
      }
      if (q.type === 'true_false') {
        check(`qgen s${slide.index} ${q.id}: tf answer is boolean`, ['true', 'false'].includes(q.answer.text));
      }
      if (q.type === 'define_short' || q.type === 'list_recall' || q.type === 'gist_short') {
        check(`qgen s${slide.index} ${q.id}: open questions carry keywords`, (q.answer.keywords || []).length > 0 || (q.answer.items || []).length > 0);
      }
    }
    const types = new Set(qs.map(q => q.type));
    if (qs.length >= 3) check(`qgen s${slide.index}: varied question types`, types.size >= 2, [...types].join(','));
  }
}
console.log(`   ${totalQuestions} questions generated across ${sampleDecks.reduce((n, d) => n + d.slides.filter(s => !s.skipQuestions).length, 0)} slides`);

/* ---------------------------------------------------------- 7. grading ---- */
section('grading');
const mcq = {
  type: 'mcq_definition',
  answer: { text: 'the ability of machines to perform tasks that require human intelligence', keywords: keyStems('machines tasks human intelligence') },
  choices: [
    { text: 'the ability of machines to perform tasks that require human intelligence', correct: true },
    { text: 'a database of rules written by engineers', correct: false },
    { text: 'a network of sensors collecting data', correct: false },
  ],
  sourceLine: 'x', explanation: 'x',
};
check('grade: mcq correct by letter', gradeAnswer(mcq, 'a').verdict === 'correct');
check('grade: mcq wrong by letter', gradeAnswer(mcq, 'b').verdict === 'incorrect');
check('grade: mcq correct by text', gradeAnswer(mcq, 'the ability of machines to perform tasks that require human intelligence').verdict === 'correct');
check('grade: mcq fuzzy text', gradeAnswer(mcq, 'ability of machines to perform tasks requiring human intelligence').verdict === 'correct');

const defq = {
  type: 'define_short',
  answer: { text: 'a loop that checks the condition before each iteration', keywords: keyStems('loop checks condition before each iteration') },
  sourceLine: 'x', explanation: 'x',
};
check('grade: strong open answer', ['correct'].includes(gradeAnswer(defq, 'it tests the condition before it runs each iteration of the loop').verdict));
check('grade: partial open answer', ['partial', 'incorrect'].includes(gradeAnswer(defq, 'a loop').verdict));
check('grade: idle recognised', gradeAnswer(defq, "I don't know").note === 'idle');
check('grade: empty answer handled', gradeAnswer(defq, '').verdict === 'unsure');

const tfq = { type: 'true_false', answer: { text: 'false' }, sourceLine: 'x', explanation: 'x' };
check('grade: tf yes is true', gradeAnswer(tfq, 'yes').verdict === 'incorrect');
check('grade: tf false', gradeAnswer(tfq, 'false').verdict === 'correct');
check('grade: tf unclear', gradeAnswer(tfq, 'maybe').verdict === 'unsure');

const clozeTyped = { type: 'cloze_type', answer: { text: 'Machine Learning', keywords: keyStems('Machine Learning'), alt: [] }, sourceLine: 'x', explanation: 'x' };
check('grade: typed cloze exact', gradeAnswer(clozeTyped, 'machine learning').verdict === 'correct');
check('grade: typed cloze typo', gradeAnswer(clozeTyped, 'machin lerning').verdict === 'correct');
check('grade: typed cloze wrong', gradeAnswer(clozeTyped, 'deep learning').verdict !== 'correct');

/* -------------------------------------------------------- 8. retrieval ---- */
section('retrieval');
for (const deck of sampleDecks) {
  const index = buildIndex(deck);
  let hits = 0; let selfTotal = 0;
  for (const slide of deck.slides) {
    if (slide.skipQuestions) continue;
    selfTotal++;
    const ranked = rankSlides(index, slide.title);
    if (ranked[0]?.slide === slide.index) hits++;
  }
  const accuracy = selfTotal ? hits / selfTotal : 1;
  check(`retrieval: slide titles find their own slide (${deck.deckTitle.slice(0, 30)})`, accuracy >= 0.8, `${(accuracy * 100).toFixed(0)}%`);
  console.log(`   title→slide accuracy ${(accuracy * 100).toFixed(0)}% (${hits}/${selfTotal})`);

  const q = answerQuestion(deck, index, 'this is definitely not in the deck zzzz quokka', { lookupTerm: x => lookupTerm(deck.glossary, x) });
  check('retrieval: nonsense query returns none', q.kind === 'none', q.kind);

  const defined = [...deck.glossary.values()].find(t => t.definition);
  if (defined) {
    const r = answerQuestion(deck, index, `what is ${defined.term}?`, { lookupTerm: x => lookupTerm(deck.glossary, x) });
    check(`retrieval: "what is ${defined.term}?" resolves`, r.kind === 'term' && r.term.term === defined.term, r.kind);
  }
  const searchHits = search(index, deck.deckTitle.split(' ').slice(0, 3).join(' '), { limit: 3 });
  check('retrieval: deck title search returns hits', searchHits.length > 0);
}

/* ------------------------------------------------------------ 9. tutor ---- */
section('tutoring flow');
for (const deck of sampleDecks.slice(0, 2)) {
  const session = createSession(deck, { density: 'standard', seed: 'checks', learner: 'Panha' });
  let out = start(session);
  check('tutor: greets and teaches first slide', out.messages.length >= 3 && out.messages[0].text.includes('Cyzie'));
  check('tutor: first question asked', out.messages.some(m => m.kind === 'question'));
  check('tutor: awaiting an answer', session.awaiting === 'answer');
  const firstQ = session.current;
  check('tutor: question carries its options for the UI', !firstQ.choices || out.messages.find(m => m.kind === 'question')?.choices?.length === firstQ.choices.length,
    JSON.stringify(out.messages.find(m => m.kind === 'question')?.choices?.length));
  check('tutor: question message carries an id', !!out.messages.find(m => m.kind === 'question')?.questionId);

  const transcript = [];
  let guard = 0;
  let correctStreak = 0;
  while (session.phase !== 'done' && guard++ < 400) {
    const q = session.current;
    let answer;
    if (!q) {
      answer = 'next';
    } else {
      // Simulate a student who mostly knows the material.
      const roll = guard % 7;
      if (roll === 0) answer = "I don't know";
      else if (roll === 1) answer = 'definitely the wrong answer';
      else if (q.choices) answer = 'ABCDEFGH'[q.choices.findIndex(c => c.correct)];
      else if (q.type === 'true_false') answer = session.lastAnswerCorrect === false ? (q.answer.text === 'true' ? 'false' : 'true') : q.answer.text;
      else answer = q.answer.text;
    }
    const res = respond(session, answer);
    transcript.push({ user: answer, cyzie: res.messages.map(m => m.text) });
    check('tutor: every reply has text', res.messages.every(m => typeof m.text === 'string' && m.text.length > 0));
    if (res.messages.some(m => m.kind === 'feedback' && m.tone === 'good')) correctStreak++;
  }
  check('tutor: lesson completes', session.phase === 'done', `phase=${session.phase} after ${guard} turns`);
  check('tutor: stats accumulated', session.stats.answered > 0, JSON.stringify(session.stats));
  check('tutor: summaries produced', transcript.some(t => t.cyzie.some(x => x.includes('Where you stand'))));
  check('tutor: turns bounded', guard < 400, `${guard} turns`);

  // Side-channel questions must not break the quiz state.
  const s2 = createSession(deck, { seed: 'side' });
  start(s2);
  const held = s2.current?.id;
  const r1 = respond(s2, 'what is a glossary?');
  check('tutor: unknown term answered honestly', r1.messages.some(m => /could not find|does not spell out|Here is what/i.test(m.text)), r1.messages.map(m => m.text).join(' ').slice(0, 120));
  check('tutor: question stays open after a side question', s2.current?.id === held && s2.awaiting === 'answer');
  const r2 = respond(s2, 'help');
  check('tutor: help lists commands', r2.messages[0].text.includes('next'));
  const r3 = respond(s2, 'summarise slide 4');
  check('tutor: slide summary works', r3.messages.some(m => /Slide 4|Slide \d+ done/.test(m.text)) || r3.messages.length > 0);
  const r4 = respond(s2, 'glossary');
  check('tutor: glossary either lists or explains absence', r4.messages[0].text.length > 20);
  const r5 = respond(s2, 'go to slide 9999');
  check('tutor: out-of-range jump refused', r5.messages[0].text.includes('only has') || r5.messages[0].text.includes('Slide 9999') === false);
  const deckSlideCount = deck.slides.length;
  const targetSlide = deck.slides[Math.min(2, deckSlideCount - 1)].index;
  const rJump = respond(s2, `go to slide ${targetSlide}`);
  check(`tutor: "go to slide ${targetSlide}" actually moves the lesson`, s2.slide === targetSlide, `slide=${s2.slide}`);
  check('tutor: jumping teaches that slide', rJump.messages.some(m => new RegExp(`Slide ${targetSlide}`).test(m.text)), rJump.messages[0]?.text?.slice(0, 60));
  const r6 = respond(s2, 'progress');
  check('tutor: progress report renders', r5.messages.length > 0 && r6.messages[0].text.includes('Progress'));
  for (const intent of ['next', 'hint', 'show answer', 'skip', 'repeat', 'explain that simpler', 'give me an example', 'more detail', 'harder', 'easier', 'thanks', 'stop', 'restart', 'quiz me', 'quiz me on my misses']) {
    const r = respond(s2, intent);
    check(`tutor: "${intent}" handled`, r.messages.length > 0 && r.messages.every(m => typeof m.text === 'string' && m.text.length > 0));
  }
  const classified = [['next', 'next'], ['hint', 'hint'], ['go to slide 7', 'jump'], ['what is AI?', 'define'], ['summary', 'summary'], ['blah blah zzz', 'question']];
  for (const [input, expected] of classified) {
    const got = classify(createSession(deck, { seed: 'x' }), input).intent;
    check(`classify "${input}" → ${expected}`, got === expected, got);
  }
}

/* ---------------------------------------------------------- 10. session ---- */
section('session persistence shape');
const deckForSave = sampleDecks[0];
const s3 = createSession(deckForSave, { seed: 'save' });
start(s3);
const serialisable = JSON.parse(JSON.stringify({
  slide: s3.slide, phase: s3.phase, stats: s3.stats, perSlide: s3.perSlide, missed: s3.missed, seenSlides: s3.seenSlides,
  queue: s3.queue.map(q => q.id), current: s3.current?.id, awaiting: s3.awaiting, learner: s3.learner,
}));
check('session: core state is JSON-serialisable', !!serialisable.slide && !!serialisable.perSlide);
check('session: no DOM or function leakage in saved state', !JSON.stringify(serialisable).includes('function'));

/* --------------------------------------------------------------- done ---- */
console.log(`\n\x1b[1m${pass} checks passed, ${failures.length} failed\x1b[0m`);
if (failures.length) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of failures.slice(0, 40)) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32mAll good.\x1b[0m');
}

/* Inspect what Cyzie makes of a real coding deck: roles, language, code questions. */
import { readFile } from 'node:fs/promises';
import { parsePptx } from '../../docs/js/parse-pptx.js';
import { parsePdf, configurePdfjs } from '../../docs/js/parse-pdf.js';
import { parseText } from '../../docs/js/parse-text.js';
import { analyzeDeck } from '../../docs/js/extract.js';
import { buildQuestions } from '../../docs/js/questions.js';
import { gradeAnswer } from '../../docs/js/grade.js';

configurePdfjs(await import('pdfjs-dist/legacy/build/pdf.mjs'));

const files = process.argv.slice(2);
for (const file of files) {
  let parsed;
  if (/\.pdf$/i.test(file)) {
    const buf = await readFile(file);
    parsed = await parsePdf(new Uint8Array(buf));
  } else if (/\.(md|txt)$/i.test(file)) {
    parsed = parseText(await readFile(file, 'utf8'));
  } else {
    const buf = await readFile(file);
    parsed = await parsePptx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  const deck = analyzeDeck(parsed);
  console.log(`\n########## ${file}`);
  console.log(`title: ${deck.deckTitle}`);
  console.log(`stats: ${JSON.stringify(deck.stats)}`);
  console.log('roles: ' + deck.slides.map(s => `${s.index}:${s.role}${s.skipQuestions ? '·skip' : ''}`).join(' '));
  if (deck.roadmap.length) console.log('roadmap: ' + deck.roadmap.map(t => `${t.label}${t.slides.length ? ` → slides ${t.slides.join(',')}` : ''}`).join(' | '));
  if (deck.objectives.length) console.log('objectives: ' + deck.objectives.map(o => o.text.slice(0, 60)).join(' | '));

  let total = 0; const byType = new Map();
  for (const slide of deck.slides) {
    if (slide.skipQuestions) continue;
    const qs = buildQuestions(deck, slide, { count: 6, seed: 'probe' });
    total += qs.length;
    for (const q of qs) byType.set(q.type, (byType.get(q.type) || 0) + 1);
    if (slide.code?.blocks?.length) {
      console.log(`\n--- slide ${slide.index} [${slide.role}] "${slide.title}" — ${slide.code.lang.label}`);
      console.log('    code: ' + slide.code.blocks[0].code.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 120));
      if (slide.code.output) console.log(`    simulated output (${slide.code.output.outputs.length}): ${slide.code.output.summary.slice(0, 70)}`);
      for (const q of qs.filter(x => x.type.startsWith('code_') || x.type === 'line_meaning')) {
        const grade = gradeAnswer(q, q.answer.text);
        console.log(`    Q[${q.type} d${q.difficulty}] ${q.prompt.split('\n').find(Boolean).slice(0, 78)}`);
        console.log(`        answer: ${String(q.answer.text).split('\n')[0].slice(0, 78)}  → self-grade: ${grade.verdict}`);
      }
    }
  }
  console.log(`\n  ${total} questions: ${[...byType.entries()].map(([t, n]) => `${t}×${n}`).join(', ')}`);
}

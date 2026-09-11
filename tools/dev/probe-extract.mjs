/* Inspect extraction quality on a real deck. */
import { readFile } from 'node:fs/promises';
import { parsePptx } from '../../docs/js/parse-pptx.js';
import { parsePdf, configurePdfjs } from '../../docs/js/parse-pdf.js';
import { analyzeDeck } from '../../docs/js/extract.js';

configurePdfjs(await import('pdfjs-dist/legacy/build/pdf.mjs'));

const files = process.argv.slice(2);
const limit = Number(process.env.LIMIT || 6);
for (const f of files) {
  const buf = await readFile(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = /\.pdf$/i.test(f) ? await parsePdf(new Uint8Array(buf)) : await parsePptx(ab);
  const deck = analyzeDeck(parsed);
  console.log(`\n########## ${f}`);
  console.log(`deck title: ${deck.deckTitle}`);
  console.log(`stats: ${JSON.stringify(deck.stats)}`);
  for (const s of deck.slides.slice(0, limit)) {
    console.log(`\n--- #${s.index} "${s.title}" ${s.skipQuestions ? '[SKIPPED]' : ''} facts=${s.facts.length} lists=${s.lists.length}`);
    for (const t of s.terms.slice(0, 6)) {
      console.log(`    TERM[${t.kind}] ${t.term}  ::  ${(t.definition || '(no definition)').slice(0, 95)}`);
    }
    if (s.lists.length) console.log(`    LIST "${s.lists[0].lead}" → ${s.lists[0].items.length} items: ${s.lists[0].items[0].slice(0, 60)}`);
  }
}

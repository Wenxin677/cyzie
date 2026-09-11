/* Quick parser smoke test against real fixtures (not committed to the public repo). */
import { readFile } from 'node:fs/promises';
import { parsePptx } from '../../docs/js/parse-pptx.js';

const files = process.argv.slice(2);
for (const f of files) {
  const buf = await readFile(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = Date.now();
  const { slides } = await parsePptx(ab);
  console.log(`\n=== ${f}  (${slides.length} slides, ${Date.now() - t0}ms) ===`);
  for (const s of slides.slice(0, 3)) {
    console.log(`\n--- slide ${s.index} | title: "${s.title}"`);
    for (const l of s.lines.slice(0, 8)) console.log(`    ${l.bullet ? '• ' : '  '}${l.bold ? '[B]' : ''}${l.text.slice(0, 110)}`);
    if (s.notes) console.log(`    NOTES: ${s.notes.slice(0, 100).replace(/\n/g, ' | ')}`);
  }
  const empty = slides.filter(s => !s.lines.length).length;
  const withTitle = slides.filter(s => s.title && !/^Slide \d+$/.test(s.title)).length;
  console.log(`\n  empty slides: ${empty}, auto-titled: ${slides.length - withTitle}`);
}

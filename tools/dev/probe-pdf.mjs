/* Smoke-test the PDF parser against a real slide deck (legacy pdf.js build works in Node). */
import { readFile } from 'node:fs/promises';
import { parsePdf, configurePdfjs } from '../../docs/js/parse-pdf.js';

const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs');
configurePdfjs(legacy);

const files = process.argv.slice(2);
for (const f of files) {
  const buf = await readFile(f);
  const t0 = Date.now();
  const { slides } = await parsePdf(new Uint8Array(buf));
  console.log(`\n=== ${f} (${slides.length} pages, ${Date.now() - t0}ms)`);
  for (const s of slides.slice(0, 4)) {
    console.log(`\n--- page ${s.index} | title: "${s.title}" | ${s.width}×${s.height}`);
    for (const l of s.lines.slice(0, 10)) console.log(`    lvl${l.level} ${l.bullet ? '• ' : ''}${l.bold ? '[B]' : ''}${l.heading ? '[H]' : ''}${l.text.slice(0, 110)}`);
  }
  const emptyish = slides.filter(s => s.lines.length < 2).length;
  console.log(`\n  thin pages (<2 lines): ${emptyish}`);
}

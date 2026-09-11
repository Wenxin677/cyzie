/* Diagnose why slides come out empty: dump shape kinds + rels for chosen slides. */
import { readFile } from 'node:fs/promises';
import { openZip } from '../../docs/js/zip.js';
import { xmlTokens } from '../../docs/js/parse-pptx.js';

const [file, ...slideNums] = process.argv.slice(2);
const buf = await readFile(file);
const zip = await openZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

for (const n of slideNums) {
  const path = `ppt/slides/slide${n}.xml`;
  const xml = await zip.read(path);
  const kinds = new Map();
  for (const t of xmlTokens(xml)) {
    if (t.kind === 'text') continue;
    kinds.set(t.name, (kinds.get(t.name) || 0) + 1);
  }
  console.log(`\n=== ${path} (${xml.length} chars)`);
  console.log('  tags:', [...kinds.entries()].map(([k, v]) => `${k}×${v}`).join(' '));
  const rels = await zip.read(`ppt/slides/_rels/slide${n}.xml.rels`);
  if (rels) {
    const found = [...rels.matchAll(/Type="[^"]*\/(\w+)"\s+Target="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);
    console.log('  rels:', found.join(' '));
  } else console.log('  rels: none');
}
console.log('\n-- diagram/chart parts in package --');
console.log(zip.names.filter(n => /diagram|chart|media/.test(n)).slice(0, 25).join('\n'));

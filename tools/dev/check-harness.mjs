// Syntax-check the inline scripts of a harness page (they are ES modules inside <script>).
//   node tools/dev/check-harness.mjs docs/tests/fuzz.html
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/dev/check-harness.mjs <page.html>'); process.exit(2); }
const html = readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let bad = 0;
scripts.forEach((src, i) => {
  const tmp = join(tmpdir(), `harness-chunk-${i}.mjs`);
  writeFileSync(tmp, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log(`chunk ${i}: OK (${src.split('\n').length} lines)`);
  } catch (err) {
    bad += 1;
    console.log(`chunk ${i}: SYNTAX ERROR`);
    console.log(String(err.stderr || err.stdout).slice(0, 800));
  }
});
process.exit(bad ? 1 : 0);

// Run a Cyzie browser harness in headless Chrome and wait for its disk report.
//
//   node tools/dev/headless-run.mjs <url> <report-name> [timeoutSeconds]
//
// The harness pages POST their results to tools/dev/harness-server.mjs, which writes
// tools/dev/reports/<name>.json. This runner just needs to keep a fresh browser alive
// until that file appears, then shut it down — no CDP scripting required.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, report, timeoutArg] = process.argv.slice(2);
if (!url || !report) {
  console.error('usage: node tools/dev/headless-run.mjs <url> <report-name> [timeoutSeconds]');
  process.exit(2);
}
const timeoutMs = (Number(timeoutArg) || 300) * 1000;
const reportPath = resolve('tools/dev/reports', `${report}.json`);
if (existsSync(reportPath)) rmSync(reportPath);

const profile = mkdtempSync(join(tmpdir(), 'cyzie-headless-'));
const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  `--user-data-dir=${profile}`,
  '--window-size=1280,900',
  url,
], { stdio: 'ignore' });

let done = false;
const started = Date.now();
const poll = setInterval(() => {
  if (existsSync(reportPath) && statSync(reportPath).size > 0) {
    done = true;
    clearInterval(poll);
    // Give the page a beat to finish writing, then report.
    setTimeout(() => finish(0), 800);
  } else if (Date.now() - started > timeoutMs) {
    done = true;
    clearInterval(poll);
    console.error(`timed out after ${timeoutMs / 1000}s with no report`);
    finish(1);
  }
}, 1000);

function finish(code) {
  try { child.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  if (existsSync(reportPath)) {
    const data = JSON.parse(readFileSync(reportPath, 'utf8'));
    const passed = data.passed ?? 0;
    const total = data.total ?? 0;
    console.log(`${report}: ${passed}/${total} checks passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    for (const f of data.failed || []) console.log(`  FAIL ${f}`);
    if ((data.failed || []).length === 0 && total > 0) console.log('All good.');
    process.exit(total > 0 && passed === total ? 0 : 1);
  }
  process.exit(code);
}

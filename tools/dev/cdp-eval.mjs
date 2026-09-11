// Evaluate an expression in a real page and print the result (or the page's visible text).
//
//   node tools/dev/cdp-eval.mjs <url> [expression] [waitMs]
//
// Uses the DevTools Protocol over Node's built-in WebSocket — no dependencies.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, expression = 'document.body.innerText', waitArg] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/dev/cdp-eval.mjs <url> [expression] [waitMs]'); process.exit(2); }
const waitMs = Number(waitArg) || 6000;
const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cyzie-eval-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page');
    } catch { /* not up yet */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('DevTools endpoint never came up');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const res = await send('Runtime.evaluate', {
    expression: `(() => { try { return String(${expression}); } catch (e) { return 'EVAL ERROR: ' + e.message; } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(res?.result?.value ?? '(no value)');
  ws.close();
} catch (err) {
  console.error(`eval failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* gone */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

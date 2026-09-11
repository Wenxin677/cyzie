// Screenshot a Cyzie page once it is actually ready (not just loaded).
//
//   node tools/dev/shot.mjs <url> <out.png> [readyExpression] [width] [height]
//
// `readyExpression` is evaluated in the page and polled until truthy (default: at least
// three chat messages, i.e. a lesson is genuinely open). Uses the DevTools Protocol over
// Node's built-in WebSocket — no dependencies.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, readyExpr, widthArg, heightArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/dev/shot.mjs <url> <out.png> [readyExpression] [width] [height]');
  process.exit(2);
}
const width = Number(widthArg) || 1440;
const height = Number(heightArg) || 1000;
const ready = readyExpr || "document.querySelectorAll('.msg').length > 2";
const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cyzie-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars=false',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { open, send, close: () => ws.close() };
}

try {
  const page = await targets();
  const { open, send, close } = connect(page.webSocketDebuggerUrl);
  await open;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });

  const deadline = Date.now() + 45000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(500);
    const res = await send('Runtime.evaluate', { expression: `!!(${ready})`, returnByValue: true });
    if (res?.result?.value) { ok = true; break; }
  }
  await sleep(700);   // let entrance animations settle
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(shot.data, 'base64'));
  console.log(`${ok ? 'ready' : 'TIMED OUT (captured anyway)'} → ${target}`);
  close();
} catch (err) {
  console.error(`shot failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* gone */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

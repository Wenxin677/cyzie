/* Dev harness server: serves docs/ and collects test reports from the browser harnesses.
   Reports are written to tools/dev/reports/<name>.json and printed on stdout as JSON lines,
   so results survive even if the page that produced them dies.

   Usage: node tools/dev/harness-server.mjs [port]   (default 8130)
*/

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../docs/', import.meta.url));
const REPORTS = fileURLToPath(new URL('./reports/', import.meta.url));
const PORT = Number(process.argv[2] || 8130);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

await mkdir(REPORTS, { recursive: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/report') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const name = (url.searchParams.get('name') || 'report').replace(/[^\w.-]/g, '');
    try {
      const parsed = JSON.parse(body);
      await writeFile(join(REPORTS, `${name}.json`), JSON.stringify(parsed, null, 2));
      console.log(`REPORT ${name}: ${parsed.passed}/${parsed.total} passed${parsed.failed?.length ? ` — FAILED: ${parsed.failed.join(' | ')}` : ' — all good'}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } catch (err) {
      console.log(`REPORT ${name}: malformed (${err.message})`);
      res.writeHead(400).end('bad json');
    }
    return;
  }

  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const filePath = join(ROOT, normPath(path).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, () => console.log(`harness server on http://127.0.0.1:${PORT} (root ${ROOT})`));

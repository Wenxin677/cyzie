/* PDF text extraction via pdf.js — page-by-page, with line reconstruction,
   font-size based heading detection and bold-run detection for term mining. */

import { normalize } from './nlp.js';

let injected = null;       // test hook: a pdfjs module (Node uses the legacy build)
let pending = null;

export function configurePdfjs(lib) { injected = lib; }

async function pdfjsLib() {
  if (injected) return injected;
  if (!pending) {
    pending = import('../vendor/pdf.min.mjs').then(mod => {
      mod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return mod;
    });
  }
  return pending;
}

const BULLET_RE = /^\s*(?:[\u2022\u25cf\u25aa\u25e6\u2023\u2043\u00b7\u25a0\u25b8\u27a4\u2192*>+-]|\(?\d{1,2}[.)]|[a-z][.)])\s+/;

/* pdf.js may transfer the buffer it is given to its worker, which detaches the
   caller's copy — always hand it a private clone so the file can be rendered again. */
function copiesOf(buffer) {
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return src.slice(0);
}

/* Many decks draw bullets with a symbol font; pdf.js then yields the raw glyph
   ("n", "/n", "ü", "\uf0b7" …). Strip markers that repeat as a first token on the page. */
const ARTIFACT_RE = /^(?:n|l|u|o|ü|ö|§|Ø|\/n|\\n|[\uf000-\uf8ff])$/i;
const PRIVATE_USE = /^[\uf000-\uf8ff]$/;

function stripBulletArtifacts(rows) {
  const counts = new Map();
  for (const r of rows) {
    const first = r.text.split(' ')[0];
    if (first && ARTIFACT_RE.test(first)) counts.set(first, (counts.get(first) || 0) + 1);
  }
  for (const r of rows) {
    const parts = r.text.split(' ');
    const first = parts[0];
    if (!first || parts.length < 3) continue;
    const repeated = (counts.get(first) || 0) >= 2;
    const rest = parts.slice(1).join(' ');
    if ((repeated || PRIVATE_USE.test(first)) && /^[A-Z0-9("'“‘]/.test(rest)) {
      r.text = rest;
      r.bullet = true;
      continue;
    }
    // A lone stray punctuation mark in front of a sentence is a mis-mapped bullet glyph.
    if (/^["'`´.,;:·¨^~]$/.test(first) && /^[A-Z0-9]/.test(rest)) {
      r.text = rest;
      r.bullet = true;
    }
  }
  return rows;
}

function isBoldFont(name = '') {
  const n = String(name);
  return /bold|black|heavy|semibold|demi/i.test(n) && !/oblique|italic/i.test(n.replace(/bold/gi, ''));
}

/** Group positioned text items into visual lines. */
function buildLines(items) {
  const usable = items.filter(it => it.str != null && it.str.trim() !== '');
  if (!usable.length) return [];
  const rows = [];
  const sorted = usable.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    const tol = Math.max(2, Math.min(it.size || 10, last?.size || 10) * 0.45);
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
      last.size = Math.max(last.size, it.size || 0);
    } else {
      rows.push({ y: it.y, size: it.size || 10, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.map(r => {
    let text = '';
    let prev = null;
    let boldChars = 0;
    for (const it of r.items) {
      const gap = prev ? it.x - (prev.x + (prev.width || 0)) : 0;
      if (prev && gap > Math.max(1.2, (it.size || 10) * 0.22) && !/\s$/.test(text)) text += ' ';
      text += it.str;
      if (it.bold) boldChars += it.str.length;
      prev = it;
    }
    const clean = normalize(text);
    return {
      text: clean,
      x: r.items[0] ? r.items[0].x : 0,
      y: r.y,
      size: Math.round((r.size || 10) * 10) / 10,
      bold: clean.length > 0 && boldChars / clean.length > 0.6,
      bullet: BULLET_RE.test(text) || BULLET_RE.test(clean),
    };
  }).filter(r => r.text.length > 0);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function parsePdf(buffer, { onProgress } = {}) {
  const pdfjs = await pdfjsLib();
  const data = copiesOf(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const slides = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const styles = tc.styles || {};
      const viewport = page.getViewport({ scale: 1 });
      const items = [];
      for (const raw of tc.items) {
        if (!raw.str) continue;
        const tr = raw.transform || [1, 0, 0, 1, 0, 0];
        const size = Math.hypot(tr[2] || 0, tr[3] || 0) || Math.abs(tr[3]) || 10;
        const style = styles[raw.fontName] || {};
        const fam = String(style.fontFamily || raw.fontName || '');
        items.push({
          str: raw.str.replace(/\u00a0/g, ' '),
          x: tr[4], y: tr[5], width: raw.width || 0,
          size: Math.round(size * 10) / 10,
          bold: isBoldFont(fam),
          font: fam,
        });
      }
      const lines = stripBulletArtifacts(buildLines(items));
      const bodySize = median(lines.map(l => l.size));
      let title = '';
      const candidates = lines.filter(l => l.text.length > 2 && l.text.length <= 110);
      if (candidates.length) {
        const biggest = candidates.reduce((a, b) => (b.size > a.size ? b : a));
        if (biggest.size >= Math.max(11, bodySize * 1.15)) title = biggest.text;
      }
      const trimmedTitle = title.replace(BULLET_RE, '').trim();
      const rows = lines.filter(l => normalize(l.text) !== title && normalize(l.text).replace(BULLET_RE, '').trim() !== trimmedTitle);
      const minX = rows.length ? Math.min(...rows.map(r => r.x)) : 0;
      const indentUnit = 14;
      const out = [];
      for (const r of rows) {
        const isHeading = ((r.size >= Math.max(11, bodySize * 1.2)) || (r.bold && r.text.length < 70))
          && r.text.length < 80 && !r.bullet && !/[.;:]$/.test(r.text);
        out.push({
          text: r.text.replace(BULLET_RE, '').trim(),
          level: isHeading ? 0 : Math.max(0, Math.min(3, Math.round((r.x - minX) / indentUnit))),
          bullet: r.bullet ? '•' : null,
          bold: r.bold,
          size: r.size,
          heading: isHeading,
        });
      }
      slides.push({
        index: p,
        title: trimmedTitle || (out[0] ? out[0].text.slice(0, 90) : `Page ${p}`),
        lines: out.filter(l => l.text),
        notes: '',
        source: 'pdf',
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
      });
      if (onProgress) onProgress({ done: p, total: doc.numPages });
    }
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  return { kind: 'pdf', slides };
}

/** Render one PDF page to a data URL (used by the slide preview panel). */
export async function renderPdfPage(buffer, pageNumber, { scale = 1.4 } = {}) {
  const pdfjs = await pdfjsLib();
  const data = copiesOf(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/* OOXML (.pptx / .docx) text extraction — slides or paragraphs, with formatting signals.
   Uses a small hand-rolled XML scanner so the same code runs in the browser and in Node tests. */

import { openZip } from './zip.js';
import { normalize } from './nlp.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXmlEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
  });
}

/** Tokenize XML into {kind:'open'|'close'|'self'|'text', name, attrs, text} events. */
export function* xmlTokens(xml) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (i < n) yield { kind: 'text', text: xml.slice(i) };
      return;
    }
    if (lt > i) yield { kind: 'text', text: xml.slice(i, lt) };
    const gt = xml.indexOf('>', lt);
    if (gt === -1) return;
    let inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (!inner || inner[0] === '!' || inner[0] === '?') continue;
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const close = inner[0] === '/';
    if (close) inner = inner.slice(1);
    const sp = inner.search(/\s/);
    const name = (sp === -1 ? inner : inner.slice(0, sp)).trim();
    const attrs = {};
    if (sp !== -1) {
      const attrText = inner.slice(sp);
      const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = re.exec(attrText))) {
        const key = m[1];
        const val = decodeXmlEntities(m[2]);
        attrs[key] = val;
        // OOXML word-processing attrs are prefixed (w:val); expose the bare name too.
        const bare = key.includes(':') ? key.split(':').pop() : null;
        if (bare && !(bare in attrs)) attrs[bare] = val;
      }
    }
    yield { kind: selfClosing ? 'self' : close ? 'close' : 'open', name, attrs };
  }
}

/**
 * Scan a slide / notesSlide / document XML into shape-aware paragraphs.
 * Captures: placeholder role (title vs body), paragraph level, bullet char, bold/italic runs,
 * run font size, and whether the paragraph lives inside a table.
 */
export function scanOoxml(xml, { notesMode = false } = {}) {
  const shapes = [];
  const loose = [];
  let ctx = null;
  let para = null;
  let run = null;
  let inText = false;
  let inTable = false;

  const currentParas = () => (ctx ? ctx.paragraphs : loose);
  const flushPara = () => {
    if (!para) return;
    para.text = normalize(para.text);
    if (para.text) currentParas().push(para);
    para = null;
    run = null;
  };
  const flushShape = () => {
    flushPara();
    if (ctx) {
      ctx.paragraphs = ctx.paragraphs.filter(p => p.text);
      shapes.push(ctx);
      ctx = null;
    }
  };
  const openShape = () => { flushShape(); ctx = { isTitle: false, isBody: false, table: false, paragraphs: [] }; };

  for (const t of xmlTokens(xml)) {
    if (t.kind === 'text') {
      if (inText) {
        const txt = decodeXmlEntities(t.text);
        if (!para) para = { level: 0, text: '', runs: [], bullet: null, table: inTable };
        para.text += txt;
        if (run) run.text += txt;
      }
      continue;
    }
    const short = t.name.includes(':') ? t.name.split(':').pop() : t.name;
    if (t.kind === 'open' || t.kind === 'self') {
      switch (short) {
        case 'sp': case 'graphicFrame': case 'pic':
          openShape(); break;
        case 'ph': {
          const type = (t.attrs.type || 'obj').toLowerCase();
          if (ctx) {
            if (type === 'title' || type === 'ctrtitle') ctx.isTitle = true;
            else if (/sldnum|ftr|dt|hdr|foot/.test(type)) ctx.decorative = true;
            else if (/body|obj|subtitle|content/.test(type)) ctx.isBody = true;
          }
          break;
        }
        case 'txBody': case 'body': case 'cell':
          if (!ctx) openShape();
          break;
        case 'tbl':
          inTable = true; if (ctx) ctx.table = true; break;
        case 'p': case 'para':
          flushPara();
          para = { level: 0, text: '', runs: [], bullet: null, table: inTable };
          break;
        case 'pPr': case 'pPrChange': {
          if (!para) break;
          const lvl = t.attrs.lvl ?? t.attrs['w:lvl'];
          if (lvl) para.level = parseInt(lvl, 10) || 0;
          if (t.attrs.algn) para.algn = t.attrs.algn;
          if (t.attrs.pStyle) para.style = t.attrs.pStyle;
          break;
        }
        case 'pStyle': if (para && t.attrs.val) para.style = t.attrs.val; break;
        case 'ilvl': if (para && t.attrs.val) para.level = parseInt(t.attrs.val, 10) || 0; break;
        case 'buChar': if (para) para.bullet = t.attrs.char || '•'; break;
        case 'buAutoNum': if (para) para.bullet = '#'; break;
        case 'buNone': if (para) para.bullet = null; break;
        case 'numPr': if (para) para.numbered = true; break;
        case 'r': case 'ins': case 'hyperlink':
          if (!para) para = { level: 0, text: '', runs: [], bullet: null, table: inTable };
          run = { text: '', bold: false, italic: false, size: null };
          para.runs.push(run);
          break;
        case 'br': if (para) para.text += ' '; run = null; break;
        case 'rPr': case 'endParaRPr':
          if (run) {
            if (t.attrs.b === '1' || t.attrs.b === 'true') run.bold = true;
            if (t.attrs.i === '1' || t.attrs.i === 'true') run.italic = true;
            if (t.attrs.sz) run.size = parseInt(t.attrs.sz, 10) / 100;
          }
          break;
        case 'b': // docx bare bold toggle
          if (run && t.attrs.val !== '0' && t.attrs.val !== 'false') run.bold = true;
          break;
        case 't': case 'delText': case 'instrText':
          inText = true; break;
        default: break;
      }
      continue;
    }
    // close / self-close bookkeeping
    switch (short) {
      case 't': case 'delText': case 'instrText': inText = false; break;
      case 'p': case 'para': flushPara(); break;
      case 'sp': case 'graphicFrame': case 'pic': flushShape(); break;
      case 'tbl': inTable = false; break;
      default: break;
    }
  }
  flushPara();
  flushShape();
  if (loose.length) shapes.push({ isTitle: false, isBody: false, table: false, paragraphs: loose.filter(p => p.text) });

  if (notesMode) {
    const body = shapes.filter(s => !s.isTitle).flatMap(s => s.paragraphs)
      .filter(p => p.text.length > 2 && !/^\d{1,3}$/.test(p.text));
    return { paragraphs: body, shapes };
  }
  return { paragraphs: shapes.flatMap(s => s.paragraphs), shapes };
}

function paragraphMeta(p) {
  const boldChars = (p.runs || []).filter(r => r.bold).reduce((n, r) => n + r.text.length, 0);
  const total = Math.max(1, p.text.length);
  const size = (p.runs || []).reduce((m, r) => Math.max(m, r.size || 0), 0) || null;
  return { boldRatio: boldChars / total, size };
}

/* --------------------------------------------------------------- pptx ---- */

async function slideOrder(zip) {
  const pres = await zip.read('ppt/presentation.xml');
  const rels = await zip.read('ppt/_rels/presentation.xml.rels');
  if (!pres) return numericOrder(zip);
  const ridToTarget = new Map();
  if (rels) {
    for (const t of xmlTokens(rels)) {
      if (t.kind !== 'text' && t.name === 'Relationship' && t.attrs.Id) ridToTarget.set(t.attrs.Id, t.attrs.Target || '');
    }
  }
  const order = [];
  for (const t of xmlTokens(pres)) {
    if (t.kind !== 'text' && t.name === 'p:sldId') {
      const target = ridToTarget.get(t.attrs['r:id'] || t.attrs.id);
      if (target) {
        const clean = target.replace(/^\/?ppt\//, '').replace(/^\.\//, '');
        order.push(clean.startsWith('ppt/') ? clean : `ppt/${clean}`);
      }
    }
  }
  const ordered = order.filter(p => zip.has(p));
  return ordered.length ? ordered : numericOrder(zip);
}

function numericOrder(zip) {
  return zip.names
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
}

async function notesFor(zip, slidePath) {
  const m = slidePath.match(/slide(\d+)\.xml$/);
  if (!m) return '';
  const rels = await zip.read(`ppt/slides/_rels/slide${m[1]}.xml.rels`);
  if (!rels) return '';
  let target = null;
  for (const t of xmlTokens(rels)) {
    if (t.kind !== 'text' && t.name === 'Relationship' && /notesSlide$/.test(t.attrs.Type || '')) target = t.attrs.Target;
  }
  if (!target) return '';
  const path = `ppt/${target.replace(/^\.\.\//, '').replace(/^\.\//, '')}`;
  if (!zip.has(path)) return '';
  try {
    const { paragraphs } = scanOoxml(await zip.read(path), { notesMode: true });
    return paragraphs.map(p => p.text).join('\n');
  } catch { return ''; }
}

/* SmartArt text lives outside the slide part (ppt/diagrams/dataN.xml) — pull it in. */
async function diagramParas(zip, slidePath) {
  const m = slidePath.match(/slide(\d+)\.xml$/);
  if (!m) return [];
  const rels = await zip.read(`ppt/slides/_rels/slide${m[1]}.xml.rels`);
  if (!rels) return [];
  const targets = [];
  for (const t of xmlTokens(rels)) {
    if (t.kind === 'text' || t.name !== 'Relationship') continue;
    if (!/diagramData$/.test(t.attrs.Type || '')) continue;
    const p = `ppt/${(t.attrs.Target || '').replace(/^\.\.\//, '').replace(/^\.\//, '')}`;
    if (zip.has(p)) targets.push(p);
  }
  const out = [];
  for (const p of targets) {
    try {
      const { shapes } = scanOoxml(await zip.read(p));
      for (const sh of shapes) {
        for (const para of sh.paragraphs) {
          if (!para.text || para.text.length < 2) continue;
          if (/^\[.*\]$/.test(para.text)) continue; // SmartArt placeholder markers like [Text]
          out.push({
            text: para.text,
            level: (para.level || 0) + 1,
            bullet: '•',
            bold: (para.runs || []).length > 0 && (para.runs || []).every(r => r.bold),
            size: null,
            table: false,
            smartart: true,
          });
        }
      }
    } catch { /* ignore a broken diagram part */ }
  }
  return out;
}

function firstLineTitle(shapes) {
  for (const s of shapes) {
    for (const p of s.paragraphs) {
      const meta = paragraphMeta(p);
      if (p.text && meta.size && meta.size >= 24 && p.text.length <= 90 && !p.bullet) return p.text;
    }
  }
  for (const s of shapes) {
    for (const p of s.paragraphs) {
      if (p.text && /^Heading\d?$/i.test(p.style || '')) return p.text;
    }
  }
  for (const s of shapes) if (s.paragraphs[0]?.text) return s.paragraphs[0].text.slice(0, 90);
  return '';
}

/** @returns {Promise<{kind:'pptx', slides:Array}>} */
export async function parsePptx(buffer, { onProgress } = {}) {
  const zip = await openZip(buffer);
  const order = await slideOrder(zip);
  if (!order.length) throw new Error('No slides found — is this really a .pptx file (not .ppt)?');
  const slides = [];
  for (let i = 0; i < order.length; i++) {
    const path = order[i];
    const { shapes } = scanOoxml(await zip.read(path));
    const usable = shapes.filter(s => !s.decorative);
    const titleShape = usable.find(s => s.isTitle && s.paragraphs.some(p => p.text));
    const bodyShapes = usable.filter(s => s !== titleShape);
    const title = titleShape
      ? normalize(titleShape.paragraphs.map(p => p.text).join(' '))
      : firstLineTitle(bodyShapes);
    const lines = [];
    for (const s of bodyShapes) {
      for (const p of s.paragraphs) {
        if (!p.text) continue;
        if (p.text === title) continue;
        const meta = paragraphMeta(p);
        lines.push({
          text: p.text,
          level: p.level || 0,
          bullet: p.bullet || (p.level > 0 ? '•' : null),
          bold: meta.boldRatio > 0.6,
          size: meta.size,
          table: !!s.table,
        });
      }
    }
    lines.push(...await diagramParas(zip, path));
    slides.push({
      index: i + 1,
      title: title || (lines[0] ? lines[0].text : `Slide ${i + 1}`),
      lines,
      notes: await notesFor(zip, path),
      source: 'pptx',
    });
    if (onProgress) onProgress({ done: i + 1, total: order.length });
  }
  return { kind: 'pptx', slides };
}

/* --------------------------------------------------------------- docx ---- */

export async function parseDocx(buffer, { onProgress } = {}) {
  const zip = await openZip(buffer);
  const xml = await zip.read('word/document.xml');
  if (!xml) throw new Error('No word/document.xml — not a .docx file?');
  const { shapes } = scanOoxml(xml);
  const paras = shapes.flatMap(s => s.paragraphs).filter(p => p.text);
  const PER = 14; // Word has no slides: pace the document in chunks instead.
  const slides = [];
  for (let i = 0; i < paras.length; i += PER) {
    const chunk = paras.slice(i, i + PER);
    slides.push({
      index: slides.length + 1,
      title: chunk[0] ? chunk[0].text.slice(0, 90) : `Section ${slides.length + 1}`,
      lines: chunk.map(p => ({ text: p.text, level: p.level || 0, bullet: p.bullet, bold: (p.runs || []).some(r => r.bold) })),
      notes: '',
      source: 'docx',
    });
    if (onProgress) onProgress({ done: Math.min(paras.length, i + PER), total: paras.length });
  }
  if (!slides.length) throw new Error('No readable text found in this document.');
  return { kind: 'docx', slides };
}

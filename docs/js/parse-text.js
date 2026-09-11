/* Plain text / Markdown / pasted notes → the same slide shape as PDF and PPTX.
   Markdown headings start new sections; long plain text is chunked by blank lines then size. */

import { normalize, words } from './nlp.js';

function sectionFrom(text, index, title) {
  const raw = normalize(text);
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => ({
    text: s.replace(/^\s*[-*•\u2022]\s*/, '').replace(/^\s*\d{1,2}[.)]\s*/, ''),
    level: /^\s*[-*•\u2022]|\s*\d{1,2}[.)]\s/.test(s) ? 1 : 0,
    bullet: /^\s*[-*•\u2022]/.test(s) ? '•' : null,
    bold: false,
    size: null,
  }));
  return {
    index,
    title: normalize(title || (lines[0] ? lines[0].text.slice(0, 90) : `Section ${index}`)),
    lines,
    notes: '',
    source: 'text',
  };
}

export function parseText(text, { chunkWords = 180 } = {}) {
  const clean = String(text || '').replace(/\r\n?/g, '\n');
  if (!clean.trim()) throw new Error('That file has no readable text.');
  const slides = [];

  const hasMdHeadings = /^#{1,4}\s+\S/m.test(clean);
  if (hasMdHeadings) {
    const parts = clean.split(/^#{1,4}\s+/m).filter(p => p.trim());
    parts.forEach((part, i) => {
      const nl = part.indexOf('\n');
      const heading = nl === -1 ? part : part.slice(0, nl);
      const body = nl === -1 ? '' : part.slice(nl + 1);
      slides.push(sectionFrom(body.trim() || heading, slides.length + 1, heading));
    });
    return { kind: 'text', slides };
  }

  // Blank-line blocks, merged until they reach roughly chunkWords.
  const blocks = clean.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  let bucket = [];
  let count = 0;
  const flush = () => {
    if (!bucket.length) return;
    slides.push(sectionFrom(bucket.join('\n'), slides.length + 1, null));
    bucket = []; count = 0;
  };
  for (const b of blocks) {
    const w = words(b).length;
    if (count && count + w > chunkWords) flush();
    bucket.push(b);
    count += w;
  }
  flush();
  return { kind: 'text', slides };
}

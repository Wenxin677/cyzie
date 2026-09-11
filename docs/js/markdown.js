/* Tiny markdown renderer for Cyzie's messages — the subset the tutor actually emits.
   Escapes HTML first, so slide text can never inject markup. */

import { escapeHtml } from './nlp.js';
import { highlightCode } from './code.js';

const LANG_LABEL = { python: 'Python', java: 'Java', javascript: 'JavaScript', c: 'C', cpp: 'C++', csharp: 'C#', sql: 'SQL', html: 'HTML', css: 'CSS', shell: 'Shell', unknown: 'Code' };

export function renderMarkdown(src = '') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol'
  let quote = false;
  let para = [];
  let fence = null;     // {lang, code: []}

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const closeQuote = () => {
    if (quote) { out.push('</blockquote>'); quote = false; }
  };
  const flushFence = () => {
    if (!fence) return;
    const lang = (fence.lang || 'unknown').toLowerCase();
    const code = fence.code.join('\n');
    const label = LANG_LABEL[lang] || 'Code';
    out.push(
      `<div class="code-block" data-lang="${escapeHtml(lang)}">`
      + `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>`
      + `<button class="code-copy" type="button" data-copy>Copy</button></div>`
      + `<pre class="code"><code>${highlightCode(code, lang)}</code></pre>`
      + `</div>`,
    );
    fence = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    // Fenced code blocks come first: nothing inside them is markdown.
    const fenceStart = line.match(/^\s*```+\s*([\w+#-]*)\s*$/);
    if (fence) {
      if (fenceStart) { flushFence(); continue; }
      fence.code.push(raw);
      continue;
    }
    if (fenceStart) {
      flushPara(); closeList(); closeQuote();
      fence = { lang: fenceStart[1] || 'unknown', code: [] };
      continue;
    }

    if (!line.trim()) { flushPara(); closeList(); closeQuote(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList(); closeQuote();
      const level = Math.min(4, heading[1].length + 2); // h3..h5 inside the chat column
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushPara(); closeList(); closeQuote();
      out.push('<hr>');
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara(); closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push(`<p>${inline(q[1])}</p>`);
      continue;
    }
    const ul = line.match(/^[-*•]\s+(.*)$/);
    if (ul) {
      flushPara(); closeQuote();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^(\d{1,2})[.)]\s+(.*)$/);
    if (ol) {
      flushPara(); closeQuote();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    closeList(); closeQuote();
    para.push(line.trim());
  }
  flushPara(); closeList(); closeQuote(); flushFence();
  return out.join('');
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

export function stripMarkdown(src = '') {
  return String(src)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]([^*_]+)[*_]/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/* Cyzie — app controller: files in, lesson out, chat in the middle. */

import { parsePptx, parseDocx } from './parse-pptx.js';
import { parsePdf, renderPdfPage, closePdfDocument } from './parse-pdf.js';
import { parseText } from './parse-text.js';
import { analyzeDeck, lookupTerm } from './extract.js';
import { highlightCode } from './code.js';
import { LIMITS } from './limits.js';
import { createSession, start, respond, classify, questionsFor } from './tutor.js';
import { renderMarkdown, stripMarkdown } from './markdown.js';
import { SAMPLE_LESSON } from './sample.js';
import {
  saveLesson, listLessons, getLesson, deleteLesson, clearAll,
  serializeDeck, reviveDeck, saveTranscript, getTranscript, loadSettings, saveSettings,
  disableStorage,
} from './store.js';
import { truncate, pct } from './nlp.js';

const $ = sel => document.querySelector(sel);
const el = {
  sidebar: $('#sidebar'), context: $('#context'), scrim: $('#scrim'),
  messages: $('#messages'), chat: $('#chat'), emptyState: $('#emptyState'),
  lessonList: $('#lessonList'), libraryEmpty: $('#libraryEmpty'),
  lessonTitle: $('#lessonTitle'), slideIndicator: $('#slideIndicator'), progressText: $('#progressText'),
  slideNav: $('#slideNav'), panelEmpty: $('#panelEmpty'), panelBody: $('#panelBody'),
  progressFill: $('#progressFill'), chips: $('#chips'), input: $('#input'), composer: $('#composer'),
  slideCardTitle: $('#slideCardTitle'), slideCardNum: $('#slideCardNum'),
  slideCanvasWrap: $('#slideCanvasWrap'), slideText: $('#slideText'),
  qdots: $('#qdots'), termList: $('#termList'), slideStrip: $('#slideStrip'),
  dropzone: $('#dropzone'), dropOverlay: $('#dropOverlay'), fileInput: $('#fileInput'),
  settingsModal: $('#settingsModal'), setName: $('#setName'), setDensity: $('#setDensity'),
  themeBtn: $('#themeBtn'), menuBtn: $('#menuBtn'), panelBtn: $('#panelBtn'),
  prevSlideBtn: $('#prevSlideBtn'), nextSlideBtn: $('#nextSlideBtn'), sendBtn: $('#sendBtn'),
};
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);
const instantMode = params.has('instant');            // used by the self-test harness
const streamMode = params.has('stream');              // force streaming even if the OS asks for less motion
const noStream = instantMode || (reducedMotion && !streamMode);
const MAX_FILE = 60 * 1024 * 1024;
const PREVIEW_BLOB_LIMIT = 24 * 1024 * 1024;

const state = {
  settings: loadSettings(),
  lessons: [],
  lesson: null,     // { id, name, deck, session, blob, previewCache: Map, messages: [] }
  deleted: new Set(), // ids the user removed, so a queued save cannot bring them back
  busy: false,
  typing: false,
};

/* --------------------------------------------------------------- theme --- */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // The rail button names the mode you would switch TO.
  const btn = document.querySelector('[data-role="theme"]');
  if (btn) btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function toggleTheme() {
  state.settings = saveSettings({ theme: state.settings.theme === 'dark' ? 'light' : 'dark' });
  applyTheme(state.settings.theme);
}

/* ------------------------------------------------------------- notices --- */

function notice(text, kind = '') {
  const div = document.createElement('div');
  div.className = `notice ${kind}`.trim();
  div.textContent = text;
  el.messages.prepend(div);
  el.chat.scrollTop = 0;
  setTimeout(() => div.remove(), kind === 'bad' ? 14000 : 8000);
}

/* --------------------------------------------------------- slide cards --- */

/** The visual for one slide, used both in the chat and in the side panel.
 *  PDFs render the real page; PowerPoint/Word/text decks are rebuilt from the
 *  extracted lines (with real code blocks) since there is no .pptx renderer offline. */
function buildSlideCard(lesson, slide, { compact = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'slide-card-chat';
  const head = document.createElement('header');
  const strong = document.createElement('strong');
  strong.textContent = slide.title;
  const marker = document.createElement('span');
  marker.className = 'marker';
  marker.textContent = `Slide ${slide.index} of ${lesson.deck.slides.length}${slide.role && slide.role !== 'content' ? ` · ${slide.role}` : ''}`;
  head.append(strong, marker);
  wrap.appendChild(head);

  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.hidden = true;
  wrap.appendChild(frame);

  const body = document.createElement('div');
  body.className = 'slide-body';

  const codeLines = new Set((slide.code?.blocks || []).flatMap(b => b.lines));
  for (const block of (slide.code?.blocks || []).slice(0, compact ? 1 : 2)) {
    body.appendChild(codeBlockElement(block.code, block.lang, block.langLabel));
  }
  const rows = (slide.lines || []).filter(l => l.text && !codeLines.has(l.text)).slice(0, compact ? 6 : 16);
  for (const line of rows) {
    const p = document.createElement('p');
    p.className = `line lvl${Math.min(2, line.level || 0)}${line.heading ? ' head' : ''}`;
    if (line.bullet) {
      const b = document.createElement('span');
      b.className = 'bullet';
      b.textContent = '•';
      p.appendChild(b);
    }
    const span = document.createElement('span');
    span.textContent = line.text;
    p.appendChild(span);
    body.appendChild(p);
  }
  if (!rows.length && !(slide.code?.blocks || []).length) {
    const p = document.createElement('p');
    p.className = 'line';
    p.textContent = slide.source === 'pdf'
      ? 'This page is mostly images — see the rendered page above.'
      : 'This slide carries no extractable text (it is a picture or diagram).';
    body.appendChild(p);
  }
  wrap.appendChild(body);

  if (slide.notes) {
    const note = document.createElement('div');
    note.className = 'note-line';
    note.textContent = `Speaker notes: ${truncate(slide.notes, 240)}`;
    wrap.appendChild(note);
  }
  return wrap;
}

function codeBlockElement(code, lang, langLabel) {
  const block = document.createElement('div');
  block.className = 'code-block';
  block.dataset.lang = lang || 'unknown';
  const head = document.createElement('div');
  head.className = 'code-head';
  const label = document.createElement('span');
  label.className = 'code-lang';
  label.textContent = langLabel || 'Code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy';
  copy.textContent = 'Copy';
  head.append(label, copy);
  const pre = document.createElement('pre');
  pre.className = 'code';
  const codeEl = document.createElement('code');
  codeEl.innerHTML = highlightCode(code, lang || 'unknown');   // highlightCode escapes everything
  pre.appendChild(codeEl);
  block.append(head, pre);
  return block;
}

/** Copy buttons on every code block inside a subtree. */
function wireCodeCopy(root) {
  root.querySelectorAll('.code-block').forEach(block => {
    const btn = block.querySelector('.code-copy');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const code = block.querySelector('pre.code')?.innerText || '';
      navigator.clipboard?.writeText(code).then(
        () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); },
        () => notice('Your browser blocked the clipboard.', 'bad'),
      );
    });
  });
}

/** Fill in the rendered page image for a PDF slide, when we still hold the original bytes. */
function hydrateSlideImage(card, lesson, slide) {
  if (!lesson.blob || lesson.deck.kind !== 'pdf') return;
  const frame = card.querySelector('.frame');
  if (!frame) return;
  slideImage(lesson, slide.index)
    .then(url => showFrame(frame, url))
    .catch(() => { frame.hidden = true; });
}

/** Rendered page image, cached once per page and shared by every surface that shows it. */
function slideImage(lesson, pageNumber) {
  const cached = lesson.previewCache.get(pageNumber);
  if (cached) return Promise.resolve(cached);
  if (!lesson.pendingImages) lesson.pendingImages = new Map();
  if (lesson.pendingImages.has(pageNumber)) return lesson.pendingImages.get(pageNumber);
  const job = renderPdfPage(lesson.buffer, pageNumber, { key: lesson.id, maxWidth: 1100, scale: 1.3 })
    .then(url => { cachePreview(lesson, pageNumber, url); lesson.pendingImages.delete(pageNumber); return url; })
    .catch(err => { lesson.pendingImages.delete(pageNumber); throw err; });
  lesson.pendingImages.set(pageNumber, job);
  return job;
}

function showFrame(frame, url) {
  frame.hidden = false;
  frame.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Rendered slide';
  frame.appendChild(img);
}

function cachePreview(lesson, pageNumber, url) {
  lesson.previewCache.set(pageNumber, url);
  while (lesson.previewCache.size > LIMITS.maxPdfRenderCache) {
    const oldest = lesson.previewCache.keys().next().value;
    if (oldest === pageNumber) break;
    lesson.previewCache.delete(oldest);
  }
}

/* --------------------------------------------------------- chat render --- */

function addUserMessage(text) {
  const li = document.createElement('li');
  li.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  li.appendChild(bubble);
  el.messages.appendChild(li);
  if (state.lesson) state.lesson.messages.push({ role: 'user', text });
  scrollChat();
  return li;
}

function addAssistantShell(kind = '', tone = '') {
  const li = document.createElement('li');
  li.className = `msg cyzie ${kind ? `kind-${kind}` : ''} ${tone ? `tone-${tone}` : ''}`.trim();
  li.innerHTML = '<div class="avatar" aria-hidden="true">C</div><div class="body"></div>';
  el.messages.appendChild(li);
  return li;
}

function typingIndicator() {
  const li = document.createElement('li');
  li.className = 'msg cyzie kind-note';
  li.innerHTML = '<div class="avatar" aria-hidden="true">C</div><div class="body"><span class="typing"><span></span><span></span><span></span></span></div>';
  el.messages.appendChild(li);
  scrollChat();
  return li;
}

function scrollChat() {
  const last = el.messages.lastElementChild;
  if (last) last.scrollIntoView({ block: 'end', behavior: reducedMotion ? 'auto' : 'smooth' });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Reveal a message with the light streaming feel of a chat model. */
async function streamInto(li, message) {
  const body = li.querySelector('.body');
  const text = message.text || '';
  const words = text.split(/(\s+)/);
  const total = words.length;
  const budgetMs = Math.min(1400, 260 + total * 9);
  const stepMs = Math.max(8, Math.floor(budgetMs / Math.max(1, total)));
  const chunkWords = total > 260 ? 4 : total > 120 ? 3 : 2;

  if (noStream || total > 900) {
    body.innerHTML = renderMarkdown(text);
  } else {
    let acc = '';
    for (let i = 0; i < words.length; i += chunkWords) {
      acc += words.slice(i, i + chunkWords).join('');
      body.innerHTML = renderMarkdown(acc) + '<span class="cursor" aria-hidden="true"></span>';
      if (i % (chunkWords * 4) === 0) scrollChat();
      await wait(stepMs);
    }
    body.innerHTML = renderMarkdown(text);
  }
  body.appendChild(messageFooter(message));
  if (message.choices && message.choices.length) body.appendChild(choicesList(message));
  if (message.sources && message.sources.length) body.appendChild(sourcesRow(message));
  if (message.card && message.slide) {
    const lesson = state.lesson;
    const slide = lesson?.deck.slides.find(s => s.index === message.slide);
    if (slide) {
      const card = buildSlideCard(lesson, slide);
      body.appendChild(card);
      hydrateSlideImage(card, lesson, slide);
    }
  }
  wireCodeCopy(body);
  scrollChat();
}

function messageFooter(message) {
  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  if (message.kind === 'question') {
    for (const chip of (message.chips || [])) foot.appendChild(chipButton(chip.label, chip.send));
  } else {
    foot.appendChild(actionButton('Copy', () => {
      navigator.clipboard?.writeText(stripMarkdown(message.text || '')).then(
        () => { foot.querySelector('button').textContent = 'Copied'; setTimeout(() => { foot.querySelector('button').textContent = 'Copy'; }, 1400); },
        () => notice('Clipboard is blocked in this browser.', 'bad'),
      );
    }));
    foot.appendChild(actionButton('Explain simpler', () => send('explain that simpler')));
    foot.appendChild(actionButton('Give an example', () => send('give me an example')));
    foot.appendChild(actionButton('More detail', () => send('more detail')));
  }
  return foot;
}

function chipButton(label, payload) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.addEventListener('click', () => send(payload));
  return b;
}

function actionButton(label, handler) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', handler);
  return b;
}

function choicesList(message) {
  const ul = document.createElement('ul');
  ul.className = 'choices';
  if (message.questionId) ul.dataset.questionId = message.questionId;
  const letters = 'ABCDEFGH';
  message.choices.forEach((choice, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.choice = String(i);
    b.innerHTML = `<span class="letter">${letters[i]}</span><span>${renderInline(choice.text)}</span>`;
    b.addEventListener('click', () => {
      if (state.quizLocked) return;
      send(letters[i]);
    });
    li.appendChild(b);
    ul.appendChild(li);
  });
  return ul;
}

function renderInline(text) {
  return renderMarkdown(String(text)).replace(/^<p>|<\/p>$/g, '');
}

function sourcesRow(message) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-foot';
  const label = document.createElement('span');
  label.className = 'tone-badge';
  label.textContent = 'From';
  wrap.appendChild(label);
  for (const src of message.sources) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip source-btn';
    b.textContent = `Slide ${src.slide}`;
    b.title = `${src.title} — ${src.snippet}`;
    b.addEventListener('click', () => send(`go to slide ${src.slide}`));
    wrap.appendChild(b);
  }
  return wrap;
}

/** Render a batch of tutor messages one after another, with typing between them. */
async function renderBatch(messages) {
  state.typing = true;
  for (const m of messages) {
    if (!reducedMotion && messages.length > 1) {
      const dots = typingIndicator();
      await wait(messages.length > 3 ? 160 : 260);
      dots.remove();
    }
    const li = addAssistantShell(m.kind, m.tone);
    await streamInto(li, m);
    if (state.lesson) state.lesson.messages.push({ role: 'cyzie', ...m });
  }
  state.typing = false;
  state.quizLocked = !(state.lesson?.session?.awaiting === 'answer');
  markAnsweredChoices();
  syncChips();
  renderContext();
  renderHeader();
  persistSoon();
}

function markAnsweredChoices() {
  // Only the question Cyzie is currently asking may be clicked; older lists are history.
  const liveId = state.lesson?.session?.current?.id || null;
  document.querySelectorAll('.choices').forEach(list => {
    const isLive = list.dataset.questionId === liveId;
    list.querySelectorAll('button').forEach(b => {
      b.disabled = !isLive;
      b.style.opacity = isLive ? '' : '.65';
    });
  });
}

/* ------------------------------------------------------------- sidebar --- */

async function refreshLibrary() {
  try {
    state.lessons = await listLessons();
  } catch {
    state.lessons = [];
  }
  el.lessonList.innerHTML = '';
  el.libraryEmpty.hidden = state.lessons.length > 0;
  for (const lesson of state.lessons) {
    const li = document.createElement('li');
    li.className = 'lesson-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lesson-item';
    btn.setAttribute('aria-current', state.lesson?.id === lesson.id ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'li-name';
    name.textContent = lesson.name;
    const meta = document.createElement('span');
    meta.className = 'li-meta';
    meta.textContent = [lesson.progress?.label, lesson.stats?.slides ? `${lesson.stats.slides} slides` : '', lesson.fileName || '']
      .filter(Boolean).join(' · ');
    btn.append(name, meta);
    btn.addEventListener('click', () => openLesson(lesson.id));

    // Delete sits beside the open button, never inside it (nested buttons break click handling).
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'li-del';
    del.textContent = '×';
    del.title = `Delete “${lesson.name}”`;
    del.setAttribute('aria-label', `Delete ${lesson.name}`);
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!window.confirm(`Delete “${lesson.name}” and its transcript?`)) return;
      state.deleted.add(lesson.id);            // stop any queued save from resurrecting it
      await deleteLesson(lesson.id);
      closePdfDocument(lesson.id);
      if (state.lesson?.id === lesson.id) {
        state.lesson = null;
        clearTimeout(persistTimer);
        savePending = false;
        el.messages.innerHTML = '';
        showEmptyState(true);
        renderHeader();
        syncChips();
      }
      await refreshLibrary();
    });

    li.append(btn, del);
    el.lessonList.appendChild(li);
  }
}

function showEmptyState(show) {
  el.emptyState.hidden = !show;
  // The messages list is a flex container, so the hidden attribute alone is not enough.
  el.messages.style.display = show ? 'none' : 'flex';
  if (show) refreshWelcome();
}

/** A time-of-day greeting, personalised once the learner adds their name. */
function refreshWelcome() {
  const name = (state.settings.learner || '').trim();
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const greeting = `#welcomeGreeting`;
  const node = document.getElementById('welcomeGreeting');
  if (!node) return;
  node.textContent = `${part}${name ? `, ${name}` : ''}.`;
  const lede = document.getElementById('welcomeLede');
  if (lede) {
    lede.textContent = name
      ? `I am Cyzie. Hand me your ${state.settings.focus || 'lecture'} slides and I will teach them to you one slide at a time — explaining each page, questioning you on it, and answering whatever you ask, straight from your file.`
      : 'I am Cyzie. Give me your lecture slides and I will teach them to you one slide at a time — explaining each page, questioning you on it, and answering whatever you ask, straight from your file.';
  }
}

/* -------------------------------------------------------------- header --- */

function teachableSlides() {
  return state.lesson?.deck.slides.filter(s => !s.skipQuestions) || [];
}

function renderHeader() {
  const lesson = state.lesson;
  if (!lesson) {
    el.lessonTitle.textContent = 'No lesson loaded';
    el.slideIndicator.textContent = '';
    el.progressText.textContent = '';
    el.progressFill.style.width = '0%';
    if (el.slideNav) el.slideNav.hidden = true;
    return;
  }
  if (el.slideNav) el.slideNav.hidden = false;
  const session = lesson.session;
  const slide = lesson.deck.slides.find(s => s.index === session.slide);
  el.lessonTitle.textContent = lesson.name;
  el.slideIndicator.textContent = slide ? `Slide ${slide.index} of ${lesson.deck.slides.length} · ${truncate(slide.title, 46)}` : '';
  const answered = session.stats.answered;
  const acc = answered ? ` · ${pct(session.stats.correct / answered)}% correct` : '';
  el.progressText.textContent = answered ? `${answered} answered${acc}` : 'Ask Cyzie anything';
  const teachable = teachableSlides().map(s => s.index);
  const visited = new Set(session.seenSlides).size;
  const done = teachable.length ? Math.min(1, visited / teachable.length) : 0;
  el.progressFill.style.width = `${Math.round(done * 100)}%`;
  el.prevSlideBtn.disabled = session.slide <= 1;
  el.nextSlideBtn.disabled = session.slide >= lesson.deck.slides.length;
}

/* -------------------------------------------------------------- chips ---- */

function syncChips() {
  const session = state.lesson?.session;
  el.chips.innerHTML = '';
  if (!session) return;
  let chips;
  if (session.awaiting === 'answer') {
    chips = [{ label: 'Hint', send: 'hint' }, { label: 'Show answer', send: 'show answer' }, { label: 'Skip this one', send: 'skip' }];
  } else if (session.phase === 'done') {
    chips = [
      { label: 'Study sheet', send: 'study sheet' },
      { label: 'Summary', send: 'summary' },
      { label: 'Quiz me again', send: 'quiz me' },
      { label: 'Glossary', send: 'glossary' },
    ];
  } else {
    chips = [
      { label: 'Next slide', send: 'next' },
      { label: 'Quiz me', send: 'quiz me' },
      { label: 'Summary', send: 'summary' },
      { label: 'Study sheet', send: 'study sheet' },
    ];
  }
  for (const c of chips) el.chips.appendChild(chipButton(c.label, c.send));
}

/* ------------------------------------------------------------ context ---- */

function renderContext() {
  const lesson = state.lesson;
  const hasLesson = !!(lesson && lesson.deck?.slides?.length);
  if (el.panelEmpty) el.panelEmpty.hidden = hasLesson;
  if (el.panelBody) el.panelBody.hidden = !hasLesson;
  if (!hasLesson) return;
  const session = lesson.session;
  const slide = lesson.deck.slides.find(s => s.index === session.slide);
  if (!slide) return;

  el.slideCardTitle.textContent = slide.title;
  el.slideCardNum.textContent = `Slide ${slide.index}`;

  // Text layout of the slide (always available; also the visual for .pptx/.docx/.txt).
  el.slideText.innerHTML = '';
  const rows = slide.lines.length ? slide.lines : [{ text: '(no extractable text on this slide)', level: 0, bullet: null }];
  for (const line of rows.slice(0, 60)) {
    const p = document.createElement('p');
    p.className = `line lvl${Math.min(2, line.level || 0)}${line.heading ? ' head' : ''}`;
    if (line.bullet) {
      const b = document.createElement('span');
      b.className = 'bullet';
      b.textContent = '•';
      p.appendChild(b);
    }
    const span = document.createElement('span');
    if (line.bold) { const b = document.createElement('b'); b.textContent = line.text; span.appendChild(b); }
    else span.textContent = line.text;
    p.appendChild(span);
    el.slideText.appendChild(p);
  }

  if (lesson.blob && lesson.deck.kind === 'pdf') {
    const cached = lesson.previewCache.get(slide.index);
    if (cached) showPreview(cached);
    else {
      el.slideCanvasWrap.hidden = true;
      slideImage(lesson, slide.index)
        .then(url => { if (state.lesson?.session?.slide === slide.index) showPreview(url); })
        .catch(() => { el.slideCanvasWrap.hidden = true; });
    }
  } else {
    el.slideCanvasWrap.hidden = true;
  }

  // Question progress for this slide.
  el.qdots.innerHTML = '';
  const stats = session.perSlide[slide.index] || { asked: 0, correct: 0, partial: 0, incorrect: 0 };
  // Questions are built on arrival, so ask the tutor for this slide's set rather than reading the plan.
  const questions = slide.skipQuestions ? [] : questionsFor(session, slide);
  if (!questions.length) {
    const span = document.createElement('span');
    span.style.color = 'var(--muted)';
    span.style.fontSize = '12.5px';
    span.textContent = slide.skipQuestions
      ? 'No quizzable text on this slide.'
      : 'Questions are generated as you go.';
    el.qdots.appendChild(span);
  } else {
    const cursorIndex = session.queue.findIndex(q => q.id === session.current?.id);
    questions.forEach((q, i) => {
      const d = document.createElement('span');
      d.className = 'qdot';
      d.textContent = String(i + 1);
      d.title = `${q.type.replace(/_/g, ' ')} — ${truncate(q.prompt, 120)}`;
      const isCurrent = session.current?.id === q.id;
      const passed = session.awaiting !== 'answer' && i < Math.max(0, cursorIndex < 0 ? session.qCursor : cursorIndex);
      const missed = session.missed.includes(q.id);
      if (isCurrent) d.classList.add('open');
      else if (missed) d.classList.add('missed');
      else if (passed) d.classList.add('done');
      el.qdots.appendChild(d);
    });
    const meta = document.createElement('span');
    meta.style.fontSize = '12px';
    meta.style.color = 'var(--muted)';
    meta.style.alignSelf = 'center';
    meta.textContent = `${stats.correct} correct · ${stats.partial} partial · ${stats.incorrect} missed`;
    el.qdots.appendChild(meta);
  }

  // Terms on this slide.
  el.termList.innerHTML = '';
  const terms = slide.terms.slice(0, 8);
  if (!terms.length) {
    const li = document.createElement('li');
    li.className = 't-def';
    li.textContent = 'No key terms mined from this slide.';
    el.termList.appendChild(li);
  }
  for (const t of terms) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 't-name';
    name.textContent = t.term;
    li.appendChild(name);
    if (t.definition) {
      const def = document.createElement('div');
      def.className = 't-def';
      def.textContent = truncate(t.definition, 220);
      li.appendChild(def);
      li.style.cursor = 'pointer';
      li.title = 'Ask Cyzie about this term';
      li.addEventListener('click', () => send(`what is ${t.term}?`));
    }
    el.termList.appendChild(li);
  }

  // Slide strip.
  el.slideStrip.innerHTML = '';
  for (const s of lesson.deck.slides) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slide-tick';
    if (s.index === slide.index) b.classList.add('current');
    if (session.seenSlides.includes(s.index)) b.classList.add('visited');
    if (s.skipQuestions) b.classList.add('empty');
    b.textContent = String(s.index);
    b.title = `${s.title}${s.skipQuestions ? ' (no quizzable text)' : ''}`;
    b.addEventListener('click', () => send(`go to slide ${s.index}`));
    el.slideStrip.appendChild(b);
  }
}

function showPreview(url) {
  el.slideCanvasWrap.hidden = false;
  el.slideCanvasWrap.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Rendered slide';
  el.slideCanvasWrap.appendChild(img);
}

/* ------------------------------------------------------------- sending --- */

const outbox = [];

async function send(text) {
  const clean = String(text || '').trim();
  if (clean) outbox.push(clean);
  if (state.busy) return;              // already talking: the message waits its turn
  if (!state.lesson) {
    outbox.length = 0;
    notice('Upload a lesson file first — or try the sample lesson on the home screen.', 'bad');
    return;
  }
  while (outbox.length) {
    const next = outbox.shift();
    if (/^(?:download\s+)?(?:study\s*sheet|notes|revision sheet)$/i.test(next.trim())) {
      addUserMessage(next);
      el.input.value = '';
      autoGrow();
      exportStudySheet();
      continue;
    }
    state.busy = true;
    el.sendBtn.disabled = true;
    addUserMessage(next);
    el.input.value = '';
    autoGrow();
    try {
      const { messages } = respond(state.lesson.session, next);
      await renderBatch(messages);
    } catch (err) {
      console.error(err);
      notice(`Cyzie hit a problem: ${err.message}`, 'bad');
      state.typing = false;
    }
  }
  state.busy = false;
  autoGrow();          // the send button tracks whether there is anything to send
  el.input.focus();
}

/* --------------------------------------------------------- study sheet --- */

function buildStudySheet(lesson) {
  const session = lesson.session;
  const deck = lesson.deck;
  const lines = [];
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  lines.push(`# ${deck.deckTitle} — study sheet`);
  lines.push('');
  lines.push(`Built by Cyzie on ${date}${lesson.fileName ? ` from \`${lesson.fileName}\`` : ''}. Everything below comes from that file only.`);
  lines.push('');
  const answered = session.stats.answered;
  lines.push('## Your session');
  lines.push('');
  lines.push(answered
    ? `- ${answered} questions answered · **${pct(session.stats.correct / answered)}% correct** (${session.stats.correct} right, ${session.stats.partial} partly, ${session.stats.incorrect} missed, ${session.stats.skipped} skipped)`
    : '- No questions answered yet.');
  lines.push(`- Slides worked through: ${[...new Set(session.seenSlides)].length} of ${deck.slides.length}`);
  lines.push(`- Longest streak of correct answers: ${session.stats.bestStreak}`);
  lines.push('');

  const terms = [...deck.glossary.values()].filter(t => t.definition);
  if (terms.length) {
    lines.push(`## Glossary (${terms.length} terms)`);
    lines.push('');
    for (const t of terms) lines.push(`- **${t.term}** (slide ${t.slide}) — ${stripMarkdown(t.definition)}`);
    lines.push('');
  }

  lines.push('## Slide by slide');
  lines.push('');
  for (const slide of deck.slides) {
    lines.push(`### Slide ${slide.index} — ${slide.title}`);
    if (slide.notes) lines.push(`_Speaker notes: ${stripMarkdown(truncate(slide.notes, 300))}_`);
    const points = slide.facts.length ? slide.facts.slice(0, 6) : slide.lines.slice(0, 6);
    if (points.length) {
      for (const p of points) {
        const text = stripMarkdown(p.text || '');
        if (text && text.length > 6) lines.push(`- ${text}`);
      }
    } else {
      lines.push('- _(this slide has no extractable text — it is an image or diagram)_');
    }
    lines.push('');
  }

  const missed = session.missed || [];
  // Every question the session has built (a restored session rebuilds only some of them),
  // plus anything still sitting in the plan, de-duplicated by id.
  const seen = new Set();
  const plan = [];
  for (const q of [...(session.builtQuestions?.values() || []), ...(session.plan || []).flatMap(p => p.questions || [])]) {
    if (q && !seen.has(q.id)) { seen.add(q.id); plan.push(q); }
  }
  if (missed.length) {
    lines.push('## Questions to review');
    lines.push('');
    let n = 1;
    for (const q of plan) {
      if (!missed.includes(q.id)) continue;
      lines.push(`${n++}. **(slide ${q.slide})** ${stripMarkdown(q.prompt)}`);
      lines.push(`   - Answer: ${stripMarkdown(q.answer.text)}`);
      if (q.explanation) lines.push(`   - ${stripMarkdown(q.explanation)}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('_Generated locally by Cyzie — no data left this device._');
  return lines.join('\n');
}

function exportStudySheet() {
  const lesson = state.lesson;
  if (!lesson) return;
  const text = buildStudySheet(lesson);
  const safeName = lesson.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'lesson';
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cyzie-${safeName}-study-sheet.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  notice('Study sheet downloaded — glossary, slide notes and the questions you missed, as a markdown file.');
}

/* ------------------------------------------------------------- lessons --- */

async function pickFile() {
  el.fileInput.value = '';
  el.fileInput.click();
}

async function ingestFile(file) {
  if (!file) return false;
  if (state.busy) { notice('Still reading the last file — one moment.'); return false; }
  if (file.size > MAX_FILE) {
    notice(`That file is ${(file.size / 1048576).toFixed(1)} MB. Cyzie works with files up to ${MAX_FILE / 1048576} MB.`, 'bad');
    return false;
  }
  const name = file.name || 'lesson';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!['pdf', 'pptx', 'docx', 'txt', 'md', 'markdown'].includes(ext)) {
    notice(`${name}: Cyzie reads .pptx, .pdf, .docx, .txt and .md files. (Old .ppt and .doc formats need to be saved again in the newer format.)`, 'bad');
    return false;
  }
  if (!(await looksLikeItsType(file, ext))) {
    notice(`${name}: this does not look like a real .${ext} file — it may be renamed, truncated, or a different format. Export it again from PowerPoint / Word / your PDF reader and retry.`, 'bad');
    return false;
  }

  state.busy = true;                 // one upload at a time: no half-built lessons
  el.sendBtn.disabled = true;
  showEmptyState(false);
  el.messages.innerHTML = '';
  const progressLine = addAssistantShell('note');
  const body = progressLine.querySelector('.body');
  body.innerHTML = renderMarkdown(`Reading **${name}**…`);

  try {
    const buffer = await file.arrayBuffer();
    let parsed;
    if (ext === 'pdf') parsed = await parsePdf(new Uint8Array(buffer), {
      onProgress: ({ done, total }) => { body.innerHTML = renderMarkdown(`Reading **${name}** — page ${done} of ${total}…`); },
    });
    else if (ext === 'pptx' || ext === 'docx') parsed = (ext === 'pptx' ? await parsePptx(buffer) : await parseDocx(buffer, {
      onProgress: ({ done, total }) => { body.innerHTML = renderMarkdown(`Reading **${name}** — paragraph ${done} of ${total}…`); },
    }));
    else parsed = parseText(await file.text());

    if (ext === 'pptx' && (!parsed.slides || !parsed.slides.length)) throw new Error('no slides found');
    const deck = analyzeDeck(parsed);
    if (!deck.slides.length) throw new Error('no readable content');
    if (deck.stats.teachable === 0) {
      notice('Cyzie could not find text to teach in this file — it may be scanned images or picture-only slides. If it is a scan, run OCR first and upload the searchable PDF.', 'bad');
    }
    progressLine.remove();
    await createLessonFromDeck(deck, {
      name: name.replace(/\.[^.]+$/, ''),
      fileName: name,
      blob: ext === 'pdf' && buffer.byteLength <= PREVIEW_BLOB_LIMIT ? new Blob([buffer], { type: 'application/pdf' }) : null,
      buffer: ext === 'pdf' ? buffer : null,
    });
    return true;
  } catch (err) {
    // A file we cannot read is an expected outcome, not a crash — log it quietly.
    console.warn(`Cyzie could not read ${name}:`, err?.message || err);
    progressLine.remove();
    notice(`${name}: ${err.message}. If the file came from Google Slides, export it as .pptx or PDF first.`, 'bad');
    return false;
  } finally {
    state.busy = false;
    autoGrow();
  }
}

/** Cheap signature check: a .pdf must start with %PDF, a .pptx/.docx must be a zip. */
async function looksLikeItsType(file, ext) {
  const wantsZip = ext === 'pptx' || ext === 'docx';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return true;
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (wantsZip) return head[0] === 0x50 && head[1] === 0x4b;
    if (ext === 'pdf') return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  } catch {
    return true;   // if the bytes cannot be peeked at, let the parser give the real answer
  }
  return true;
}

async function createLessonFromDeck(deck, { name, fileName = '', blob = null, buffer = null } = {}) {
  const id = `lesson-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const lesson = {
    id,
    name: name || deck.deckTitle,
    fileName,
    deck,
    blob,
    buffer,
    previewCache: new Map(),
    pendingImages: new Map(),
    messages: [],
    session: null,
  };
  state.lesson = lesson;
  lesson.session = createSession(deck, { density: state.settings.density, learner: state.settings.learner, seed: `${id}` });
  showEmptyState(false);
  el.messages.innerHTML = '';
  await refreshLibrary();

  await persistLesson();
  const out = start(lesson.session);
  await renderBatch(out.messages);
}

async function openLesson(id) {
  try {
    const record = await getLesson(id);
    if (!record) { notice('That lesson is no longer in this browser.', 'bad'); return; }
    const deck = reviveDeck(record.deck);
    const lesson = {
      id: record.id,
      name: record.name,
      fileName: record.fileName,
      deck,
      blob: record.blob || null,
      buffer: null,
      previewCache: new Map(),
      pendingImages: new Map(),
      messages: [],
      session: null,
    };
    if (lesson.blob) lesson.buffer = await lesson.blob.arrayBuffer();
    lesson.session = createSession(deck, { density: state.settings.density, learner: state.settings.learner, seed: record.id });

    // Restore the saved run (progress + transcript) without re-teaching everything.
    const saved = await getTranscript(record.id);
    state.lesson = lesson;
    showEmptyState(false);
    el.messages.innerHTML = '';
    if (saved?.session) restoreSession(lesson.session, saved.session);
    if (saved?.messages?.length) {
      renderTranscript(saved.messages);
      renderBatch([]);
    } else {
      const out = start(lesson.session);
      await renderBatch(out.messages);
    }
    await refreshLibrary();
    closeDrawers();
  } catch (err) {
    console.error(err);
    notice(`Could not open that lesson: ${err.message}`, 'bad');
  }
}

function renderTranscript(messages) {
  const session = state.lesson.session;
  const liveQuestionId = session.current?.id;
  for (const m of messages) {
    if (m.role === 'user') { addUserMessage(m.text); continue; }
    const li = addAssistantShell(m.kind, m.tone);
    const body = li.querySelector('.body');
    body.innerHTML = renderMarkdown(m.text || '');
    body.appendChild(messageFooter(m));
    if (m.choices?.length) {
      const list = choicesList(m);
      // Only the question Cyzie is currently on may be answered from the restored history.
      if (m.questionId !== liveQuestionId) {
        list.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '.65'; });
      }
      body.appendChild(list);
    }
    if (m.sources?.length) body.appendChild(sourcesRow(m));
    if (m.card && m.slide) {
      const slide = state.lesson.deck.slides.find(s => s.index === m.slide);
      if (slide) {
        const card = buildSlideCard(state.lesson, slide, { compact: true });
        body.appendChild(card);
        hydrateSlideImage(card, state.lesson, slide);
      }
    }
    wireCodeCopy(body);
    state.lesson.messages.push(m);
  }
  scrollChat();
}

function snapshotSession(session) {
  return {
    slide: session.slide,
    phase: session.phase,
    awaiting: session.awaiting,
    qCursor: session.qCursor,
    currentId: session.current?.id || null,
    queueIds: session.queue.map(q => q.id),
    missed: session.missed,
    perSlide: session.perSlide,
    stats: session.stats,
    seenSlides: session.seenSlides,
    learner: session.learner,
    density: session.density,
  };
}

function restoreSession(session, snap) {
  session.slide = snap.slide ?? session.slide;
  session.phase = snap.phase || 'question';
  session.awaiting = snap.awaiting ?? null;
  session.qCursor = snap.qCursor || 0;
  session.missed = snap.missed || [];
  session.seenSlides = snap.seenSlides || [];
  session.stats = snap.stats || session.stats;
  if (snap.perSlide) session.perSlide = { ...session.perSlide, ...snap.perSlide };

  // Rebuilding is deterministic (same seed + slide), so the restored ids line up exactly.
  const pool = questionsFor(session, session.slide);
  const byId = new Map(pool.map(q => [q.id, q]));
  const restoredQueue = (snap.queueIds || []).map(qid => byId.get(qid)).filter(Boolean);
  session.queue = restoredQueue.length ? restoredQueue : pool;
  session.current = session.queue.find(q => q.id === snap.currentId) || (session.awaiting === 'answer' ? session.queue[session.qCursor] || null : null);
  if (session.awaiting === 'answer' && session.current) session.awaiting = 'answer';
}

let persistTimer = null;
let lastSaveAt = 0;
let savePending = false;

/** Save at most once every 1.5 s, but never lose the tail of a busy session:
    a save is always scheduled, no matter how many turns arrive in between. */
function persistSoon() {
  if (savePending) return;
  savePending = true;
  const delay = Math.max(0, 1500 - (Date.now() - lastSaveAt));
  persistTimer = setTimeout(async () => {
    savePending = false;
    lastSaveAt = Date.now();
    await persistLesson();
  }, delay);
}

async function persistLesson() {
  const lesson = state.lesson;
  if (!lesson || state.deleted.has(lesson.id)) return;
  try {
    const teachable = teachableSlides().map(s => s.index);
    const visited = new Set(lesson.session.seenSlides).size;
    const answered = lesson.session.stats.answered;
    const record = {
      id: lesson.id,
      name: lesson.name,
      fileName: lesson.fileName,
      deck: serializeDeck(lesson.deck, lesson.session),
      stats: lesson.deck.stats,
      progress: {
        slides: teachable.length,
        visited,
        answered,
        correct: lesson.session.stats.correct,
        label: answered ? `${pct(lesson.session.stats.correct / answered)}% correct` : 'not started',
      },
    };
    if (lesson.blob) record.blob = lesson.blob;
    await saveLesson(record);
    await saveTranscript(lesson.id, state.lesson.messages, snapshotSession(lesson.session));
    await refreshLibrary();
  } catch (err) {
    console.warn('save failed', err);
  }
}

/* --------------------------------------------------------------- input --- */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
}

/* -------------------------------------------------------------- wiring --- */

function closeDrawers() {
  document.body.classList.remove('sidebar-open', 'context-open');
  el.scrim.classList.remove('open');
}

function wire() {
  el.composer.addEventListener('submit', (ev) => { ev.preventDefault(); send(el.input.value); });
  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(el.input.value); }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); el.input.focus(); }
    if (ev.key === 'Escape') { el.settingsModal.classList.remove('open'); closeDrawers(); }
  });

  $('#newLessonBtn').addEventListener('click', pickFile);
  $('#pickFileBtn').addEventListener('click', pickFile);
  $('#sampleBtn').addEventListener('click', loadSample);
  el.fileInput.addEventListener('change', () => ingestFile(el.fileInput.files?.[0]));

  // Welcome-screen suggestion chips: with a lesson loaded they go to Cyzie, without one
  // they explain what to do first.
  document.querySelectorAll('#suggestions button').forEach(btn => {
    btn.addEventListener('click', () => {
      const line = btn.dataset.say || '';
      if (state.lesson) send(line);
      else {
        const focus = /python/i.test(line) ? 'python' : /java/i.test(line) ? 'java' : '';
        if (focus) state.settings = saveSettings({ focus });
        showEmptyState(true);
        refreshWelcome();
        notice(`Drop your ${focus || 'lecture'} slides above (or click Choose a file) and I will build the lesson from them. Ask me anything once we start.`);
      }
    });
  });
  $('#helpBtn')?.addEventListener('click', () => {
    if (state.lesson) send('help');
    else notice('Upload a file first — I read it in your browser, then walk you through it slide by slide. Everything you can say to me is listed with the help command once a lesson is open.');
  });

  el.menuBtn.addEventListener('click', () => {
    if (window.innerWidth <= 860) {
      document.body.classList.toggle('sidebar-open');
      el.scrim.classList.toggle('open', document.body.classList.contains('sidebar-open'));
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
  });
  el.panelBtn.addEventListener('click', () => {
    if (window.innerWidth <= 1180) {
      document.body.classList.toggle('context-open');
      el.scrim.classList.toggle('open', document.body.classList.contains('context-open'));
    } else {
      document.body.classList.toggle('panel-collapsed');
    }
    renderContext();
  });
  el.scrim.addEventListener('click', closeDrawers);
  el.themeBtn?.addEventListener('click', toggleTheme);
  document.querySelector('[data-role="theme"]').addEventListener('click', toggleTheme);
  el.prevSlideBtn.addEventListener('click', () => {
    const s = state.lesson?.session;
    if (!s) return;
    const prev = [...s.slideOrder].filter(n => n < s.slide).pop();
    if (prev) send(`go to slide ${prev}`);
  });
  el.nextSlideBtn.addEventListener('click', () => {
    const s = state.lesson?.session;
    if (!s) return;
    const next = s.slideOrder.find(n => n > s.slide);
    if (next) send(`go to slide ${next}`);
  });

  document.querySelector('[data-role="settings"]').addEventListener('click', () => {
    el.setName.value = state.settings.learner || '';
    el.setDensity.value = state.settings.density || 'standard';
    el.settingsModal.classList.add('open');
  });
  document.querySelector('[data-role="clear"]').addEventListener('click', async () => {
    if (!window.confirm('Delete every lesson, transcript and setting stored in this browser?')) return;
    await clearAll();
    state.lesson = null;
    state.settings = loadSettings();
    applyTheme(state.settings.theme);
    el.messages.innerHTML = '';
    showEmptyState(true);
    await refreshLibrary();
    renderHeader();
    notice('All local data cleared.');
  });
  $('#saveSettingsBtn').addEventListener('click', async () => {
    const density = el.setDensity.value;
    state.settings = saveSettings({ learner: el.setName.value.trim(), density });
    el.settingsModal.classList.remove('open');
    if (state.lesson) {
      if (state.settings.learner && !state.lesson.session.learner) state.lesson.session.learner = state.settings.learner;
      notice(`Saved. New lessons will use ${density === 'quick' ? '3' : density === 'deep' ? '7' : '5'} questions per slide.`);
      renderContext();
    }
  });
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close).classList.remove('open');
  }));
  el.settingsModal.addEventListener('click', (ev) => { if (ev.target === el.settingsModal) el.settingsModal.classList.remove('open'); });

  // Drag and drop anywhere.
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    el.dropOverlay.classList.add('open');
  });
  window.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) el.dropOverlay.classList.remove('open'); });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    el.dropOverlay.classList.remove('open');
    const file = ev.dataTransfer?.files?.[0];
    if (file) ingestFile(file);
  });
  el.dropzone?.addEventListener('click', (ev) => { if (ev.target === el.dropzone) pickFile(); });
}

async function loadSample() {
  const deck = analyzeDeck(parseText(SAMPLE_LESSON));
  const existing = state.lessons.find(l => l.name === 'Sample lesson');
  if (existing) { await openLesson(existing.id); return; }
  await createLessonFromDeck(deck, { name: 'Sample lesson', fileName: 'sample.md' });
}

/* ---------------------------------------------------------------- boot --- */

async function boot() {
  if (params.has('nostore')) disableStorage('storage disabled for this run');
  applyTheme(state.settings.theme);
  refreshWelcome();
  wire();
  autoGrow();
  // The brand mark returns to the home screen (and offers the file picker there).
  document.querySelector('.brand')?.addEventListener('click', () => {
    showEmptyState(true);
    closeDrawers();
  });
  document.querySelector('.brand')?.setAttribute('role', 'button');
  document.querySelector('.brand')?.setAttribute('title', 'Home');
  await refreshLibrary();
  if (params.has('demo')) {
    // ?demo=1 opens the built-in sample lesson — handy for screenshots and first looks.
    await loadSample();
  } else if (state.lessons[0] && !params.has('fresh')) {
    await openLesson(state.lessons[0].id);
  } else {
    showEmptyState(true);
    renderHeader();
  }
  syncChips();
  el.input.focus();
}

boot().catch(err => {
  console.error(err);
  notice(`Cyzie failed to start: ${err.message}`, 'bad');
});

// Flush the session when the tab is hidden or closed, so nothing is lost mid-lesson.
window.addEventListener('pagehide', () => { if (state.lesson) { try { persistLesson(); } catch { /* ignore */ } } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistSoon(); });

// Expose a small surface for the in-browser test harness.
window.CyzieApp = {
  state,
  send,
  ingestFile,
  createLessonFromDeck,
  openLesson,
  loadSample,
  renderContext,
  snapshotSession,
  restoreSession,
  persistLesson,
  exportStudySheet,
  buildStudySheet,
  modules: { lookupTerm },
  tutor: { respond, start, classify, createSession },
};

/* Cyzie — app controller: files in, lesson out, chat in the middle. */

import { parsePptx, parseDocx } from './parse-pptx.js';
import { parsePdf, renderPdfPage } from './parse-pdf.js';
import { parseText } from './parse-text.js';
import { analyzeDeck, lookupTerm } from './extract.js';
import { createSession, start, respond, classify } from './tutor.js';
import { renderMarkdown, stripMarkdown } from './markdown.js';
import { SAMPLE_LESSON } from './sample.js';
import {
  saveLesson, listLessons, getLesson, deleteLesson, clearAll,
  serializeDeck, reviveDeck, saveTranscript, getTranscript, loadSettings, saveSettings,
} from './store.js';
import { truncate, pct } from './nlp.js';

const $ = sel => document.querySelector(sel);
const el = {
  sidebar: $('#sidebar'), context: $('#context'), scrim: $('#scrim'),
  messages: $('#messages'), chat: $('#chat'), emptyState: $('#emptyState'),
  lessonList: $('#lessonList'), libraryEmpty: $('#libraryEmpty'),
  lessonTitle: $('#lessonTitle'), slideIndicator: $('#slideIndicator'), progressText: $('#progressText'),
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
  busy: false,
  typing: false,
};

/* --------------------------------------------------------------- theme --- */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.querySelector('[data-role="theme"]');
  if (btn) btn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lesson-item';
    btn.setAttribute('aria-current', state.lesson?.id === lesson.id ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'li-name';
    name.textContent = lesson.name;
    const ring = document.createElement('span');
    ring.className = 'li-ring';
    const done = lesson.progress?.visited || 0;
    ring.textContent = lesson.progress?.slides ? `${done}/${lesson.progress.slides}` : '';
    const meta = document.createElement('span');
    meta.className = 'li-meta';
    meta.textContent = [lesson.progress?.label, lesson.stats?.slides ? `${lesson.stats.slides} slides` : '', lesson.fileName || '']
      .filter(Boolean).join(' · ');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip';
    del.textContent = '×';
    del.title = 'Delete this lesson';
    del.style.gridColumn = '2';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!window.confirm(`Delete “${lesson.name}” and its transcript?`)) return;
      await deleteLesson(lesson.id);
      if (state.lesson?.id === lesson.id) { state.lesson = null; el.messages.innerHTML = ''; showEmptyState(true); }
      await refreshLibrary();
    });
    btn.append(name, ring, meta, del);
    btn.addEventListener('click', () => openLesson(lesson.id));
    li.appendChild(btn);
    el.lessonList.appendChild(li);
  }
}

function showEmptyState(show) {
  el.emptyState.hidden = !show;
  // The messages list is a flex container, so the hidden attribute alone is not enough.
  el.messages.style.display = show ? 'none' : 'flex';
}

/* -------------------------------------------------------------- header --- */

function teachableSlides() {
  return state.lesson?.deck.slides.filter(s => !s.skipQuestions) || [];
}

function renderHeader() {
  const lesson = state.lesson;
  if (!lesson) {
    el.lessonTitle.textContent = 'No lesson loaded';
    el.slideIndicator.textContent = 'Upload a file to begin';
    el.progressText.textContent = '';
    el.progressFill.style.width = '0%';
    return;
  }
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
  if (!lesson) return;
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

  // Rendered page image for PDFs (the original bytes are kept locally for this).
  const cacheKey = slide.index;
  const cached = lesson.previewCache?.get(cacheKey);
  if (lesson.blob && lesson.deck.kind === 'pdf') {
    if (cached) {
      showPreview(cached);
    } else {
      el.slideCanvasWrap.hidden = true;
      renderPdfPage(lesson.buffer, slide.index, { scale: 1.25 }).then(url => {
        lesson.previewCache.set(cacheKey, url);
        if (state.lesson?.session?.slide === slide.index) showPreview(url);
      }).catch(() => { el.slideCanvasWrap.hidden = true; });
    }
  } else {
    el.slideCanvasWrap.hidden = true;
  }

  // Question progress for this slide.
  el.qdots.innerHTML = '';
  const plan = session.plan.find(p => p.slide === slide.index);
  const stats = session.perSlide[slide.index] || { asked: 0, correct: 0, partial: 0, incorrect: 0 };
  const questions = plan?.questions || [];
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
  el.sendBtn.disabled = false;
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
  const plan = (session.plan || []).flatMap(p => p.questions);
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
  if (!file) return;
  if (file.size > MAX_FILE) {
    notice(`That file is ${(file.size / 1048576).toFixed(1)} MB. Cyzie works with files up to ${MAX_FILE / 1048576} MB.`, 'bad');
    return;
  }
  const name = file.name || 'lesson';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!['pdf', 'pptx', 'docx', 'txt', 'md', 'markdown'].includes(ext)) {
    notice(`${name}: Cyzie reads .pptx, .pdf, .docx, .txt and .md files. (Old .ppt and .doc formats need to be saved again in the newer format.)`, 'bad');
    return;
  }

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
  } catch (err) {
    console.error(err);
    progressLine.remove();
    notice(`${name}: ${err.message}. If the file came from Google Slides, export it as .pptx or PDF first.`, 'bad');
  }
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
    const li = addAssistantShell(m.kind);
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

  const plan = session.plan.find(p => p.slide === session.slide);
  const pool = plan?.questions?.length ? plan.questions : [];
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
  if (!lesson) return;
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
  el.themeBtn.addEventListener('click', toggleTheme);
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
  applyTheme(state.settings.theme);
  wire();
  autoGrow();
  await refreshLibrary();
  const recent = state.lessons[0];
  if (recent) {
    await openLesson(recent.id);
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

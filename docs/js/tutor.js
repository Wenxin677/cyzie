/* Cyzie's tutoring engine — the conversation itself.
   Pure state machine: no DOM, no network, everything read from the uploaded deck. */

import { buildIndex, search, answerQuestion, rankSlides } from './retrieve.js';
import { buildQuestions, buildLessonPlan } from './questions.js';
import { gradeAnswer, scoreBand } from './grade.js';
import { lookupTerm, estimateQuestions, looksLikeCode } from './extract.js';
import { keyStems, contentWords, words, normalize, truncate, pct, pick, clamp } from './nlp.js';

/* ------------------------------------------------------------ helpers ---- */

function seededRandom(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < String(seedStr).length; i++) {
    h ^= String(seedStr).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRAISE = ['Exactly.', 'Right — that is it.', 'Spot on.', 'Correct.', 'Yes, well put.', 'Nailed it.'];
const PARTIAL_LEAD = ['You are on the right track.', 'Close — part of that lands.', 'Halfway there.', 'Partly right.'];
const WRONG_LEAD = ['Not quite.', 'That is not it yet.', 'Have another look at this one.', 'Not this time.'];

function msg(text, extra = {}) {
  return { role: 'cyzie', text, at: Date.now(), ...extra };
}

function stripMd(s = '') {
  return normalize(String(s).replace(/[*_`>#]/g, ''));
}

/* ------------------------------------------------------------- session --- */

export function createSession(deck, opts = {}) {
  const density = opts.density || 'standard';
  const seed = opts.seed || `cyzie-${deck.deckTitle}`;
  const index = buildIndex(deck);
  const plan = opts.plan || buildLessonPlan(deck, { density, seed });
  const first = deck.slides.find(s => !s.skipQuestions) || deck.slides[0];
  const state = {
    version: 1,
    deckTitle: deck.deckTitle,
    density,
    seed,
    learner: (opts.learner || '').trim(),
    index,
    plan,
    slide: first ? first.index : 1,
    phase: 'intro',
    awaiting: null,
    queue: [],
    qCursor: 0,
    current: null,
    retry: null,
    missed: [],
    perSlide: {},
    stats: { answered: 0, correct: 0, partial: 0, incorrect: 0, skipped: 0, streak: 0, bestStreak: 0 },
    seenSlides: [],
    startedAt: Date.now(),
    finishedAt: null,
    rng: seededRandom(seed),
    slideOrder: deck.slides.map(s => s.index),
  };
  for (const s of deck.slides) {
    state.perSlide[s.index] = { asked: 0, correct: 0, partial: 0, incorrect: 0, attempts: 0, wrong: 0 };
  }
  return state;
}

function slideOf(state, n) {
  return state.index.deck.slides.find(s => s.index === n);
}

function slideStats(state, n) {
  return state.perSlide[n] || (state.perSlide[n] = { asked: 0, correct: 0, partial: 0, incorrect: 0, attempts: 0, wrong: 0 });
}

function nameTag(state) {
  return state.learner ? ` ${state.learner}` : '';
}

function nextSlideNumber(state, from) {
  const order = state.slideOrder;
  const teachable = order.filter(n => !slideOf(state, n)?.skipQuestions);
  const pool = teachable.length ? teachable : order;
  const idx = pool.indexOf(from);
  for (let i = idx + 1; i < pool.length; i++) if (pool[i] > from) return pool[i];
  return null;
}

function prevSlideNumber(state, from) {
  const teachable = state.slideOrder.filter(n => !slideOf(state, n)?.skipQuestions && n < from);
  return teachable.length ? teachable[teachable.length - 1] : null;
}

/* ----------------------------------------------------------- messages ---- */

function overviewMessage(state) {
  const deck = state.index.deck;
  const teachable = deck.slides.filter(s => !s.skipQuestions);
  const topTerms = [...deck.glossary.values()].filter(t => t.definition).slice(0, 5).map(t => t.term);
  const lines = [];
  lines.push(`**${deck.deckTitle}**`);
  lines.push(`${deck.slides.length} slides — I can work through ${teachable.length} of them with you.`);
  if (topTerms.length) lines.push(`Key ideas I found: ${topTerms.join(', ')}.`);
  lines.push('');
  lines.push('How it works: I explain one slide, then ask you questions about it. Ask me anything at any time — "what is machine learning?", "summarise slide 4", "give me a hint". Type **help** to see every command.');
  return lines.join('\n');
}

function slideIntro(state, slide) {
  const lines = [`### Slide ${slide.index} — ${slide.title}`];
  const points = [];
  for (const line of slide.lines) {
    if (line.text === slide.title) continue;
    if (line.text.toLowerCase() === slide.title.toLowerCase()) continue;
    if (words(line.text).length < 3) continue;
    points.push(line);
    if (points.length >= 5) break;
  }
  if (points.length) {
    lines.push(points.map(p => `- ${truncate(stripMd(lineClean(p)), 165)}`).join('\n'));
  } else if (slide.terms.length) {
    lines.push(slide.terms.slice(0, 4).map(t => `- **${t.term}**${t.definition ? ` — ${truncate(stripMd(t.definition), 120)}` : ''}`).join('\n'));
  } else if (slide.codeHeavy) {
    lines.push('_This slide is mostly code._');
  } else {
    lines.push('_There is little extractable text on this slide — it looks like a picture or diagram._');
  }
  if (slide.notes) lines.push(`\n> **Speaker notes:** ${truncate(stripMd(slide.notes), 220)}`);
  return lines.join('\n');
}

function lineClean(line) {
  return line.text.replace(/^[-•\u25cf\u25aa]\s*/, '');
}

function keyTakeaways(slide) {
  const points = slide.facts.slice(0, 3).map(f => truncate(stripMd(f.text), 150));
  return points;
}

function askMessage(state) {
  const q = state.current;
  if (!q) return null;
  const lines = [];
  const prefix = q.type === 'gist_short' ? '' : '';
  lines.push(`${prefix}${q.prompt}`);
  let text = lines.join('\n');
  if (q.choices && q.choices.length) {
    const letters = 'ABCDEFGH';
    text += '\n\n' + q.choices.map((c, i) => `**${letters[i]}.** ${stripMd(c.text)}`).join('\n');
    text += '\n\n_' + `Reply with a letter (or the words). Question ${q.index} of ${q.total} on this slide._`;
  } else {
    text += '\n\n_' + `Question ${q.index} of ${q.total} on this slide._`;
  }
  return msg(text, {
    kind: 'question',
    questionId: q.id,
    questionType: q.type,
    slide: q.slide,
    choices: q.choices && q.choices.length ? q.choices.map(c => ({ text: c.text, correct: !!c.correct })) : null,
    chips: questionsChips(state),
  });
}

function questionsChips(state) {
  const chips = [
    { label: 'Hint', send: 'hint' },
    { label: 'Show answer', send: 'show answer' },
    { label: 'Skip', send: 'skip' },
  ];
  if (state.slide > 1) chips.push({ label: 'Explain this slide again', send: 'repeat' });
  return chips;
}

function feedbackMessage(state, q, graded) {
  const { verdict, score } = graded;
  const source = q.sourceLine ? `\n\n> ${truncate(stripMd(q.sourceLine), 220)}` : '';
  if (verdict === 'correct') {
    const praise = pick(PRAISE, state.rng());
    return msg(`${praise} ${shortWhy(q)}${source}`, { kind: 'feedback', tone: 'good', slide: q.slide });
  }
  if (verdict === 'partial') {
    const missing = (graded.missing || []).slice(0, 3).map(s => `**${s}**`).join(', ');
    return msg(`${pick(PARTIAL_LEAD, state.rng())} ${missing ? `You have most of it, but the slide also stresses ${missing}.` : 'Add one more detail from the slide.'}${source}`, {
      kind: 'feedback', tone: 'partial', slide: q.slide,
      chips: [{ label: 'Full answer', send: 'show answer' }, { label: 'Next question', send: 'next' }],
    });
  }
  if (verdict === 'unsure') {
    return msg(`Take your time — ${graded.note || 'give it a try in your own words.'} Type **skip** if you would rather I show you.`, { kind: 'feedback', tone: 'neutral' });
  }
  return msg(`${pick(WRONG_LEAD, state.rng())} ${graded.note ? graded.note + ' ' : ''}Have one more try, or type **show answer**.`, {
    kind: 'feedback', tone: 'bad', slide: q.slide,
    chips: [{ label: 'Hint', send: 'hint' }, { label: 'Show answer', send: 'show answer' }],
  });
}

function shortWhy(q) {
  if (q.type === 'true_false') return q.answer.text === 'true' ? 'That statement is on the slide as written.' : 'Good judgement — that one was altered.';
  if (q.type === 'list_recall') return 'You covered the list.';
  if (q.type === 'define_short' || q.type === 'gist_short') return 'That is the idea.';
  return 'That is the one.';
}

function revealAnswerMessage(state, q) {
  const answer = q.answer.text;
  const body = q.type === 'list_recall'
    ? `Here is the full list:\n${answer}`
    : `**${answer}**`;
  return msg(`${body}\n\n${q.explanation || ''}`, { kind: 'answer', slide: q.slide, chips: [{ label: 'Next question', send: 'next' }] });
}

function hintFor(q) {
  const answerWords = words(q.answer.text);
  const stemHint = answerWords.slice(0, 3).join(' ');
  if (q.choices && q.choices.length) {
    const correctIdx = q.choices.findIndex(c => c.correct);
    const letter = 'ABCDEFGH'[correctIdx];
    const wrongLetters = q.choices.map((c, i) => (c.correct ? null : 'ABCDEFGH'[i])).filter(Boolean);
    const eliminate = wrongLetters.slice(0, Math.max(1, wrongLetters.length - 1)).join(', ');
    return `It is not ${eliminate}. That leaves ${letter}.`;
  }
  if (q.type === 'true_false') return `Check the wording against slide ${q.slide} — is every part of that statement there?`;
  if (q.type === 'list_recall') return `You need ${q.answer.target || 2} items. Start from the top of the slide.`;
  if (q.type === 'cloze_type') return `It starts with “${stemHint}” and has ${answerWords.length} word${answerWords.length === 1 ? '' : 's'}.`;
  if (q.type === 'define_short' || q.type === 'gist_short') {
    const kw = (q.answer.keywords || []).slice(0, 3).join(', ');
    return kw ? `Work these ideas in: ${kw}.` : `Use the slide's own wording.`;
  }
  return `Look again at slide ${q.slide}.`;
}

function slideSummaryMessage(state, slide) {
  const st = slideStats(state, slide.index);
  const band = scoreBand(st.asked ? st.correct / Math.max(1, st.asked) : 0);
  const takeaways = keyTakeaways(slide);
  const lines = [`### Slide ${slide.index} done — ${slide.title}`];
  if (takeaways.length) lines.push(takeaways.map(t => `- ${t}`).join('\n'));
  lines.push('');
  const scoreLine = st.attempts
    ? `You answered ${st.asked} question${st.asked === 1 ? '' : 's'} here: ${st.correct} correct, ${st.partial} partly right, ${st.incorrect} missed.`
    : 'No questions on this slide.';
  lines.push(scoreLine + (band === 'weak' || band === 'shaky' ? ' Worth a second pass later.' : ''));
  return msg(lines.join('\n'), { kind: 'summary', slide: slide.index });
}

function lessonSummaryMessage(state) {
  const deck = state.index.deck;
  const s = state.stats;
  const total = s.answered || 1;
  const accuracy = s.correct / total;
  const rows = [];
  for (const slide of deck.slides) {
    const st = slideStats(state, slide.index);
    if (!st.asked) continue;
    const p = st.correct / st.asked;
    rows.push({ slide: slide.index, title: slide.title, pct: pct(p), band: scoreBand(p), wrong: st.wrong });
  }
  rows.sort((a, b) => a.pct - b.pct);
  const weak = rows.filter(r => r.pct < 65).slice(0, 4);
  const lines = ['### Where you stand'];
  lines.push(`${s.answered} questions answered — **${pct(accuracy)}% correct**, ${s.partial} partly right, ${s.incorrect} missed. Longest streak: ${s.bestStreak}.`);
  if (weak.length) {
    lines.push('\nSlides to revisit:');
    lines.push(weak.map(w => `- **Slide ${w.slide}** — ${truncate(w.title, 60)} (${w.pct}%)`).join('\n'));
  } else if (rows.length) lines.push('\nNothing scored below 65% — this is solid coverage.');
  const glossaryCount = [...deck.glossary.values()].filter(t => t.definition).length;
  if (glossaryCount) lines.push(`\nI built ${glossaryCount} definition${glossaryCount === 1 ? '' : 's'} from this deck — ask for the “glossary” any time.`);
  return msg(lines.join('\n'), {
    kind: 'summary',
    chips: weak.length
      ? [{ label: `Review slide ${weak[0].slide}`, send: `go to slide ${weak[0].slide}` }, { label: 'Quiz me on my misses', send: 'quiz me on my misses' }]
      : [{ label: 'Quiz me again', send: 'quiz me' }, { label: 'Glossary', send: 'glossary' }],
  });
}

function termCard(state, term, { includeSlide = true } = {}) {
  const lines = [`**${term.term}**${includeSlide ? `  ·  slide ${term.slide}` : ''}`];
  if (term.definition) lines.push(term.definition);
  else lines.push('_The deck uses this term without defining it._');
  return lines.join('\n\n');
}

function passageAnswerMessage(state, result, query) {
  const hits = result.hits.slice(0, 3);
  const lines = [];
  lines.push(`Here is what the lesson says about **${truncate(stripMd(query), 80)}**:`);
  lines.push('');
  for (const h of hits) {
    const slide = slideOf(state, h.slide);
    lines.push(`**Slide ${h.slide}${slide ? ` — ${truncate(slide.title, 56)}` : ''}**`);
    lines.push(`> ${truncate(stripMd(h.text), 300)}`);
    lines.push('');
  }
  lines.push(`_Sources: slide${hits.length === 1 ? '' : 's'} ${hits.map(h => h.slide).join(', ')}._`);
  return msg(lines.join('\n'), {
    kind: 'answer',
    sources: hits.map(h => ({ slide: h.slide, title: slideOf(state, h.slide)?.title || '', snippet: truncate(h.text, 180) })),
    chips: [
      { label: 'Explain simpler', send: 'explain that simpler' },
      { label: 'Quiz me on this', send: `quiz me on ${query}` },
    ],
  });
}

function noAnswerMessage(state, result, query) {
  const closest = result.closest.filter(c => c.title);
  const lines = [`I could not find **${truncate(stripMd(query), 70)}** anywhere in this lesson — I only answer from the file you uploaded.`];
  if (closest.length) {
    lines.push('');
    lines.push(`Closest pages: ${closest.map(c => `slide ${c.slide} (${truncate(stripMd(c.title), 40)})`).join(', ')}. Want me to open one?`);
  }
  return msg(lines.join('\n'), {
    kind: 'answer',
    chips: closest.slice(0, 2).map(c => ({ label: `Open slide ${c.slide}`, send: `go to slide ${c.slide}` })),
  });
}

/* ------------------------------------------------------------ intents ---- */

const INTENT_PATTERNS = [
  ['help', /^(?:help|\/help|commands?|what can you do|how do (?:i|you) use (?:this|you))\b/i],
  ['next', /^(?:next(?:\s+(?:question|slide))?|continue|go on|move on|proceed|forward|\/next|carry on|and then)\b[.!]?$/i],
  ['back', /^(?:back|previous|last slide|go back|prev)\b/i],
  ['repeat', /^(?:repeat|again|say (?:that|it) again|re-?read|explain (?:this|it) again|read (?:this|it) again)\b/i],
  ['skip', /^(?:skip(?:\s+(?:this|it|question))?|\/skip|pass|no idea|i (?:don'?t|do not) know|dunno|idk|not sure|i give up)\b/i],
  ['hint', /^(?:hint|clue|a hint|help me(?: a bit)?|\/hint)\b/i],
  ['reveal', /^(?:answer|show (?:me )?(?:the )?answer|reveal|tell me(?: the answer)?|give up|what'?s the answer|\/answer)\b/i],
  ['summary', /^(?:summary|summar(?:y|ise|ize)|sum up|recap|tl;?dr|review|what did we (?:cover|do)|how far)\b/i],
  ['quiz', /^(?:quiz(?: me)?|test me|more questions|practice|ask me more|give me a (?:test|quiz)|exam(?:ine)? me)\b/i],
  ['glossary', /^(?:glossary|terms|vocabulary|key ?terms|list (?:the )?(?:terms|vocabulary|definitions)|all (?:the )?terms)\b/i],
  ['progress', /^(?:progress|score|my score|how am i doing|stats|report|how did i do|results)\b/i],
  ['stop', /^(?:stop|pause|that'?s (?:enough|all)|quit|end (?:the )?(?:lesson|session)|bye|goodbye|i'?m done|done for now)\b/i],
  ['restart', /^(?:restart|start over|reset|from the (?:beginning|start))\b/i],
  ['thanks', /^(?:thanks|thank you|thx|ty|appreciate it)\b/i],
  ['greeting', /^(?:hi|hello|hey|yo|good (?:morning|afternoon|evening))\b/i],
  ['simpler', /(?:in simple(?:r)? terms|simpl(?:er|ify|ified)|explain (?:it )?(?:more )?simpl|i (?:don'?t|dont|do not) (?:understand|get it|get)|confus|too (?:hard|complex|fast)|break (?:it|this) down|baby ?steps)/i],
  ['example', /(?:^|\b)(?:give me an example|for example|an example|illustrate|show me an example|example of (?:this|it))/i],
  ['detail', /(?:more detail|elaborate|tell me more|go deeper|expand on (?:that|this)|more on that)/i],
  ['harder', /(?:harder|more difficult|challenge me|tough(?:er)? questions)/i],
  ['easier', /(?:easier|simpler questions|too hard|gentler)/i],
];

const JUMP_RE = /(?:\bgo to\b|\bjump to\b|\bskip to\b|\bopen\b)?\s*\b(?:slide|page|part)\s*(?:number\s*)?#?(\d{1,3})\b/i;
const WHERE_RE = /^where\s+(?:is|are|does|do|can i find|is it)\b/i;
const DEFINE_RE = /^(?:what(?:'s| is| are| does| do)|who(?:'s| is| are)|define|explain|describe|tell me about|meaning of|what about|why (?:is|are|does))\b/i;

export function classify(state, text) {
  const t = normalize(text);
  if (!t) return { intent: 'empty' };
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(t)) {
      if ((intent === 'next' || intent === 'skip') && state.awaiting === 'answer' && state.current?.type === 'true_false' && /^(y|yes|n|no|true|false)$/i.test(t)) continue;
      return { intent };
    }
  }
  const jump = t.match(JUMP_RE);
  if (jump && !/^what|^where|^why|^how/i.test(t)) {
    const n = parseInt(jump[1], 10);
    if (n >= 1) return { intent: 'jump', slide: n };
  }
  if (WHERE_RE.test(t)) return { intent: 'where', query: t };
  if (DEFINE_RE.test(t)) return { intent: 'define', query: t };
  if (t.length > 180) return { intent: 'answer' };
  if (/^(?:quiz me on|test me on)\s+(.+)/i.test(t)) return { intent: 'quiz_topic', query: t.replace(/^.*?\bon\s+/i, '') };
  if (state.awaiting === 'answer') return { intent: 'answer' };
  if (String(text).trim().startsWith('/')) return { intent: 'unknown' };
  return { intent: 'question', query: t };
}

/* -------------------------------------------------------------- flows ---- */

function startSlide(state, n, messages) {
  const slide = slideOf(state, n);
  if (!slide) return messages;
  state.slide = n;
  state.seenSlides.push(n);
  state.retry = null;
  const plan = state.plan.find(p => p.slide === n);
  state.queue = (plan && plan.questions ? plan.questions.slice() : buildQuestions(state.index.deck, slide, { count: 5, seed: state.seed }));
  state.qCursor = 0;
  state.current = null;
  state.awaiting = null;
  messages.push(msg(slideIntro(state, slide), { kind: 'teach', slide: n }));
  if (!state.queue.length) {
    messages.push(msg(slide.skipQuestions
      ? 'There is nothing quizzable on this slide — I will move us on.'
      : 'I could not build reliable questions from this slide.', { kind: 'note', slide: n }));
    state.phase = 'slideSummary';
    state.awaiting = 'continue';
    messages.push(msg('Say **next** when you are ready for the following slide.', {
      chips: [{ label: 'Next slide', send: 'next' }, { label: 'Ask about this slide', send: `what is on slide ${n}?` }],
    }));
    return messages;
  }
  state.phase = 'question';
  state.current = state.queue[0];
  state.qCursor = 0;
  state.awaiting = 'answer';
  messages.push(askMessage(state));
  return messages;
}

function advanceQuestion(state, messages) {
  state.retry = null;
  state.qCursor = (state.current ? state.queue.findIndex(q => q.id === state.current.id) : state.qCursor) + 1;
  if (state.qCursor >= state.queue.length) {
    const slide = slideOf(state, state.slide);
    state.phase = 'slideSummary';
    state.current = null;
    state.awaiting = 'continue';
    messages.push(slideSummaryMessage(state, slide));
    const next = nextSlideNumber(state, state.slide);
    if (next == null) {
      state.phase = 'done';
      state.awaiting = null;
      messages.push(lessonSummaryMessage(state));
      state.finishedAt = Date.now();
      messages.push(msg('That is the whole lesson. You can revisit any slide, ask me questions, or say **restart** to run it again.', {
        chips: [{ label: 'Quiz me again', send: 'quiz me' }, { label: 'Glossary', send: 'glossary' }],
      }));
    } else {
      const nextSlide = slideOf(state, next);
      messages.push(msg(`Ready for slide ${next} — **${truncate(nextSlide.title, 70)}**?`, {
        chips: [{ label: `Slide ${next}`, send: 'next' }, { label: 'Ask a question first', send: 'what should I remember from this slide?' }],
      }));
    }
    return messages;
  }
  state.current = state.queue[state.qCursor];
  state.phase = 'question';
  state.awaiting = 'answer';
  messages.push(askMessage(state));
  return messages;
}

function recordAttempt(state, q, graded) {
  const st = slideStats(state, q.slide);
  const first = !state.retry || state.retry.questionId !== q.id;
  if (first) {
    st.asked++;
    state.stats.answered++;
  }
  st.attempts++;
  if (graded.verdict === 'correct') {
    st.correct++;
    state.stats.correct++;
    state.stats.streak++;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.stats.streak);
  } else if (graded.verdict === 'partial') {
    st.partial++;
    state.stats.partial++;
    state.stats.streak = 0;
  } else if (graded.verdict === 'incorrect') {
    st.incorrect++;
    state.stats.incorrect++;
    st.wrong++;
    state.stats.streak = 0;
  } else if (graded.verdict === 'unsure') {
    if (graded.note !== 'idle') st.wrong++;
  }
}

function handleAnswer(state, text, messages) {
  const q = state.current;
  if (!q) {
    state.awaiting = 'continue';
    messages.push(msg(overviewMessage(state)));
    return messages;
  }
  const graded = gradeAnswer(q, text);
  if (graded.verdict === 'unsure' && graded.note === 'idle') {
    // Student said "I don't know" — this is a skip, not a wrong answer.
    return handleSkip(state, messages);
  }
  if (graded.verdict === 'unsure') {
    messages.push(feedbackMessage(state, q, graded));
    state.awaiting = 'answer';
    return messages;
  }
  const isRetry = state.retry && state.retry.questionId === q.id;
  recordAttempt(state, q, graded);
  messages.push(feedbackMessage(state, q, graded));

  if (graded.verdict === 'correct') {
    state.retry = null;
    return advanceQuestion(state, messages);
  }
  if (!isRetry && graded.verdict === 'incorrect') {
    state.retry = { questionId: q.id, hints: 1 };
    messages.push(msg('Take one more shot at it.', { kind: 'note', chips: [{ label: 'Hint', send: 'hint' }, { label: 'Show answer', send: 'show answer' }] }));
    state.awaiting = 'answer';
    return messages;
  }
  if (graded.verdict === 'partial' && !isRetry) {
    state.retry = { questionId: q.id, hints: 1 };
    messages.push(msg('Try to add the missing pieces — or say **next** to move on.', { kind: 'note' }));
    state.awaiting = 'answer';
    return messages;
  }
  // Second miss: reveal, then move on.
  state.missed.push(q.id);
  state.retry = null;
  messages.push(revealAnswerMessage(state, q));
  return advanceQuestion(state, messages);
}

function handleSkip(state, messages) {
  const q = state.current;
  if (!q) {
    messages.push(msg('Nothing is pending — here is where we are.', { kind: 'note' }));
    messages.push(overviewMessage(state));
    return messages;
  }
  slideStats(state, q.slide).wrong++;
  state.stats.skipped++;
  state.missed.push(q.id);
  messages.push(revealAnswerMessage(state, q));
  return advanceQuestion(state, messages);
}

function handleDefine(state, query, messages) {
  const deck = state.index.deck;
  const term = lookupTerm(deck.glossary, query);
  if (term && term.definition) {
    const lines = [`**${term.term}** — slide ${term.slide}`, '', term.definition];
    if (term.sourceLine && !term.sourceLine.toLowerCase().includes(term.definition.toLowerCase().slice(0, 30))) {
      lines.push('', `> ${truncate(stripMd(term.sourceLine), 240)}`);
    }
    messages.push(msg(lines.join('\n'), {
      kind: 'answer', slide: term.slide,
      chips: [
        { label: 'Explain simpler', send: `explain ${term.term} simpler` },
        { label: 'Open that slide', send: `go to slide ${term.slide}` },
        { label: 'Quiz me on it', send: 'quiz me' },
      ],
    }));
    return messages;
  }
  const result = answerQuestion(deck, state.index, query, { lookupTerm: q => lookupTerm(deck.glossary, q) });
  if (result.kind === 'passage' && result.hits.length) messages.push(passageAnswerMessage(state, result, query));
  else messages.push(noAnswerMessage(state, result, query));
  return messages;
}

function handleSimpler(state, text, messages) {
  const slide = slideOf(state, state.slide);
  const target = state.current?.focus || slide?.title;
  const term = lookupTerm(state.index.deck.glossary, text) || (target ? lookupTerm(state.index.deck.glossary, target) : null);
  if (term && term.definition) {
    const clauses = term.definition.split(/,|;|\band\b|\bwhich\b/).map(s => stripMd(s).trim()).filter(s => words(s).length >= 2).slice(0, 4);
    const lines = [`Let us take **${term.term}** apart.`];
    if (clauses.length > 1) lines.push(clauses.map((c, i) => `${i + 1}. ${c}`).join('\n'));
    else lines.push(term.definition);
    const others = [...state.index.deck.glossary.values()].filter(t => t.slide === term.slide && t.definition && t.term !== term.term).slice(0, 3);
    if (others.length) lines.push(`\nOn the same slide: ${others.map(t => `**${t.term}**`).join(', ')}.`);
    lines.push(`\n_All of that is from slide ${term.slide}. Tell me which line is unclear and I will unpack just that one._`);
    messages.push(msg(lines.join('\n'), { kind: 'answer', slide: term.slide }));
    return messages;
  }
  if (slide) {
    const lines = [`Slide ${slide.index} in plainer pieces:`];
    const short = slide.lines.filter(l => words(l.text) >= 3).slice(0, 5).map((l, i) => `${i + 1}. ${truncate(stripMd(lineClean(l)), 130)}`);
    if (short.length) lines.push(short.join('\n'));
    else lines.push('_This slide has very little text to unpack._');
    if (slide.terms.length) lines.push(`\nThe page's key terms: ${slide.terms.slice(0, 5).map(t => `**${t.term}**`).join(', ')}.`);
    lines.push('\nAsk me about any single line and I will go slower on it.');
    messages.push(msg(lines.join('\n'), { kind: 'answer', slide: slide.index }));
    return messages;
  }
  messages.push(msg('Tell me which slide or term and I will break it down.', { kind: 'note' }));
  return messages;
}

function handleExample(state, messages) {
  const slide = slideOf(state, state.slide);
  const term = state.current?.focus && lookupTerm(state.index.deck.glossary, state.current.focus);
  const lines = [];
  if (term && term.definition) {
    const elsewhere = search(state.index, term.term, { limit: 6, perSlide: 1 })
      .filter(h => h.slide !== term.slide && /example|e\.g|for instance|such as|:/.test(h.text));
    lines.push(`Examples of **${term.term}** in this lesson:`);
    if (elsewhere.length) lines.push(elsewhere.slice(0, 3).map(h => `- Slide ${h.slide}: ${truncate(stripMd(h.text), 160)}`).join('\n'));
    else lines.push('- The deck does not give a separate example — the definition on slide ' + term.slide + ' is all we have.');
  } else if (slide) {
    const examples = slide.lines.filter(l => /^(example|e\.g|for example|for instance|such as)\b/i.test(l.text) || /\b(e\.g|for example|for instance)\b/i.test(l.text));
    lines.push(`Examples on slide ${slide.index}:`);
    if (examples.length) lines.push(examples.slice(0, 4).map(e => `- ${truncate(stripMd(lineClean(e)), 170)}`).join('\n'));
    else lines.push('- This slide does not give an example. I cannot invent one — but the slide below or above it might; try “where is ' + truncate(slide.title, 40) + ' mentioned?”');
  }
  messages.push(msg(lines.join('\n'), { kind: 'answer', slide: slide?.index }));
  return messages;
}

function handleGlossary(state, messages) {
  const terms = [...state.index.deck.glossary.values()].filter(t => t.definition);
  if (!terms.length) {
    messages.push(msg('This deck does not spell out any definitions, so I have no glossary for it.', { kind: 'note' }));
    return messages;
  }
  const shown = terms.slice(0, 10);
  const lines = [`**Glossary — ${terms.length} defined terms**`, ''];
  lines.push(shown.map(t => `- **${t.term}** (slide ${t.slide}) — ${truncate(stripMd(t.definition), 120)}`).join('\n'));
  if (terms.length > shown.length) lines.push(`\n…and ${terms.length - shown.length} more. Ask for any one by name.`);
  messages.push(msg(lines.join('\n'), { kind: 'answer', chips: [{ label: 'Quiz me on these', send: 'quiz me' }] }));
  return messages;
}

function handleQuiz(state, messages, { topic = null } = {}) {
  const deck = state.index.deck;
  if (topic) {
    const ranked = rankSlides(state.index, topic);
    if (ranked.length) {
      const n = ranked[0].slide;
      const slide = slideOf(state, n);
      const qs = buildQuestions(deck, slide, { count: 3, seed: `${state.seed}|topic|${topic}` });
      if (qs.length) {
        state.slide = n;
        state.queue = qs;
        state.qCursor = 0;
        state.current = qs[0];
        state.phase = 'question';
        state.awaiting = 'answer';
        messages.push(msg(`Quick check on **${truncate(stripMd(topic), 50)}** — that lives on slide ${n}, _${truncate(slide.title, 60)}_.`, { kind: 'note' }));
        messages.push(askMessage(state));
        return messages;
      }
    }
    messages.push(msg(`I could not build questions about “${truncate(stripMd(topic), 40)}” from this deck.`, { kind: 'note' }));
    return messages;
  }

  const missedPool = [];
  for (const slide of deck.slides) {
    const st = slideStats(state, slide.index);
    if (st.wrong > 0 && !slide.skipQuestions) {
      const extra = buildQuestions(deck, slide, { count: 2, seed: `${state.seed}|revisit|${slide.index}` });
      for (const q of extra) if (!state.missed.includes(q.id)) missedPool.push(q);
    }
  }
  const currentSlide = slideOf(state, state.slide);
  const fresh = state.plan.find(p => p.slide === state.slide)?.questions || [];
  const unseen = fresh.filter(q => !state.queue.includes(q));
  const pool = missedPool.length ? missedPool : (unseen.length ? unseen : buildQuestions(deck, currentSlide, { count: 4, seed: `${state.seed}|more|${state.slide}` }));
  if (!pool.length) {
    messages.push(msg('I have run out of solid questions for this slide. Say **next** and we will move on.', { kind: 'note' }));
    return messages;
  }
  state.queue = pool.slice(0, 4).map((q, i) => ({ ...q, index: i + 1, total: Math.min(4, pool.length) }));
  state.qCursor = 0;
  state.current = state.queue[0];
  state.phase = 'question';
  state.awaiting = 'answer';
  messages.push(msg(missedPool.length ? 'Back to the parts that slipped — a few more on those.' : 'Here are more questions on this slide.', { kind: 'note' }));
  messages.push(askMessage(state));
  return messages;
}

function handleProgress(state, messages) {
  const slidesDone = [...new Set(state.seenSlides)].length;
  const s = state.stats;
  const lines = [`**Progress — ${state.deckTitle}**`, ''];
  lines.push(`- Slides opened: ${slidesDone} of ${state.index.deck.slides.length}`);
  lines.push(`- Questions answered: ${s.answered}`);
  lines.push(`- Correct: ${s.correct} · Partly: ${s.partial} · Missed: ${s.incorrect} · Skipped: ${s.skipped}`);
  if (s.answered) lines.push(`- Accuracy: ${pct(s.correct / s.answered)}% (longest streak ${s.bestStreak})`);
  const weakest = Object.entries(state.perSlide)
    .filter(([, v]) => v.asked > 0)
    .map(([n, v]) => ({ n: Number(n), p: v.correct / v.asked }))
    .sort((a, b) => a.p - b.p).slice(0, 3);
  if (weakest.length) lines.push(`\nShakiest slides: ${weakest.map(w => `**${w.n}** (${pct(w.p)}%)`).join(', ')}`);
  messages.push(msg(lines.join('\n'), {
    kind: 'answer',
    chips: [{ label: 'Summary of the lesson', send: 'summary' }, { label: 'Quiz me on my misses', send: 'quiz me on my misses' }],
  }));
  return messages;
}

function handleHelp(state, messages) {
  messages.push(msg([
    '**Things you can say to me**',
    '- `next` · `back` · `repeat` — move between slides',
    '- `hint` · `show answer` · `skip` — when a question is not coming',
    '- `go to slide 7` — jump anywhere in the deck',
    '- `what is <term>?` · `where is <term> mentioned?` — ask about the content',
    '- `explain that simpler` · `give me an example` — when I have moved too fast',
    '- `summary` · `progress` · `glossary` — the bigger picture',
    '- `quiz me` · `quiz me on my misses` — extra questions',
    '- `restart` — clear this run and start again',
    '',
    'I answer only from the file you uploaded — nothing else, and nothing leaves this browser.',
  ].join('\n'), { kind: 'answer' }));
  return messages;
}

/* ------------------------------------------------------------- public ---- */

export function start(state) {
  const messages = [];
  const deck = state.index.deck;
  const first = deck.slides.find(s => !s.skipQuestions) || deck.slides[0];
  const greeting = state.learner ? `Hello${nameTag(state)}.` : 'Hello.';
  messages.push(msg(`${greeting} I am **Cyzie** — I will teach you this deck slide by slide, then question you on it.`, { kind: 'note' }));
  messages.push(msg(overviewMessage(state), {
    chips: [{ label: 'Start slide 1', send: 'next' }, { label: 'Glossary first', send: 'glossary' }, { label: 'How do I use this?', send: 'help' }],
  }));
  if (first) startSlide(state, first.index, messages);
  return { messages, state };
}

export function respond(state, text) {
  const messages = [];
  const { intent, query, slide } = classify(state, text);
  state.lastIntent = intent;

  switch (intent) {
    case 'empty':
      messages.push(msg('I am listening — ask a question or say **next**.', { kind: 'note' }));
      return { messages, state };

    case 'help': return { messages: handleHelp(state, messages), state };

    case 'greeting':
      messages.push(msg(`Hello${nameTag(state)}. We are on slide ${state.slide}${slideOf(state, state.slide) ? ` — ${truncate(slideOf(state, state.slide).title, 60)}` : ''}.`, {
        kind: 'note',
        chips: [{ label: 'Continue', send: 'next' }, { label: 'Explain this slide', send: 'repeat' }],
      }));
      return { messages, state };

    case 'answer': return { messages: handleAnswer(state, text, messages), state };

    case 'next': {
      if (state.awaiting === 'answer' && state.current) {
        messages.push(msg('Answer the question in front of you first, or say **skip**.', { kind: 'note' }));
        return { messages, state };
      }
      if (state.phase === 'slideSummary' || state.phase === 'done') {
        const next = nextSlideNumber(state, state.slide);
        if (next == null) {
          if (state.phase !== 'done') {
            state.phase = 'done';
            messages.push(lessonSummaryMessage(state));
          } else {
            messages.push(msg('That was the final slide. Say **restart**, **quiz me**, or ask me anything about the deck.', { kind: 'note' }));
          }
          return { messages, state };
        }
        return { messages: startSlide(state, next, messages), state };
      }
      return { messages: startSlide(state, state.slide, messages), state };
    }

    case 'back': {
      const prev = prevSlideNumber(state, state.slide);
      if (prev == null) {
        messages.push(msg('We are at the first slide of the lesson.', { kind: 'note' }));
        return { messages, state };
      }
      return { messages: startSlide(state, prev, messages), state };
    }

    case 'repeat':
      return { messages: startSlide(state, state.slide, messages), state };

    case 'skip': return { messages: handleSkip(state, messages), state };

    case 'hint': {
      if (!state.current) {
        messages.push(msg('No question is open right now — say **quiz me** if you want one.', { kind: 'note' }));
        return { messages, state };
      }
      messages.push(msg(hintFor(state.current), { kind: 'note' }));
      return { messages, state };
    }

    case 'reveal': {
      if (!state.current) {
        messages.push(msg('Nothing to reveal — we are between questions.', { kind: 'note' }));
        return { messages, state };
      }
      state.missed.push(state.current.id);
      slideStats(state, state.current.slide).wrong++;
      const q = state.current;
      messages.push(revealAnswerMessage(state, q));
      return { messages: advanceQuestion(state, messages), state };
    }

    case 'summary': {
      if (/slide|page|this/.test(text.toLowerCase()) && !/lesson|whole|everything|deck|all/.test(text.toLowerCase())) {
        const slide = slideOf(state, state.slide);
        messages.push(slideSummaryMessage(state, slide));
        messages.push(msg(slideIntro(state, slide), { kind: 'teach' }));
      } else {
        messages.push(lessonSummaryMessage(state));
      }
      return { messages, state };
    }

    case 'quiz': return { messages: handleQuiz(state, messages), state };

    case 'quiz_topic': return { messages: handleQuiz(state, messages, { topic: query }), state };

    case 'glossary': return { messages: handleGlossary(state, messages), state };

    case 'progress': return { messages: handleProgress(state, messages), state };

    case 'where': {
      const result = answerQuestion(state.index.deck, state.index, query, { lookupTerm: q => lookupTerm(state.index.deck.glossary, q) });
      if (result.hits.length) messages.push(passageAnswerMessage(state, result, query));
      else messages.push(noAnswerMessage(state, result, query));
      return { messages, state };
    }

    case 'define': return { messages: handleDefine(state, query, messages), state };

    case 'simpler': return { messages: handleSimpler(state, text, messages), state };

    case 'example': return { messages: handleExample(state, messages), state };

    case 'detail': {
      const slide = slideOf(state, state.slide);
      const lines = [`More from slide ${slide.index} — ${slide.title}`];
      const extra = slide.facts.slice(2, 7).map(f => `- ${truncate(stripMd(f.text), 200)}`);
      lines.push(extra.length ? extra.join('\n') : '- That is all the text this slide carries.');
      if (slide.terms.some(t => t.definition)) {
        lines.push('\nDefinitions on this slide:');
        lines.push(slide.terms.filter(t => t.definition).slice(0, 3).map(t => `- **${t.term}** — ${truncate(stripMd(t.definition), 150)}`).join('\n'));
      }
      messages.push(msg(lines.join('\n'), { kind: 'answer', slide: slide.index }));
      return { messages, state };
    }

    case 'harder':
    case 'easier': {
      const slide = slideOf(state, state.slide);
      const preferHard = intent === 'harder';
      const all = state.plan.find(p => p.slide === state.slide)?.questions || buildQuestions(state.index.deck, slide, { count: 8, seed: state.seed });
      const filtered = all.filter(q => preferHard ? q.difficulty >= 2 : q.difficulty <= 2);
      const pool = (filtered.length ? filtered : all).slice(0, 4);
      if (!pool.length) {
        messages.push(msg('I do not have a different difficulty for this slide.', { kind: 'note' }));
        return { messages, state };
      }
      state.queue = pool.map((q, i) => ({ ...q, index: i + 1, total: pool.length }));
      state.qCursor = 0;
      state.current = state.queue[0];
      state.awaiting = 'answer';
      state.phase = 'question';
      messages.push(msg(preferHard ? 'Tougher set — these lean on explanation rather than recognition.' : 'Easier set — recognition and recall first.', { kind: 'note' }));
      messages.push(askMessage(state));
      return { messages, state };
    }

    case 'jump': {
      const target = slideOf(state, slide);
      if (!target) {
        messages.push(msg(`This deck only has ${state.index.deck.slides.length} slides.`, { kind: 'note' }));
        return { messages, state };
      }
      return { messages: startSlide(state, target.index, messages), state };
    }

    case 'stop':
      state.phase = 'paused';
      messages.push(msg('Paused. Your progress is saved in this browser — come back any time.', {
        kind: 'note',
        chips: [{ label: 'Resume', send: 'next' }, { label: 'Where was I?', send: 'progress' }],
      }));
      return { messages, state };

    case 'restart':
      state.slide = (state.index.deck.slides.find(s => !s.skipQuestions) || state.index.deck.slides[0]).index;
      state.stats = { answered: 0, correct: 0, partial: 0, incorrect: 0, skipped: 0, streak: 0, bestStreak: 0 };
      state.missed = [];
      state.seenSlides = [];
      for (const k of Object.keys(state.perSlide)) state.perSlide[k] = { asked: 0, correct: 0, partial: 0, incorrect: 0, attempts: 0, wrong: 0 };
      messages.push(msg('Starting fresh.', { kind: 'note' }));
      return { messages: startSlide(state, state.slide, messages), state };

    case 'thanks':
      messages.push(msg(`Any time${nameTag(state)}. ${state.awaiting === 'answer' ? 'The question is still open whenever you are ready.' : 'Say **next** and we will keep going.'}`, { kind: 'note' }));
      return { messages, state };

    case 'question':
      return { messages: handleDefine(state, query, messages), state };

    default:
      messages.push(msg('I did not follow that one. Try **help** to see what I understand, or ask about something on the slide.', { kind: 'note' }));
      return { messages, state };
  }
}

export { overviewMessage, slideIntro, hintFor, lessonSummaryMessage, slideSummaryMessage };

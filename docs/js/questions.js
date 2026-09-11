/* Question generation — one slide at a time, from the slide's own words.
   Everything is derived from the uploaded file; Cyzie never invents facts. */

import { keyStems, contentWords, words, similarity, normalize, truncate, shuffle, uniqueBy, coverAnswer, stem, pick } from './nlp.js';

const ANTONYMS = [
  ['increase', 'decrease'], ['increases', 'decreases'], ['increase', 'reduce'], ['higher', 'lower'],
  ['more', 'less'], ['always', 'never'], ['before', 'after'], ['can', 'cannot'], ['allows', 'prevents'],
  ['enables', 'prevents'], ['fast', 'slow'], ['positive', 'negative'], ['maximum', 'minimum'],
  ['include', 'exclude'], ['includes', 'excludes'], ['true', 'false'], ['input', 'output'],
  ['internal', 'external'], ['public', 'private'], ['strong', 'weak'], ['smaller', 'larger'],
];

function seededRng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
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

function cleanDefinition(def = '') {
  let d = normalize(def)
    .replace(/^(refers to|refer to|is defined as|are defined as|is known as|are known as|is called|are called|can be defined as|consists of|consist of|describes|describe|denotes|denote|means|mean|involves|involve)\s+/i, '')
    .replace(/^(is|are|was|were)\s+/, '')
    .replace(/^[:;\-–—\s]+/, '')
    .replace(/["“”]+/g, '')
    .replace(/\s*\((?:[^)]*(?:p\.|pp\.|Google|OITAF|OpenAI)[^)]*)\)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (d.length > 220) d = truncate(d, 210);
  return d;
}

function blankTerm(sentence, term) {
  const t = normalize(sentence);
  const idx = t.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const before = t.slice(0, idx);
  const after = t.slice(idx + term.length);
  return normalize(`${before}______${after}`);
}

/** Terms from other slides, good enough to stand as plausible distractors. */
function distractorPool(deck, slide) {
  const own = new Set(slide.terms.map(t => t.term.toLowerCase()));
  const list = [];
  for (const t of deck.glossary.values()) {
    if (!t.definition) continue;
    if (own.has(t.term.toLowerCase())) continue;
    if (slide.text.toLowerCase().includes(t.term.toLowerCase())) continue;
    list.push({ term: t.term, definition: cleanDefinition(t.definition), slide: t.slide });
  }
  return list;
}

function similarLength(candidates, target, tolerance = 1.0) {
  const len = target.length;
  const within = candidates.filter(c => c.definition.length >= len * (1 - tolerance * 0.5) && c.definition.length <= len * (1 + tolerance));
  return (within.length >= 3 ? within : candidates);
}

function buildMcqDef(deck, slide, term, rng) {
  const correct = cleanDefinition(term.definition);
  if (words(correct).length < 3) return null;
  const pool = similarLength(distractorPool(deck, slide), correct);
  const chosen = [];
  const used = [];
  for (const cand of shuffle(pool, rng())) {
    if (chosen.length >= 3) break;
    if (similarity(cand.definition, correct) > 0.62) continue;
    if (chosen.some(c => similarity(c.definition, cand.definition) > 0.7)) continue;
    chosen.push(cand);
    used.push(cand.definition);
  }
  if (chosen.length < 2) return null;
  const choices = shuffle([
    { text: correct, correct: true },
    ...chosen.map(c => ({ text: c.definition, correct: false })),
  ], rng());
  return {
    type: 'mcq_definition',
    focus: term.term,
    prompt: `Which of these best describes **${term.term}**?`,
    choices,
    answer: { text: correct, keywords: keyStems(correct) },
    sourceLine: term.sourceLine || term.definition,
    explanation: `Slide ${slide.index} defines ${term.term} as: “${correct}”`,
    difficulty: 1,
  };
}

function buildCloze(deck, slide, term, rng, { typed = false } = {}) {
  const def = cleanDefinition(term.definition);
  const sentence = term.sourceLine && term.sourceLine.toLowerCase().includes(term.term.toLowerCase())
    ? term.sourceLine
    : (def ? `${term.term} ${/^(is|are|refers|means|describes|consists|involves)/i.test(def) ? def : def}` : null);
  if (!sentence) return null;
  const blanked = blankTerm(sentence, term.term);
  if (!blanked || blanked.length < 20) return null;
  const base = {
    type: typed ? 'cloze_type' : 'cloze_mcq',
    focus: term.term,
    prompt: `Fill in the blank from slide ${slide.index}:\n\n> ${blanked}`,
    answer: { text: term.term, keywords: keyStems(term.term), alt: [term.short].filter(Boolean) },
    sourceLine: sentence,
    explanation: `The slide says: “${truncate(sentence, 200)}”`,
    difficulty: typed ? 2 : 1,
  };
  if (typed) return base;
  const pool = distractorPool(deck, slide)
    .filter(c => c.term.toLowerCase() !== term.term.toLowerCase())
    .filter(c => words(c.term).length <= 5);
  const sameShape = pool.filter(c => Math.abs(c.term.length - term.term.length) <= 8);
  const chosen = [];
  for (const cand of shuffle(sameShape.length >= 3 ? sameShape : pool, rng())) {
    if (chosen.length >= 3) break;
    if (chosen.some(c => c.term.toLowerCase() === cand.term.toLowerCase())) continue;
    chosen.push(cand);
  }
  if (chosen.length < 2) return null;
  base.choices = shuffle([
    { text: term.term, correct: true },
    ...chosen.map(c => ({ text: c.term, correct: false })),
  ], rng());
  return base;
}

function buildDefineShort(deck, slide, term) {
  const def = cleanDefinition(term.definition);
  if (words(def).length < 4) return null;
  const termStems = new Set(keyStems(term.term));
  const expected = keyStems(def).filter(s => !termStems.has(s));
  if (expected.length < 2) return null;
  return {
    type: 'define_short',
    focus: term.term,
    prompt: `In your own words, what is **${term.term}**?`,
    answer: { text: def, keywords: expected },
    sourceLine: term.sourceLine || term.definition,
    explanation: `Slide ${slide.index} says: “${truncate(term.sourceLine || def, 220)}”`,
    difficulty: 3,
  };
}

function mutateStatement(deck, slide, fact, rng) {
  const base = fact.text;
  const ownTerm = slide.terms.find(t => t.term.length > 3 && base.toLowerCase().includes(t.term.toLowerCase()) && t.term.toLowerCase() !== slide.title.toLowerCase());
  const others = [...deck.glossary.values()].filter(t => t.slide !== slide.index && t.term.length > 3 && !base.toLowerCase().includes(t.term.toLowerCase()));
  const options = [];

  if (ownTerm && others.length) {
    const swap = pick(others, rng());
    if (swap) {
      const idx = base.toLowerCase().indexOf(ownTerm.term.toLowerCase());
      const before = base.slice(0, idx);
      const after = base.slice(idx + ownTerm.term.length);
      // Keep the swapped-in word's leading capital/gender shape as close as possible.
      options.push({ text: normalize(before + swap.term + after), kind: 'swap', why: `“${ownTerm.term}” was replaced with “${swap.term}”` });
    }
  }

  for (const [a, b] of ANTONYMS) {
    const reA = new RegExp(`\\b${a}\\b`, 'i');
    const reB = new RegExp(`\\b${b}\\b`, 'i');
    if (reA.test(base)) {
      options.push({ text: base.replace(reA, m => matchCase(b, m)), kind: 'antonym', why: `the wording was flipped to the opposite (“${b}”)` });
      break;
    }
    if (reB.test(base)) {
      options.push({ text: base.replace(reB, m => matchCase(a, m)), kind: 'antonym', why: `the wording was flipped to the opposite (“${a}”)` });
      break;
    }
  }

  if (fact.numbers && fact.numbers.length) {
    const n = fact.numbers[0].value;
    const val = parseFloat(n.replace(',', '.'));
    if (Number.isFinite(val)) {
      const altered = /%$/.test(n) ? `${Math.max(1, Math.round(val / 2))}%` : String(Math.max(1, Math.round(val + 7)));
      if (altered !== n) {
        const parts = base.split(n);
        options.push({ text: normalize(parts.join(altered)), kind: 'number', why: `the figure was changed from ${n} to ${altered}` });
      }
    }
  }
  if (!options.length) return null;
  return pick(options, rng() + 0.13);
}

function matchCase(word, sample) {
  return /^[A-Z]/.test(sample) ? word[0].toUpperCase() + word.slice(1) : word;
}

function buildTrueFalse(deck, slide, fact, rng) {
  const makeFalse = rng() < 0.5;
  if (!makeFalse) {
    return {
      type: 'true_false',
      focus: 'statement',
      prompt: `True or false — is this from slide ${slide.index}?\n\n> ${fact.text}`,
      answer: { text: 'true', keywords: [] },
      sourceLine: fact.text,
      explanation: `Yes — that is exactly what slide ${slide.index} says.`,
      difficulty: 1,
    };
  }
  const mutated = mutateStatement(deck, slide, fact, rng);
  if (!mutated) {
    return {
      type: 'true_false',
      focus: 'statement',
      prompt: `True or false — is this from slide ${slide.index}?\n\n> ${fact.text}`,
      answer: { text: 'true', keywords: [] },
      sourceLine: fact.text,
      explanation: `Yes — that is exactly what slide ${slide.index} says.`,
      difficulty: 1,
    };
  }
  return {
    type: 'true_false',
    focus: 'statement',
    prompt: `True or false — is this from slide ${slide.index}?\n\n> ${mutated.text}`,
    answer: { text: 'false', keywords: [] },
    sourceLine: fact.text,
    explanation: `False. The slide actually says: “${truncate(fact.text, 190)}” (${mutated.why}).`,
    difficulty: 2,
  };
}

function buildNotOnSlide(deck, slide, rng) {
  const own = slide.terms.filter(t => t.term.length > 3).slice(0, 6);
  if (own.length < 3) return null;
  const outsiders = [...deck.glossary.values()]
    .filter(t => t.slide !== slide.index && t.term.length > 3 && !slide.text.toLowerCase().includes(t.term.toLowerCase()));
  if (!outsiders.length) return null;
  const outsider = pick(outsiders, rng());
  const chosen = shuffle(own, rng()).slice(0, 3);
  if (chosen.length < 3) return null;
  const choices = shuffle([
    { text: outsider.term, correct: true },
    ...chosen.map(t => ({ text: t.term, correct: false })),
  ], rng());
  return {
    type: 'not_on_slide',
    focus: 'vocabulary',
    prompt: `Which of these terms is **not** mentioned on slide ${slide.index}?`,
    choices,
    answer: { text: outsider.term, keywords: [] },
    sourceLine: slide.title,
    explanation: `“${outsider.term}” belongs to slide ${outsider.slide}. This slide covers: ${chosen.map(t => t.term).join(', ')}.`,
    difficulty: 2,
  };
}

function buildListRecall(slide, group) {
  if (!group || group.items.length < 2) return null;
  const keywords = uniqueBy(group.items.flatMap(item => keyStems(item).slice(0, 6)), s => s);
  const expect = Math.min(group.items.length, 4);
  return {
    type: 'list_recall',
    focus: group.lead,
    prompt: `Slide ${slide.index} lists things under **${group.lead.replace(/:\s*$/, '')}**.

Name **${expect}** of them.`,
    answer: {
      text: group.items.map(i => `• ${i}`).join('\n'),
      keywords,
      mode: 'coverage',
      target: expect,
      items: group.items,
    },
    sourceLine: group.items[0],
    explanation: `The slide lists:\n${group.items.map(i => `• ${truncate(i, 160)}`).join('\n')}`,
    difficulty: 2,
  };
}

function buildGist(slide) {
  const expected = uniqueBy([...keyStems(slide.title), ...slide.terms.flatMap(t => keyStems(t.term))], s => s);
  if (expected.length < 2 || slide.facts.length < 1) return null;
  return {
    type: 'gist_short',
    focus: slide.title,
    prompt: `Summarise slide ${slide.index} in one or two sentences.`,
    answer: { text: `${slide.title}. ${truncate(slide.facts[0]?.text || '', 180)}`, keywords: expected.slice(0, 8), mode: 'coverage', target: Math.max(2, Math.min(4, expected.length)) },
    sourceLine: slide.title,
    explanation: `Useful summary: **${slide.title}** — ${truncate(slide.facts.map(f => f.text).join(' '), 240)}`,
    difficulty: 3,
  };
}

/**
 * Generate the question set for one slide.
 * @param {object} deck  result of analyzeDeck()
 * @param {object} slide an enriched slide
 * @param {{count?:number, seed?:string}} opts
 */
export function buildQuestions(deck, slide, { count = 5, seed = '' } = {}) {
  if (!slide || slide.skipQuestions) return [];
  const rng = seededRng(`${seed}|slide${slide.index}|${slide.title}`);
  const defTerms = slide.terms.filter(t => t.definition && words(cleanDefinition(t.definition)).length >= 3);
  const cands = [];

  for (const t of defTerms) {
    const q = buildCloze(deck, slide, t, rng, { typed: false });
    if (q) cands.push(q);
  }
  for (const t of defTerms) {
    const q = buildMcqDef(deck, slide, t, rng);
    if (q) cands.push(q);
  }
  const tfPool = shuffle(slide.facts, rng()).slice(0, 3);
  for (const f of tfPool) {
    const q = buildTrueFalse(deck, slide, f, rng);
    if (q) cands.push(q);
  }
  const neg = buildNotOnSlide(deck, slide, rng);
  if (neg) cands.push(neg);
  if (slide.lists.length) {
    const q = buildListRecall(slide, slide.lists[0]);
    if (q) cands.push(q);
  }
  for (const t of defTerms) {
    const q = buildDefineShort(deck, slide, t);
    if (q) cands.push(q);
  }
  const typed = defTerms.map(t => buildCloze(deck, slide, t, rng, { typed: true })).filter(Boolean);
  if (typed.length) cands.push(typed[0]);
  const gist = buildGist(slide);
  if (gist) cands.push(gist);

  // Warm-up first (recognition), recall next, explanation last.
  const order = { cloze_mcq: 1, true_false: 2, mcq_definition: 3, not_on_slide: 4, cloze_type: 5, list_recall: 6, define_short: 7, gist_short: 8 };
  const ranked = cands
    .filter(q => q.answer.text)
    .filter((q, i, arr) => arr.findIndex(x => x.type === q.type && x.focus === q.focus) === i)
    .sort((a, b) => (order[a.type] || 9) - (order[b.type] || 9) + (a.difficulty - b.difficulty) * 0.1);

  // Mix types rather than spending the whole slide on one question style.
  const perType = new Map();
  const mixed = [];
  for (const q of ranked) {
    const n = perType.get(q.type) || 0;
    if (n >= 3) continue;
    perType.set(q.type, n + 1);
    mixed.push(q);
  }
  const wanted = Math.max(1, Math.min(count, 8));
  const selected = mixed.slice(0, Math.max(wanted, Math.min(mixed.length, Math.ceil(wanted * 0.75))));
  return selected.map((q, i) => ({
    ...q,
    id: `s${slide.index}q${i + 1}`,
    slide: slide.index,
    index: i + 1,
    total: selected.length,
  }));
}

export function buildLessonPlan(deck, { density = 'standard', seed = '' } = {}) {
  const perSlide = density === 'quick' ? 3 : density === 'deep' ? 7 : 5;
  return deck.slides.map(s => ({
    slide: s.index,
    skip: s.skipQuestions,
    questions: buildQuestions(deck, s, { count: perSlide, seed }),
  }));
}

export { cleanDefinition, mutateStatement, blankTerm };

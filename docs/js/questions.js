/* Question generation — one slide at a time, from the slide's own words.
   Everything is derived from the uploaded file; Cyzie never invents facts. */

import { keyStems, contentWords, words, similarity, normalize, truncate, shuffle, uniqueBy, coverAnswer, stem, pick } from './nlp.js';
import { highlightCode, walkthrough, readLine, statedOutput } from './code.js';

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

/* ------------------------------------------------------- code questions --- */

const CODE_HELPERS = {
  python: { comment: '#', keywordHint: 'a colon at the end of the line' },
  java: { comment: '//', keywordHint: 'a semicolon at the end of the line' },
  javascript: { comment: '//', keywordHint: 'a matching pair of braces' },
  c: { comment: '//', keywordHint: 'a semicolon at the end of the line' },
  cpp: { comment: '//', keywordHint: 'a semicolon at the end of the line' },
  csharp: { comment: '//', keywordHint: 'a semicolon at the end of the line' },
};

function codeFence(code, lang = 'unknown') {
  return '```' + lang + '\n' + code + '\n```';
}

/** "How many times does this run?" — the honest way to use a long repeated output. */
function buildCodeCount(slide, sim, rng) {
  const outputs = sim.outputs;
  const uniq = uniqueBy(outputs, o => o);
  if (uniq.length !== 1) return null;
  const count = outputs.length;
  const wrongs = uniqueBy([count + 1, count - 1, count * 2, Math.round(count / 2), count + 10], n => n)
    .filter(n => n > 0 && n !== count).slice(0, 3);
  if (wrongs.length < 2) return null;
  return {
    type: 'code_count',
    focus: 'loop count',
    prompt: `The code on slide ${slide.index} prints **${truncate(uniq[0], 40)}** over and over.\n\nHow many times does it print it?`,
    answer: { text: String(count), keywords: [String(count)], numeric: count },
    sourceLine: sim.code,
    explanation: `The loop runs ${count} times, so that line is printed ${count} times.`,
    difficulty: 2,
    choices: shuffle([
      { text: String(count), correct: true },
      ...wrongs.map(n => ({ text: String(n), correct: false })),
    ], rng()),
  };
}

function buildCodeOutput(deck, slide, rng) {
  const code = slide.code;
  if (!code || !code.blocks.length) return null;
  const block = code.blocks[0];
  const sim = code.output;

  if (sim) {
    const countQ = buildCodeCount(slide, sim, rng);
    if (countQ) return countQ;
    const correct = sim.summary;
    const wrongs = [];
    // Distractors: the same code with a shifted bound or start.
    for (const shift of [1, -1, 2]) {
      const m = sim.code.match(/(\d+)(?![\s\S]*\d)/);
      if (!m) break;
      const n = parseInt(m[1], 10) + shift;
      if (n < 0) continue;
      const mutated = sim.outputs.map((_, i) => (i < sim.outputs.length + shift ? sim.outputs[i] : ''));
      const seq = sim.outputs.slice(0, Math.max(0, sim.outputs.length + shift));
      if (seq.length && seq.length !== sim.outputs.length) wrongs.push(seq.join(' '));
    }
    if (sim.outputs.length > 1) {
      wrongs.push(sim.outputs.slice(1).concat(sim.outputs[0]).join(' '));
      wrongs.push(sim.outputs.slice(0, -1).join(' '));
    }
    const options = uniqueBy(wrongs.filter(w => w && w !== correct), w => w).slice(0, 3);
    const q = {
      type: 'code_output',
      focus: 'program output',
      prompt: `Look at the ${block.langLabel} code on slide ${slide.index}.\n\n${codeFence(block.code, block.lang)}\n\n**What does it print, in order?**`,
      answer: { text: correct, keywords: contentWords(correct), sequence: sim.outputs },
      sourceLine: block.code,
      explanation: `Running it gives: ${correct}\n\nThat is worked out step by step from the loop in the code — nothing here was guessed from outside the slide.`,
      difficulty: 3,
    };
    if (options.length >= 3 && sim.outputs.length <= 8) {
      q.choices = shuffle([{ text: correct, correct: true }, ...options.slice(0, 3).map(o => ({ text: o, correct: false }))], rng());
      q.prompt = `Look at the ${block.langLabel} code on slide ${slide.index}.\n\n${codeFence(block.code, block.lang)}\n\n**What does it print?**`;
      q.difficulty = 2;
    }
    return q;
  }

  const stated = code.stated[0];
  if (stated) {
    const text = stated.text.replace(/^["']|["']$/g, '');
    return {
      type: 'code_output',
      focus: 'program output',
      prompt: `Look at the ${block.langLabel} code on slide ${slide.index}.\n\n${codeFence(block.code, block.lang)}\n\n**What does this program output?**`,
      answer: { text, keywords: contentWords(text) },
      sourceLine: stated.from,
      explanation: `The slide gives the answer itself: **${truncate(text, 120)}**`,
      difficulty: 2,
    };
  }
  return null;
}

/** A line that only explains the code (a comment) is a poor quiz target. */
function isCommentLine(line = '', meaning = '') {
  return /^\s*(\/\/|#|--|\*|\/\*)/.test(line) || /^a comment/i.test(meaning);
}

function buildLineMeaning(deck, slide, rng) {
  const code = slide.code;
  if (!code || code.walk.length < 2) return null;
  const pool = [];
  const usable = row => row.meaning && row.meaning.length > 12 && !isCommentLine(row.line, row.meaning);
  for (const row of code.walk) if (usable(row)) pool.push({ ...row, slide: slide.index });
  for (const other of deck.slides) {
    if (other.index === slide.index || !other.code) continue;
    for (const row of other.code.walk || []) if (usable(row)) pool.push({ ...row, slide: other.index });
  }
  const own = pool.filter(p => p.slide === slide.index);
  if (!own.length) return null;
  const target = pick(own, rng());
  // Distractors must read differently from the answer AND from each other.
  const wrongs = [];
  for (const cand of shuffle(pool, rng())) {
    if (wrongs.length >= 3) break;
    if (cand.line === target.line) continue;
    if (cand.meaning.toLowerCase() === target.meaning.toLowerCase()) continue;
    if (wrongs.some(w => similarity(w.meaning, cand.meaning) > 0.7)) continue;
    wrongs.push(cand);
  }
  if (wrongs.length < 3) return null;
  return {
    type: 'line_meaning',
    focus: target.line,
    prompt: `On slide ${slide.index} there is this line of ${code.lang.label}:\n\n${codeFence(target.line, code.lang.id)}\n\n**What does that line do?**`,
    choices: shuffle([
      { text: target.meaning, correct: true },
      ...wrongs.map(w => ({ text: w.meaning, correct: false })),
    ], rng()),
    answer: { text: target.meaning, keywords: contentWords(target.meaning) },
    sourceLine: target.line,
    explanation: `Line ${target.n}: \`${truncate(target.line, 90)}\` — ${target.meaning}.`,
    difficulty: 2,
  };
}

function buildCodeKeyword(deck, slide, rng) {
  const code = slide.code;
  if (!code || !code.blocks.length) return null;
  const block = code.blocks[0];
  const keywordPool = ['def', 'while', 'for', 'if', 'else', 'elif', 'return', 'import', 'class', 'new', 'public', 'static', 'void', 'int', 'range', 'print'];
  const found = [];
  block.lines.forEach((line, i) => {
    for (const kw of keywordPool) {
      const re = new RegExp(`(^|[^\\w.])${kw}([^\\w]|$)`);
      if (re.test(line)) found.push({ kw, i, line });
    }
  });
  if (!found.length) return null;
  const target = pick(found, rng());
  const blanked = target.line.replace(new RegExp(`(^|[^\\w.])${target.kw}([^\\w]|$)`), (m, a, b) => `${a}_____${b}`);
  if (blanked === target.line) return null;
  const others = uniqueBy(keywordPool.filter(k => k !== target.kw), k => k).slice(0, 12);
  const wrongs = shuffle(others, rng() + 0.2).slice(0, 3);
  const numbered = block.lines.map((l, i) => `${i + 1}. ${i === target.i ? blanked : l}`).join('\n');
  return {
    type: 'code_keyword',
    focus: target.kw,
    prompt: `Line ${target.i + 1} of the ${block.langLabel} code on slide ${slide.index} has a keyword missing. Fill the blank:\n\n${codeFence(numbered, block.lang)}`,
    answer: { text: target.kw, keywords: [target.kw] },
    sourceLine: target.line,
    explanation: `The real line is \`${truncate(target.line, 110)}\` — the missing word is **${target.kw}**.`,
    difficulty: 1,
    choices: shuffle([{ text: target.kw, correct: true }, ...wrongs.map(w => ({ text: w, correct: false }))], rng()),
  };
}

function buildCodeBlank(deck, slide, rng) {
  const code = slide.code;
  if (!code || !code.blocks.length) return null;
  const block = code.blocks[0];
  if (block.lines.length < 3) return null;
  // Prefer a line that carries the logic: loop header, condition, return, or the first statement.
  const scored = block.lines.map((line, i) => {
    let score = 0;
    if (/\b(for|while|if|elif|else)\b/.test(line)) score += 3;
    if (/\b(return|print|println|cout)\b/.test(line)) score += 2;
    if (/\b(def|function|class|public|static)\b/.test(line)) score += 2;
    if (i === 0) score += 1;
    return { line, i, score };
  }).sort((a, b) => b.score - a.score);
  const target = scored[0];
  const distractors = [];
  for (const other of block.lines) if (other !== target.line) distractors.push(other);
  for (const other of deck.slides) {
    if (other.index === slide.index || !other.code) continue;
    for (const b of other.code.blocks) for (const l of b.lines) distractors.push(l);
  }
  const chosen = shuffle(uniqueBy(distractors, d => d), rng()).slice(0, 3);
  if (chosen.length < 2) return null;
  const shown = block.lines.filter((_, i) => i !== target.i).map((l, i) => `${i + 1}. ${l}`).join('\n');
  return {
    type: 'code_blank',
    focus: `line ${target.i + 1}`,
    prompt: `One line is missing from this ${block.langLabel} code (slide ${slide.index}). Which line belongs in the gap?`,
    codeContext: codeFence(shown, block.lang),
    choices: shuffle([
      { text: target.line, correct: true },
      ...chosen.map(c => ({ text: c, correct: false })),
    ], rng()),
    answer: { text: target.line, keywords: contentWords(target.line) },
    sourceLine: target.line,
    explanation: `The full block is:\n\n${codeFence(block.code, block.lang)}\n\nThe missing line is \`${truncate(target.line, 110)}\`.`,
    difficulty: 3,
  };
}

function introduceBug(line, langId) {
  const t = line;
  if (langId === 'python') {
    if (/:\s*$/.test(t)) return { code: t.replace(/:\s*$/, ''), problem: 'the colon is missing at the end of the line', keyword: 'colon' };
    if (/==/.test(t)) return { code: t.replace('==', '='), problem: 'it uses = (assignment) where a comparison (==) belongs', keyword: 'equals' };
    if (/^(\s+)/.test(t)) return { code: t.replace(/^\s+/, ''), problem: 'the line is not indented, so it falls outside the block', keyword: 'indent' };
    if (/\b(range|print|input|len)\b/.test(t)) return { code: t.replace(/\b(range|print|input|len)\b/, m => m.slice(0, -1) + 'e'), problem: `the function name ${t.match(/\b(range|print|input|len)\b/)[1]}() is misspelled`, keyword: t.match(/\b(range|print|input|len)\b/)[1] };
    return null;
  }
  if (/;\s*$/.test(t)) return { code: t.replace(/;\s*$/, ''), problem: 'the semicolon at the end of the line is missing', keyword: 'semicolon' };
  if (/==/.test(t)) return { code: t.replace('==', '='), problem: 'it uses = (assignment) where a comparison (==) belongs', keyword: 'equals' };
  if (/\bi\s*<=\s*\d+/.test(t)) return { code: t.replace(/<=/, '<'), problem: 'the loop bound is off by one (<= should be <, or the bound should change)', keyword: 'bound' };
  if (/\{[^}]*$/.test(t)) return { code: t.replace(/\{$/, ''), problem: 'the opening brace at the end of the line is missing', keyword: 'brace' };
  if (/\b(println|printf|cout|print)\b/.test(t)) return { code: t.replace(/\b(println|printf|cout|print)\b/, m => m.slice(0, -1) + 'e'), problem: `the method name ${t.match(/\b(println|printf|cout|print)\b/)[1]}() is misspelled`, keyword: t.match(/\b(println|printf|cout|print)\b/)[1] };
  return null;
}

function buildCodeError(deck, slide, rng) {
  const code = slide.code;
  if (!code || !code.blocks.length) return null;
  const block = code.blocks[0];
  const candidates = [];
  block.lines.forEach((line, i) => {
    if (line.trim().length < 6) return;
    const bug = introduceBug(line, block.lang);
    if (bug) candidates.push({ line, i, bug });
  });
  if (!candidates.length) return null;
  const chosen = pick(candidates, rng());
  const broken = block.lines.map((l, i) => (i === chosen.i ? chosen.bug.code : l)).join('\n');
  const meaning = readLine(chosen.line, block.lang) || 'this line does something important';
  return {
    type: 'code_error',
    focus: 'spot the bug',
    prompt: `This ${block.langLabel} code (slide ${slide.index}) has been changed so that it will no longer work as intended.\n\n${codeFence(broken, block.lang)}\n\n**What is wrong with it?**`,
    answer: {
      text: `Line ${chosen.i + 1}: ${chosen.bug.problem}.`,
      keywords: [chosen.bug.keyword, 'line', ...contentWords(chosen.bug.problem)].map(stem),
      also: [String(chosen.i + 1)],
    },
    sourceLine: chosen.line,
    explanation: `Line ${chosen.i + 1} should read \`${truncate(chosen.line, 110)}\` — ${chosen.bug.problem}.\n\nThat line ${meaning}.`,
    difficulty: 4,
  };
}

function buildCodeRecall(deck, slide, rng) {
  const code = slide.code;
  if (!code || !code.blocks.length) return null;
  const block = code.blocks[0];
  const rows = block.lines
    .map((line, i) => ({ line, i, meaning: readLine(line, block.lang) }))
    .filter(r => r.meaning && !isCommentLine(r.line, r.meaning) && r.line.trim().length > 8 && /[(){};:=]/.test(r.line));
  if (!rows.length) return null;
  const target = pick(rows, rng());
  const firstToken = target.line.trim().split(/[\s(]/)[0];
  return {
    type: 'code_recall',
    focus: target.line,
    prompt: `From memory, write the line of ${block.langLabel} on slide ${slide.index} that ${target.meaning.replace(/^the /, '')}.\n\nType the line exactly — punctuation matters.`,
    answer: {
      text: target.line.trim(),
      keywords: contentWords(target.line),
      codeLine: target.line.trim(),
      firstToken,
    },
    sourceLine: target.line,
    explanation: `The line is \`${truncate(target.line, 110)}\`${target.line.trim().startsWith(firstToken) ? `  (it starts with \`${firstToken}\`)` : ''}.`,
    hint: `Start with \`${firstToken}\`.`,
    difficulty: 4,
  };
}

/** All code questions for one slide. */
function codeQuestionSet(deck, slide, rng) {
  if (!slide.code || !slide.code.blocks.length) return [];
  const builders = [buildCodeKeyword, buildLineMeaning, buildCodeOutput, buildCodeBlank, buildCodeError, buildCodeRecall];
  const out = [];
  for (const build of builders) {
    try {
      const q = build(deck, slide, rng);
      if (q && q.answer && q.answer.text) out.push(q);
    } catch { /* a builder that cannot handle this code simply contributes nothing */ }
  }
  return out;
}

/* ------------------------------------------------------------- summary --- */

/** Token-shape similarity: code lines that differ only in a name or number still count as near-twins. */
export function shapeSimilarity(a = '', b = '') {
  const shape = s => normalize(s)
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/"[^"]*"|'[^']*'/g, '"s"')
    .toLowerCase()
    .replace(/[^a-z0-9#."\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const A = new Set(shape(a)); const B = new Set(shape(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** A multiple-choice question is only usable when the options are distinct and exactly one is right. */
export function validChoices(question) {
  if (!question.choices || !question.choices.length) return true;
  if (question.choices.length < 3) return false;
  if (question.choices.filter(c => c.correct).length !== 1) return false;
  const seen = new Set();
  for (const c of question.choices) {
    const key = normalize(c.text).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
  }
  const correct = question.choices.find(c => c.correct);
  for (let i = 0; i < question.choices.length; i++) {
    for (let j = i + 1; j < question.choices.length; j++) {
      const a = question.choices[i].text;
      const b = question.choices[j].text;
      if (similarity(a, b) > 0.9) return false;
      // Two options that read the same apart from a name or number are a trick, not a question.
      const near = shapeSimilarity(a, b) > 0.8 || shapeSimilarity(a, correct.text) > 0.8;
      if (near && Math.abs(a.length - b.length) < 12) return false;
    }
  }
  return true;
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

  // Code slides lead with code questions — that is what the student came for.
  cands.push(...codeQuestionSet(deck, slide, rng));

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
  const order = {
    code_keyword: 1, cloze_mcq: 1, line_meaning: 2, code_count: 3, code_output: 3, true_false: 3,
    mcq_definition: 4, not_on_slide: 4, code_blank: 5, cloze_type: 5, code_error: 6,
    list_recall: 6, code_recall: 7, define_short: 7, gist_short: 8,
  };
  const ranked = cands
    .filter(q => q.answer.text)
    .filter(q => validChoices(q))
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

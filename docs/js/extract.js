/* Knowledge extraction: turn parsed pages into terms, definitions, facts and lists
   that the tutor can teach and quiz from. Pure functions, no DOM. */

import {
  normalize, contentWords, keyStems, words, BOILERPLATE, STOPWORDS, truncate, isAcronym, uniqueBy, titleCase,
} from './nlp.js';
import { analyzeCode, isCodeLine, LANGUAGES } from './code.js';

const DECK_LANGUAGES = Object.fromEntries(LANGUAGES.map(l => [l.id, l]));
import { classifySlide, UNQUIZZABLE, buildRoadmap, buildObjectives, deckMap, ROLE } from './deck-intel.js';

const DEF_VERBS = /\b(refers to|refer to|is defined as|are defined as|is known as|are known as|is called|are called|can be defined as|consists of|consist of|describes|describe|denotes|denote|means|mean|involves|involve|is|are)\b/i;

const SKIP_TITLE_RE = /^(thank you|thanks|questions?\??|any questions\??|agenda|outline|table of contents|contents|references?|bibliography|further reading|course (info|information|description|objectives)|contact|appendix|backup|end of|the end|quiz|exercise|homework|assignment|summary of the (course|module))\b/i;

const META_LEAD_RE = /^(definition|definitions|note|notes|example|examples|figure|fig|table|source|sources|key (point|idea|term)s?|term|terms|remember|tip|warning|important|caution|hint|objective|objectives|learning outcome|learning outcomes|goal|aim|purpose|activity|task|discussion|question|quiz|answer|answers|case study|applications?|types?|kinds?|categories|benefits?|advantages?|disadvantages?|limitations?|challenges?|risks?|features?|characteristics?|properties?|steps?|stages?|phases?|components?|elements?|parts?|functions?|process|algorithm|how it works|why it matters|background|introduction|overview|summary|recap|review|conclusion|takeaways?)\s*$/i;

export function cleanTitle(raw = '') {
  let t = normalize(raw);
  t = t.replace(/^\s*(\d{1,3}[.)]\s*|slide\s*\d{1,3}\s*[-:.)]?\s*|chapter\s*\d{1,3}\s*[-:.)]?\s*)/i, '');
  t = t.replace(/^[\u2022\u25cf\u25aa\u25e6\u2023\u2043\u00b7\u25a0\u25b8\u27a4\u2192*>\-–—\s]+/, '');
  t = t.replace(/[\s:;,\-–—]+$/, '');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

function isMetaLead(s = '') {
  return META_LEAD_RE.test(cleanTitle(s)) || BOILERPLATE.has(cleanTitle(s).toLowerCase()) || cleanTitle(s).split(' ').length > 7;
}

/** Pull "Term: definition" out of a line. Returns null when the line isn't a definition pair. */
function splitDefinition(text) {
  const t = normalize(text);
  const m = t.match(/^(.{2,72}?)\s*(?::|[\u2013\u2014]|\s=\s)\s*(.{8,})$/);
  if (!m) return null;
  let term = cleanTitle(m[1]);
  let def = m[2].trim();
  if (!term || !def) return null;
  if (isMetaLead(m[1])) {
    // "Definition: X is Y" — the real term hides after the meta label.
    const inner = splitDefinition(def) || splitByVerb(def);
    return inner || null;
  }
  const tw = words(term);
  if (!tw.length || tw.length > 7) return null;
  if (words(def).length < 3) return null;
  if (!contentWords(term).length) return null;
  if (/^(https?|www)\b/i.test(term)) return null;
  return { term, definition: def, kind: 'colon' };
}

/** Pull "X <definition verb> Y" out of a line. */
function splitByVerb(text) {
  const t = normalize(text).replace(/^[\u2022\u25cf\u25aa\u25e6\u2043\u00b7\u25b8\u27a4\-–—*]\s*/, '');
  const m = DEF_VERBS.exec(t);
  if (!m) return null;
  const idx = m.index;
  let term = cleanTitle(t.slice(0, idx));
  const verb = m[0];
  const rest = t.slice(idx + m[0].length).trim();
  if (!term || !rest) return null;
  const lead = term.toLowerCase();
  if (/^(it|this|that|these|those|they|there|he|she|we|you|which|who|one|both|each|all|some|many|the (following|above|below)|as|when|if|so|and|but|or|because|however|therefore|thus|hence|then|also|for example|for instance)\b/.test(lead)) return null;
  const tw = words(term);
  if (!tw.length || tw.length > 8) return null;
  if (term.length > 80) return null;
  if (contentWords(term).length < 1) return null;
  if (/[.?!]$/.test(term)) return null;
  if (words(rest).length < 3) return null;
  if (!looksLikeTermPhrase(term)) return null;
  return { term, definition: `${verb} ${rest}`, kind: 'verb' };
}

/* A mined term has to look like a name for something, not a whole clause. Sentences such as
   "Reading a slide again feels productive but it is mostly recognition" are prose, not
   definitions — accepting them gives the tutor nonsense terms to quiz. */
const NOT_A_TERM_WORD = new Set(['feels', 'feel', 'seem', 'seems', 'look', 'looks', 'sounds', 'sound',
  'carry', 'carries', 'reply', 'replies', 'click', 'click', 'type', 'types', 'upload', 'uploads',
  'remember', 'remembers', 'forget', 'forgets', 'happens', 'happen', 'goes', 'go', 'comes', 'come',
  'works', 'work', 'gives', 'give', 'takes', 'take', 'makes', 'make', 'does', 'do', 'becomes', 'become']);
const PRONOUN_WORD = new Set(['it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'you', 'your', 'yours', 'we', 'our', 'ours', 'i', 'me', 'my', 'mine', 'he', 'she', 'him', 'her',
  'there', 'here', 'which', 'who', 'whom', 'whose', 'some', 'many', 'most', 'all', 'both', 'each',
  'one', 'thing', 'things', 'stuff', 'anything', 'something', 'nothing', 'everything', 'someone']);

function looksLikeTermPhrase(term) {
  const w = words(term).map(x => x.toLowerCase());
  if (!w.length || w.length > 6) return false;
  if (term.length > 52) return false;
  if (w.some(x => PRONOUN_WORD.has(x))) return false;       // "Nothing here", "... but it"
  if (w.some(x => NOT_A_TERM_WORD.has(x))) return false;     // a verb means this is a clause
  if (/[,;]$/.test(term.trim())) return false;
  // Don't let an entire sentence act as a name: too many ordinary lowercase words in a row.
  const lowercaseRun = term.split(/\s+/).filter(x => /^[a-z][a-z'-]*$/.test(x) && !STOPWORDS.has(x.toLowerCase())).length;
  if (lowercaseRun >= 5) return false;
  return true;
}

/** "Full Name (ACR)" → acronym term with its expansion as the definition. */
function findAcronymPairs(text) {
  const out = [];
  const re = /([A-Z][\w-]*(?:\s+(?:of|for|and|the|in|on)?\s*[A-Z][\w-]*){0,5})\s*\(([A-Z][A-Z0-9]{1,6})s?\)/g;
  let m;
  while ((m = re.exec(text))) {
    const full = normalize(m[1]).replace(/^(the|a|an)\s+/i, '');
    if (words(full).length < 2) continue;
    if (words(m[2]).length !== 1) continue;
    out.push({ term: m[2], definition: full, kind: 'acronym', expansionOf: m[2] });
    out.push({ term: full, definition: m[2], kind: 'expansion', short: m[2] });
  }
  return out;
}

/** Longest capitalized phrase in a sentence that isn't at the very start. */
function titleCaseConcepts(text) {
  const out = [];
  const toks = normalize(text).split(' ');
  for (let i = 0; i < toks.length; i++) {
    if (!/^[A-Z][a-zA-Z0-9'-]{0,24}$/.test(toks[i])) continue; // must start as a real capitalised word
    let j = i;
    while (j + 1 < toks.length && /^[A-Z][a-zA-Z0-9'-]{0,24}$/.test(toks[j + 1]) && !STOPWORDS.has(toks[j + 1].toLowerCase())) j++;
    if (j > i) {
      const phrase = toks.slice(i, j + 1).join(' ').replace(/[.,;:!?)]+$/, '');
      const n = words(phrase).length;
      if (n >= 2 && n <= 5 && i > 0 && !contentWords(phrase).every(w => BOILERPLATE.has(w))) out.push(phrase);
      i = j;
    }
  }
  return uniqueBy(out, p => p.toLowerCase());
}

/** Code, formulas and file paths make poor quiz terms — the real detector lives in code.js. */
export const looksLikeCode = isCodeLine;

export function findNumbers(text) {
  const out = [];
  const re = /\b(\d{1,4}(?:[.,]\d+)?%?)\b/g;
  let m;
  while ((m = re.exec(text))) {
    const num = m[1];
    if (/^\d{1,2}$/.test(num) && +num <= 20 && /^\s*(?:slide|page|chapter)/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push({ value: num, context: normalize(text) });
  }
  return uniqueBy(out, o => o.value);
}

function termWeight(term, kind) {
  const w = words(term).length;
  let score = 0;
  if (kind === 'colon' || kind === 'verb') score += 3;
  if (kind === 'acronym' || kind === 'expansion') score += 2.5;
  if (kind === 'bold') score += 1.5;
  if (isAcronym(term)) score += 0.5;
  if (w === 1) score += 0.6;
  if (w >= 2 && w <= 3) score += 0.8;
  score -= Math.max(0, w - 4) * 0.5;
  if (BOILERPLATE.has(term.toLowerCase())) score -= 4;
  if (STOPWORDS.has(term.toLowerCase())) score -= 3;
  if (/^\d/.test(term)) score -= 1;
  return score;
}

/** Detect list groups: a lead-in line followed by two or more sibling items. */
function findLists(lines) {
  const lists = [];
  const GOOD_LEAD = /^(there are|the (following|main|key|three|two|four|five)|types|kinds|categories|steps|stages|phases|examples|uses|benefits|advantages|disadvantages|limitations|features|characteristics|components|elements|parts|functions|roles|principles|rules|factors|reasons|goals|objectives|approaches|methods|ways)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const lead = lines[i];
    const leadText = lead.text;
    const leadOk = /:\s*$/.test(leadText) || (GOOD_LEAD.test(leadText) && words(leadText).length <= 12) || (words(leadText).length <= 10 && lead.heading);
    if (!leadOk) continue;
    const items = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      const isItem = (l.bullet || l.level > (lead.level || 0)) && words(l.text).length >= 2 && l.text.length <= 160;
      if (/:\s*$/.test(l.text)) break;
      if (!isItem) break;
      items.push(l.text);
      j++;
    }
    if (items.length >= 2) {
      lists.push({ lead: truncate(leadText, 90), items: items.slice(0, 8), slide: null });
      i = j - 1;
    }
  }
  return lists;
}

/** Strip a leading article so mined terms read as terms, not sentences. */
function trimArticle(term = '') {
  return term.replace(/^(?:a|an|the)\s+/i, '').trim() || term;
}

const GENERIC_TERMS = new Set(['introduction', 'conclusion', 'summary', 'overview', 'example', 'examples', 'objectives', 'agenda', 'outline', 'references', 'content', 'contents', 'week', 'lesson', 'chapter', 'topic', 'topics', 'slides', 'slide', 'page', 'note', 'notes', 'reminder', 'question', 'questions', 'answer', 'answers', 'activity', 'task', 'discussion']);

export function analyzeSlide(slide, deckCtx = {}) {
  const lines = (slide.lines || []).map(l => ({ ...l, text: normalize(l.text) })).filter(l => l.text);
  const rawTitle = cleanTitle(slide.title);
  // A title placeholder sometimes holds a whole paragraph — keep a readable short title.
  const fullTitle = rawTitle;
  let title = rawTitle;
  if (words(title).length > 12 || title.length > 95) {
    const clause = title.split(/(?<=[.!?,;:])\s/)[0] || title;
    title = clause.length > 12 ? truncate(clause, 72) : truncate(clause, 72);
  }
  if (!title) title = `Slide ${slide.index}`;
  const bodyText = lines.filter(l => l.text !== title).map(l => l.text).join('\n');
  const allText = `${title}\n${bodyText}${slide.notes ? '\n' + slide.notes : ''}`;

  const terms = new Map(); // lowercased term → term object
  const addTerm = (t) => {
    if (!t || !t.term) return;
    const key = t.term.toLowerCase();
    const cleaned = trimArticle(cleanTitle(t.term));
    if (!cleaned || cleaned.length < 2 || cleaned.length > 70) return;
    if (GENERIC_TERMS.has(cleaned.toLowerCase()) || BOILERPLATE.has(cleaned.toLowerCase())) return;
    if (!contentWords(cleaned).length && !isAcronym(cleaned)) return;
    if (isCodeLine(cleaned)) return;
    if (!t.definition && t.sourceLine && isCodeLine(t.sourceLine)) return;
    const definition = (t.definition || '').trim();
    const cand = {
      term: cleaned,
      definition,
      kind: t.kind || 'concept',
      short: t.short,
      weight: termWeight(cleaned, t.kind || 'concept'),
      slide: slide.index,
      sourceLine: t.sourceLine || '',
    };
    const prev = terms.get(key);
    if (!prev) { terms.set(key, cand); return; }
    // Prefer a candidate that actually carries a definition, and the richer wording.
    const better = (!prev.definition && cand.definition)
      || (!!cand.definition && cand.definition.length > (prev.definition || '').length + 12);
    if (better) terms.set(key, { ...cand, weight: Math.max(prev.weight, cand.weight) });
  };

  for (const line of lines) {
    const text = line.text;
    const fromColon = splitDefinition(text);
    if (fromColon) addTerm({ ...fromColon, sourceLine: text });
    else {
      const fromVerb = splitByVerb(text);
      if (fromVerb) addTerm({ ...fromVerb, sourceLine: text });
    }
    for (const pair of findAcronymPairs(text)) addTerm({ ...pair, sourceLine: text });
    if (line.bold && text.length <= 60 && !/[.?!]$/.test(text) && words(text).length <= 6) {
      addTerm({ term: text, definition: '', kind: 'bold', sourceLine: text });
    }
    if (line.heading && text.length <= 60 && words(text).length <= 7 && text.toLowerCase() !== title.toLowerCase()) {
      addTerm({ term: text, definition: '', kind: 'bold', sourceLine: text });
    }
    for (const phrase of titleCaseConcepts(text)) {
      addTerm({ term: phrase, definition: '', kind: 'concept', sourceLine: text });
    }
  }

  // Keep the strongest terms, but always keep any term that has a real definition.
  const ranked = [...terms.values()]
    .sort((a, b) => (b.weight + (b.definition ? 1.5 : 0)) - (a.weight + (a.definition ? 1.5 : 0)));
  const kept = [];
  const seen = new Set();
  for (const t of ranked) {
    const k = t.term.toLowerCase();
    if (seen.has(k)) continue;
    // Drop a bare concept that is just a prefix/suffix of a kept term.
    if (kept.some(x => x.term.toLowerCase().includes(k) || k.includes(x.term.toLowerCase())) && !t.definition) continue;
    seen.add(k);
    kept.push(t);
    if (kept.length >= 10) break;
  }

  const linesWithText = lines.map(l => l.text);
  const facts = [];
  for (const line of lines) {
    const w = words(line.text).length;
    if (w < 4) continue;
    if (line.text.toLowerCase() === title.toLowerCase()) continue;
    if (SKIP_TITLE_RE.test(line.text)) continue;
    if (looksLikeCode(line.text)) continue;          // code is shown, not quizzable
    if (/(.)\1{4,}|[|_]{3,}/.test(line.text)) continue; // ASCII diagrams
    facts.push({
      text: line.text,
      slide: slide.index,
      kind: /^if\b/i.test(line.text) ? 'rule' : line.bullet ? 'bullet' : 'statement',
      stems: keyStems(line.text),
      numbers: findNumbers(line.text),
      sentence: /[.!?]$/.test(line.text) ? line.text : `${line.text}.`,
    });
  }

  const numbers = uniqueBy(linesWithText.flatMap(findNumbers), n => n.value);
  const listGroups = findLists(lines).map(g => ({ ...g, slide: slide.index }));

  const quotaWords = new Set([...contentWords(title), ...kept.flatMap(t => contentWords(t.term))]);
  const topicStems = [...new Set([...keyStems(title), ...keyStems(bodyText)])].slice(0, 24);

  // Code on the slide is teachable material in its own right — never throw it away.
  const code = analyzeCode(lines, slide.notes || '');
  const codeLines = code.codeLineCount;
  const storyLines = lines.filter(l => words(l.text).length >= 4 && !isCodeLine(l.text)).length;
  const hasMaterial = facts.length >= 1 || kept.some(t => t.definition) || code.blocks.length > 0;
  const thin = !hasMaterial || (storyLines < 2 && !kept.some(t => t.definition) && code.codeLineCount < 3);
  const skipQuestions = thin || (SKIP_TITLE_RE.test(title) && !kept.some(t => t.definition) && code.blocks.length === 0);

  return {
    index: slide.index,
    title,
    fullTitle,
    rawTitle: slide.title,
    lines,
    notes: slide.notes || '',
    text: allText,
    bodyText,
    terms: kept,
    facts,
    numbers,
    lists: listGroups,
    topics: topicStems,
    titleWords: contentWords(title),
    quotaWords,
    source: slide.source,
    width: slide.width,
    height: slide.height,
    code,
    codeHeavy: lines.length > 2 && codeLines / lines.length > 0.5,
    role: null,
    roleWhy: '',
    skipQuestions,
  };
}

export function analyzeDeck(parsed) {
  const slides = (parsed.slides || []).map(s => analyzeSlide(s));

  // What each slide is FOR (cover, agenda, objectives, section, content, code, exercise…).
  slides.forEach((s, i) => {
    const verdict = classifySlide(s, i + 1, slides.length);
    s.role = verdict.role;
    s.roleWhy = verdict.why || '';
    s.roleDetail = verdict;
  });
  for (const s of slides) {
    if (UNQUIZZABLE.has(s.role)) { s.skipQuestions = true; continue; }
    if (s.role === ROLE.CODE && !s.code.blocks.length) { s.skipQuestions = true; continue; }
    // A thin prose slide is fine when it carries code to work through.
    if (s.skipQuestions && !s.code.blocks.length) continue;
    if (s.code.blocks.length) s.skipQuestions = false;
    const codable = s.code.blocks.length > 0
      || s.facts.length >= 1
      || s.terms.some(t => t.definition);
    if (!codable) s.skipQuestions = true;
  }

  const glossary = new Map();
  for (const s of slides) {
    for (const t of s.terms) {
      const key = t.term.toLowerCase();
      const prev = glossary.get(key);
      if (!prev) { glossary.set(key, { ...t }); continue; }
      const better = (!prev.definition && t.definition)
        || (!!t.definition && t.definition.length > (prev.definition || '').length + 12);
      if (better) glossary.set(key, { ...t });
      else prev.occurrences = (prev.occurrences || 1) + 1;
    }
  }
  const termsWithDefs = [...glossary.values()].filter(t => t.definition).length;
  const teachable = slides.filter(s => !s.skipQuestions).length;
  const deckTitle = (() => {
    const cover = slides.find(s => s.role === ROLE.COVER && words(s.title).length >= 2);
    if (cover) return cover.title;
    const first = slides.find(s => s.title && !SKIP_TITLE_RE.test(s.title) && words(s.title).length >= 2);
    return first ? first.title : (slides[0]?.title || 'Untitled lesson');
  })();

  const roadmap = buildRoadmap({ slides });
  const objectives = buildObjectives({ slides });
  const map = deckMap({ slides });
  const languages = new Map();
  for (const s of slides) {
    if (s.code?.blocks?.length && s.code.lang.id !== 'unknown') {
      languages.set(s.code.lang.id, (languages.get(s.code.lang.id) || 0) + 1);
    }
  }
  // Blocks that carry no language signal inherit the deck's dominant language
  // (a Java lecture's `do { } while(x);` line is still Java).
  const dominant = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominant) {
    const lang = DECK_LANGUAGES[dominant] || { id: dominant, label: dominant, ext: '.txt' };
    for (const s of slides) {
      if (!s.code?.blocks?.length || s.code.lang.id !== 'unknown') continue;
      s.code.lang = { id: lang.id, label: lang.label, ext: lang.ext, score: 0, inherited: true };
      for (const b of s.code.blocks) {
        b.lang = lang.id;
        b.langLabel = lang.label;
        b.ext = lang.ext;
      }
    }
  }

  return {
    kind: parsed.kind,
    slides,
    glossary,
    deckTitle,
    roadmap,
    objectives,
    map,
    stats: {
      slides: slides.length,
      teachable,
      terms: glossary.size,
      termsWithDefs,
      facts: slides.reduce((n, s) => n + s.facts.length, 0),
      questions: slides.reduce((n, s) => n + estimateQuestions(s), 0),
      imagesOnly: slides.filter(s => s.skipQuestions).length,
      codeSlides: map.codeSlides.length,
      languages: [...languages.keys()],
      roles: map.counts,
      roadmap: roadmap.length,
      objectives: objectives.length,
    },
  };
}

/** Cheap estimate used for the UI preview and tests (mirrors questions.js capacity). */
export function estimateQuestions(slide) {
  if (slide.skipQuestions) return 0;
  const defs = slide.terms.filter(t => t.definition).length;
  const facts = slide.facts.length;
  const code = slide.code?.blocks?.length ? 3 + Math.min(3, slide.code.blocks[0].lines.length) : 0;
  return Math.max(1, Math.min(9, defs * 2 + Math.min(3, Math.floor(facts / 2)) + slide.lists.length + code));
}

/** Look a term up in the deck glossary, tolerating near-misses in how the student phrases it. */
export function lookupTerm(glossary, query) {
  const q = normalize(query).replace(/^(what|who|which)\s+(is|are|was|were|does|do|did)\s+/i, '')
    .replace(/^(define|explain|describe|tell me about|what about|meaning of|definition of)\s+/i, '')
    .replace(/[?.\s]+$/, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  if (glossary.has(lower)) return glossary.get(lower);
  for (const [key, val] of glossary) {
    if (key === lower) return val;
    if (key.startsWith(lower) && lower.length >= 4) return val;
    if (val.short && val.short.toLowerCase() === lower) return val;
    if (lower.startsWith(key) && key.length >= 6) return val;
  }
  return null;
}

export { splitDefinition, splitByVerb, findLists, titleCaseConcepts };

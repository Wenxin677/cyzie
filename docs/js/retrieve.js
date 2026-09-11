/* Retrieval — finding the lines of the deck that answer a student's question.
   BM25 over slide sentences with term and title boosts. No server, no model. */

import { keyStems, normalize, contentWords, stem, truncate, similarity } from './nlp.js';

const K1 = 1.35;
const B = 0.62;

function tokens(text) {
  const st = keyStems(text);
  const grams = [];
  for (let i = 0; i < st.length - 1; i++) grams.push(`${st[i]}_${st[i + 1]}`);
  return st.concat(grams);
}

function splitSentences(text) {
  return normalize(text)
    .split(/(?<=[.;:!?])\s+/)
    .map(s => s.trim())
    .filter(s => contentWords(s).length >= 2);
}

export function buildIndex(deck) {
  const docs = [];
  const add = (text, slide, kind, weight = 1) => {
    const t = normalize(text);
    if (!t || t.length < 6) return;
    docs.push({ text: t, slide, kind, weight, tokens: tokens(t) });
  };
  for (const slide of deck.slides) {
    add(slide.title, slide.index, 'title', 1.6);
    const parts = splitSentences(slide.bodyText);
    const titled = [slide.title, ...parts];
    for (const p of parts.length ? parts : titled) add(p, slide.index, 'body', 1);
    if (slide.notes) for (const n of splitSentences(slide.notes)) add(n, slide.index, 'notes', 0.9);
  }
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, docs.length);
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
  return { deck, docs, idf, avgLen, N };
}

function scoreDoc(index, doc, queryTokens) {
  const tf = new Map();
  for (const t of doc.tokens) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  const len = doc.tokens.length || 1;
  for (const qt of queryTokens) {
    const f = tf.get(qt) || 0;
    if (!f) continue;
    const idf = index.idf.get(qt) || 0.3;
    score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / index.avgLen)));
  }
  return score * (doc.weight || 1);
}

/** @returns {{text, slide, slideTitle, kind, score}[]} */
export function search(index, query, { limit = 6, perSlide = 2 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const queryTokens = tokens(q);
  const scored = [];
  for (const doc of index.docs) {
    const s = scoreDoc(index, doc, queryTokens);
    if (s > 0) scored.push({ ...doc, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const perSlideCount = new Map();
  const out = [];
  for (const hit of scored) {
    const n = perSlideCount.get(hit.slide) || 0;
    if (n >= perSlide) continue;
    perSlideCount.set(hit.slide, n + 1);
    out.push({
      text: hit.text,
      slide: hit.slide,
      slideTitle: index.deck.slides.find(s => s.index === hit.slide)?.title || '',
      kind: hit.kind,
      score: hit.score,
    });
    if (out.length >= limit) break;
  }
  // Exact phrase hits outrank bag-of-words hits.
  const phrase = q.toLowerCase();
  for (const hit of out) {
    if (phrase.length >= 8 && hit.text.toLowerCase().includes(phrase)) hit.score += 2;
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export const LOW_CONFIDENCE = 1.6;

/* Words that describe the deck rather than its content ("this deck", "the next slide").
   On their own they must never be treated as a real match — a question like "what is the
   capital of a country not in this deck?" shares only "deck" with the slides. */
const META_PREFIXES = ['deck', 'slide', 'lesson', 'present', 'notebook', 'file', 'page', 'class',
  'course', 'chapter', 'lectur', 'unit', 'content', 'materi', 'topic', 'exampl', 'question',
  'part', 'summar', 'overal', 'thing', 'stuff', 'exam', 'test', 'stud', 'learn', 'teach', 'cover'];
const isMeta = s => META_PREFIXES.some(p => s.startsWith(p));

/** How much of the question's real subject matter the deck actually contains (0–1). */
export function queryCoverage(index, query) {
  const terms = [...new Set(keyStems(query))].filter(s => s.length > 3 && !isMeta(s));
  if (!terms.length) return { terms, matched: [], coverage: 0 };
  const matched = terms.filter(s => index.idf.has(s));
  return { terms, matched, coverage: matched.length / terms.length };
}

/**
 * Answer a free-form question from the deck.
 * @returns {{kind:'term'|'passage'|'none', hits:Array, confidence:number, closest:Array}}
 */
export function answerQuestion(deck, index, query, { lookupTerm } = {}) {
  const hits = search(index, query, { limit: 5 });
  const best = hits[0]?.score || 0;
  const closest = hits.slice(0, 3).map(h => ({ slide: h.slide, title: h.slideTitle }));
  if (lookupTerm) {
    const term = lookupTerm(query);
    if (term && term.definition) {
      return { kind: 'term', term, hits, confidence: Math.max(best, 3) };
    }
  }
  // A confident score is not enough on its own: the question must overlap the deck's actual
  // subject matter, or we admit we do not have it instead of answering from a stray word.
  const { terms, matched, coverage } = queryCoverage(index, query);
  if (best >= LOW_CONFIDENCE && (coverage >= 0.34 || matched.length >= 2)) {
    return { kind: 'passage', hits, confidence: best, closest, coverage };
  }
  return { kind: 'none', hits: hits.filter(h => h.score > best * 0.4), confidence: best, closest, coverage };
}

/** Slides whose content is closest to an arbitrary string (used for "where is X mentioned"). */
export function rankSlides(index, query) {
  const scores = new Map();
  for (const hit of search(index, query, { limit: 40, perSlide: 6 })) {
    scores.set(hit.slide, (scores.get(hit.slide) || 0) + hit.score);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([slide, score]) => ({ slide, score }));
}

export function highlight(text, query, max = 320) {
  const t = normalize(text);
  const terms = [...new Set(keyStems(query).filter(s => s.length > 2))];
  const out = truncate(t, max);
  return { text: out, terms };
}

export { tokens as indexTokens };

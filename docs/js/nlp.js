/* Cyzie — text utilities, tokenizing, stemming, ranking.
   No dependencies. Runs in the browser and in Node (for tests). */

export const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in into is isn't it its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that the their theirs them themselves then there these they this those through to too under until up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't you your yours yourself yourselves also may might shall will one two three three first second third use used using used given e.g i.e etc ie eg via per within across among upon whether either neither thus hence therefore however although though since while because able able`.split(/\s+/).filter(Boolean));

/* Words that carry no examinable meaning on a slide. */
export const BOILERPLATE = new Set(`slide slides chapter lecture week topic topics overview outline introduction intro summary recap review notes note example examples figure table page pages dr prof professor university course class today's agenda learning objectives outcomes references reference source sources thank thanks questions q a copy right reserved copyright`.split(/\s+/).filter(Boolean));

export function normalize(text = '') {
  return String(text)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into words, keeping internal hyphens/apostrophes and trailing digits. */
export function words(text = '') {
  return normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9'\-./]+/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[-'./]+|[-'./]+$/g, ''))
    .filter(Boolean);
}

/* Light Porter-ish suffix stripping. Enough for grading overlap; not a linguistics tool. */
export function stem(word = '') {
  let w = String(word).toLowerCase();
  if (w.length <= 3) return w;
  const rules = [
    [/(ies)$/, 'y'], [/(sses)$/, 'ss'], [/(ches|shes|xes|zes)$/, ''],
    [/([^s])s$/, '$1'], [/(ing)$/, ''], [/(edly|edness)$/, ''],
    [/(ed)$/, ''], [/(ly)$/, ''], [/(ment|ness|tion|sion)$/, ''],
    [/(ally|ily)$/, 'y'], [/(ise|ize)$/, ''], [/(ous|ive|ful)$/, ''],
  ];
  for (const [re, rep] of rules) {
    const next = w.replace(re, rep);
    if (next !== w && next.length >= 3) { w = next; break; }
  }
  return w;
}

export function contentWords(text = '') {
  return words(text).filter(w => w.length > 2 && !STOPWORDS.has(w) && !BOILERPLATE.has(w) && !/^\d+$/.test(w));
}

export function stems(text = '') {
  return contentWords(text).map(stem);
}

/** Unique content stems, order preserved. */
export function keyStems(text = '') {
  const seen = new Set();
  const out = [];
  for (const s of stems(text)) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}

export function isAcronym(token = '') {
  return /^[A-Z][A-Z0-9]{1,7}$/.test(token) && !/^\d+$/.test(token);
}

export function isTitleCasePhrase(phrase = '') {
  const parts = normalize(phrase).split(' ');
  if (parts.length < 1 || parts.length > 5) return false;
  if (parts.some(p => STOPWORDS.has(p.toLowerCase()) && p !== parts[0])) return false;
  const meaningful = parts.filter(p => p.length > 1);
  if (!meaningful.length) return false;
  return meaningful.every(p => /^[A-Z]/.test(p) || isAcronym(p));
}

export function levenshtein(a = '', b = '') {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Dice coefficient on bigrams — tolerant to typos, good for short answers. */
export function similarity(a = '', b = '') {
  const A = normalize(a).toLowerCase();
  const B = normalize(b).toLowerCase();
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 3 || B.length < 3) return A === B ? 1 : 0;
  const grams = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(A); const gb = grams(B);
  let overlap = 0;
  for (const [g, n] of ga) if (gb.has(g)) overlap += Math.min(n, gb.get(g));
  return (2 * overlap) / (A.length - 1 + B.length - 1);
}

/**
 * Coverage of expected key ideas by a learner's answer.
 * Returns {score, hits, missing} where score blends unigram coverage with phrase bonuses.
 */
export function coverAnswer(expectedStems = [], answer = '') {
  const given = new Set(stems(answer));
  const givenAll = words(answer).join(' ');
  const hits = []; const missing = [];
  for (const s of expectedStems) (given.has(s) ? hits : missing).push(s);
  const coverage = expectedStems.length ? hits.length / expectedStems.length : 0;
  const answerLen = words(answer).length;
  // Very short answers can't demonstrate understanding even if they name one keyword.
  const lengthFactor = Math.min(1, answerLen / Math.max(3, Math.min(12, expectedStems.length * 1.2)));
  const phraseBonus = expectedStems.length >= 3
    ? (givenAll.includes(expectedStems.slice(0, 2).join(' ')) ? 0.08 : 0)
    : 0;
  return { score: Math.max(0, Math.min(1, coverage * lengthFactor + phraseBonus)), hits, missing, coverage };
}

export function sentences(text = '') {
  const clean = normalize(text).replace(/\s*\n\s*/g, ' ');
  return clean
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map(s => s.trim())
    .filter(s => words(s).length >= 3);
}

export function titleCase(str = '') {
  return normalize(str).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1));
}

export function pct(x) { return Math.round(Math.max(0, Math.min(1, x)) * 100); }

export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

export function pick(arr, seed = Math.random()) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(seed * arr.length) % arr.length];
}

/** Deterministic shuffle (for reproducible tests). */
export function shuffle(arr, seed = 0.5) {
  const a = arr.slice();
  let s = Math.floor(seed * 2 ** 31) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function uniqueBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (k == null || seen.has(k)) continue;
    seen.add(k); out.push(item);
  }
  return out;
}

export function truncate(text = '', max = 120) {
  const t = normalize(text);
  return t.length <= max ? t : t.slice(0, max - 1).replace(/[,;:.\s]+$/, '') + '…';
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

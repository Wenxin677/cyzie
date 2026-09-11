/* Grading — how Cyzie reads an answer and decides what to say back.
   Returns structured verdicts; the tutoring voice lives in tutor.js. */

import { words, keyStems, stem, normalize, similarity, coverAnswer, truncate } from './nlp.js';

const YES = /^(y|ye|yes|yep|yeah|true|t|correct|right|sure|affirmative|it is|that's right|indeed)\b/i;
const NO = /^(n|no|nope|nah|false|f|incorrect|wrong|not|negative|that's wrong)\b/i;
/* Anchored at both ends on purpose: "Pass 0 Pass 1 Pass 2" is program output, not "I give up". */
const IDLE = /^(?:i\s*(?:don'?t|do not)\s*know|i\s*have no idea|no idea|dunno|i'?m not sure|not sure|idk|i give up|give up|skip it|pass|\?+|help)\s*[.!?…]*$/i;

function letterIndex(resp, n) {
  const m = normalize(resp).match(/^(?:option\s*)?([a-h])(?:[).:]|\s|$)/i);
  if (m) {
    const i = m[1].toLowerCase().charCodeAt(0) - 97;
    if (i >= 0 && i < n) return i;
  }
  const num = normalize(resp).match(/^(\d{1,2})(?:[).:]|\s|$)/);
  if (num) {
    const i = parseInt(num[1], 10) - 1;
    if (i >= 0 && i < n) return i;
  }
  return -1;
}

function multiChoiceVerdict(question, response) {
  const choices = question.choices;
  const text = normalize(response);
  let picked = -1;

  // 1. An answer that matches one of the options by text wins over letter/number shorthand:
  //    otherwise "2" would be read as "option 2" when the real answer is the value 2.
  const exact = choices.findIndex(c => normalize(c.text).toLowerCase() === text.toLowerCase());
  if (exact >= 0) picked = exact;
  if (picked < 0) {
    let best = { i: -1, score: 0 };
    choices.forEach((c, i) => {
      const s = similarity(c.text, text);
      if (s > best.score) best = { i, score: s };
    });
    if (best.score >= 0.72) picked = best.i;
  }

  // 2. Otherwise treat it as an option reference ("b", "option 3", "3").
  if (picked < 0) {
    const stripped = text.replace(/^option\s*/i, '');
    const idx = letterIndex(stripped, choices.length);
    if (idx >= 0) picked = idx;
  }

  if (picked < 0) return { verdict: 'unsure', score: 0, note: 'I could not tell which option you meant — answer with a letter or copy the option text.' };
  const chosen = choices[picked];
  const correctIdx = choices.findIndex(c => c.correct);
  if (chosen.correct) return { verdict: 'correct', score: 1, pickedIndex: picked };
  return {
    verdict: 'incorrect',
    score: 0,
    pickedIndex: picked,
    note: `You picked “${truncate(chosen.text, 120)}”, but the slide says “${truncate(choices[correctIdx].text, 120)}”.`,
  };
}

function trueFalseVerdict(question, response) {
  const t = normalize(response).toLowerCase();
  const said = YES.test(t) ? 'true' : NO.test(t) ? 'false' : null;
  if (!said) return { verdict: 'unsure', score: 0, note: 'Answer “true” or “false”.' };
  if (said === question.answer.text) return { verdict: 'correct', score: 1 };
  return { verdict: 'incorrect', score: 0 };
}

function itemMatches(item, answer) {
  const itemStems = keyStems(item);
  if (!itemStems.length) return false;
  const given = new Set(keyStems(answer));
  const hit = itemStems.filter(s => given.has(s)).length;
  return hit / itemStems.length >= 0.4 || hit >= 3;
}

function coverageVerdict(question, response) {
  const { keywords = [], items, target } = question.answer;
  if (items && items.length) {
    const matched = items.filter(i => itemMatches(i, response));
    const want = Math.min(target || 2, items.length);
    const score = Math.min(1, matched.length / Math.max(1, want));
    const missing = items.filter(i => !matched.includes(i));
    return {
      verdict: score >= 1 ? 'correct' : score >= 0.5 ? 'partial' : 'incorrect',
      score,
      matched: matched.map(i => truncate(i, 90)),
      missing: missing.map(i => truncate(i, 90)),
    };
  }
  const res = coverAnswer(keywords.map(k => stem(k)), response);
  const missing = res.missing.map(s => s);
  return {
    verdict: res.score >= 0.7 ? 'correct' : res.score >= 0.35 ? 'partial' : 'incorrect',
    score: res.score,
    matched: res.hits,
    missing,
  };
}

function termVerdict(question, response) {
  const want = question.answer.text;
  const alt = question.answer.alt || [];
  const t = normalize(response).toLowerCase();
  const sim = Math.max(similarity(want, response), ...alt.map(a => similarity(a, response)));
  if (t.includes(want.toLowerCase()) || sim >= 0.78) return { verdict: 'correct', score: 1 };
  if (sim >= 0.55) return { verdict: 'partial', score: 0.5, note: 'Very close — check the spelling/wording.' };
  return { verdict: 'incorrect', score: 0 };
}

function numericVerdict(question, response) {
  const target = question.answer.numeric ?? parseFloat(String(question.answer.text).replace(/[^\d.-]/g, ''));
  const wordsMap = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50, hundred: 100 };
  let given = parseFloat(normalize(response).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(given)) given = wordsMap[normalize(response).toLowerCase().trim()];
  if (!Number.isFinite(given) || !Number.isFinite(target)) return { verdict: 'unsure', score: 0, note: `Give me a number.` };
  if (given === target) return { verdict: 'correct', score: 1 };
  return { verdict: 'incorrect', score: 0, note: `I was looking for ${target}.` };
}

function codeOutputVerdict(question, response) {
  const expected = question.answer.sequence || [];
  const given = normalize(response).toLowerCase();
  if (!expected.length) {
    const sim = similarity(question.answer.text, response);
    return { verdict: sim >= 0.7 ? 'correct' : sim >= 0.4 ? 'partial' : 'incorrect', score: sim };
  }
  // Whole-sequence match first ("Pass 0 Pass 1 Pass 2" written out in one go).
  const joined = normalize(expected.join(' ')).toLowerCase();
  const squash = s => s.replace(/[^a-z0-9+.-]+/g, '');
  if (squash(given) === squash(joined) || squash(given).includes(squash(joined))) {
    return { verdict: 'correct', score: 1 };
  }
  // Otherwise match each expected output in order, allowing multi-word outputs.
  const tokens = normalize(given).split(/[^a-z0-9.'"+-]+/i).filter(Boolean);
  let cursor = 0;
  let hit = 0;
  for (const item of expected) {
    const want = normalize(item).toLowerCase().split(/\s+/).filter(Boolean);
    let found = false;
    for (let start = cursor; start + want.length <= tokens.length; start++) {
      if (want.every((w, k) => tokens[start + k] === w)) { cursor = start + want.length; found = true; break; }
    }
    if (found) hit++;
  }
  const score = hit / expected.length;
  if (score >= 0.9) return { verdict: 'correct', score };
  if (score >= 0.4) return { verdict: 'partial', score, note: `You had ${hit} of the ${expected.length} lines right, and they have to be in order.` };
  return { verdict: 'incorrect', score };
}

function codeErrorVerdict(question, response) {
  const t = normalize(response).toLowerCase();
  const wants = question.answer.keywords || [];
  const hits = wants.filter(k => t.includes(k)).length;
  const lineNo = (question.answer.also || [])[0];
  const rightLine = lineNo ? new RegExp(`\\bline\\s*${lineNo}\\b|\\b${lineNo}(?:st|nd|rd|th)\\b`).test(t) : false;
  if (hits >= 2 || (rightLine && hits >= 1)) return { verdict: 'correct', score: 1 };
  if (hits >= 1 || rightLine) return { verdict: 'partial', score: 0.5 };
  return { verdict: 'incorrect', score: 0 };
}

function codeRecallVerdict(question, response) {
  const target = question.answer.codeLine || question.answer.text;
  const got = normalize(response);
  const sim = similarity(target, got);
  const tokens = (question.answer.keywords || []);
  const gotTokens = new Set(keyStems(got));
  const hit = tokens.filter(k => gotTokens.has(stem(k))).length;
  const coverage = tokens.length ? hit / tokens.length : 0;
  const hasFirstToken = got.toLowerCase().includes(String(question.answer.firstToken || '').toLowerCase());
  if (sim >= 0.82 || (coverage >= 0.6 && hasFirstToken)) return { verdict: 'correct', score: 1 };
  if (sim >= 0.55 || (coverage >= 0.3 && hasFirstToken)) return { verdict: 'partial', score: 0.5, note: 'Close — check the punctuation and the exact wording.' };
  return { verdict: 'incorrect', score: 0 };
}

/**
 * @returns {{verdict:'correct'|'partial'|'incorrect'|'unsure', score:number, note?:string, missing?:string[]}}
 */
export function gradeAnswer(question, response) {
  const resp = normalize(response || '');
  if (!resp) return { verdict: 'unsure', score: 0, note: 'I did not catch an answer there.' };
  if (IDLE.test(resp)) return { verdict: 'unsure', score: 0, note: 'idle' };
  if (question.choices && question.choices.length) return multiChoiceVerdict(question, resp);
  switch (question.type) {
    case 'true_false': return trueFalseVerdict(question, resp);
    case 'cloze_type': return termVerdict(question, resp);
    case 'code_count': return numericVerdict(question, resp);
    case 'code_output': return codeOutputVerdict(question, resp);
    case 'code_error': return codeErrorVerdict(question, resp);
    case 'code_recall': return codeRecallVerdict(question, resp);
    case 'define_short':
    case 'gist_short':
    case 'list_recall': return coverageVerdict(question, resp);
    default:
      if (question.answer.text) {
        const s = similarity(question.answer.text, resp);
        return { verdict: s >= 0.7 ? 'correct' : s >= 0.4 ? 'partial' : 'incorrect', score: s };
      }
      return { verdict: 'unsure', score: 0 };
  }
}

/** Used by the progress panel and the end-of-lesson report. */
export function scoreBand(score) {
  if (score >= 0.85) return 'strong';
  if (score >= 0.6) return 'steady';
  if (score >= 0.35) return 'shaky';
  return 'weak';
}

export { IDLE, YES, NO };

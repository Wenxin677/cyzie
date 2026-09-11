/* Grading — how Cyzie reads an answer and decides what to say back.
   Returns structured verdicts; the tutoring voice lives in tutor.js. */

import { words, keyStems, stem, normalize, similarity, coverAnswer, truncate } from './nlp.js';

const YES = /^(y|ye|yes|yep|yeah|true|t|correct|right|sure|affirmative|it is|that's right|indeed)\b/i;
const NO = /^(n|no|nope|nah|false|f|incorrect|wrong|not|negative|that's wrong)\b/i;
const IDLE = /^(i\s*(don'?t|do not)\s*know|no idea|dunno|not sure|i'?m not sure|idk|\?+|pass|skip it|i give up|help)\b/i;

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
  const idx = letterIndex(text, choices.length);
  let picked = idx >= 0 ? idx : -1;
  if (picked < 0) {
    let best = { i: -1, score: 0 };
    choices.forEach((c, i) => {
      const s = similarity(c.text, text);
      if (s > best.score) best = { i, score: s };
    });
    if (best.score >= 0.6) picked = best.i;
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

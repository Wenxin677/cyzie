/* Deck intelligence — Cyzie's understanding of what each slide is FOR.
   Lecturers front-load covers, agendas, objectives and section dividers; those should be
   announced and mapped, not quizzed like content. This module classifies every slide,
   builds the roadmap from the agenda, and tracks the stated learning objectives. */

import { normalize, words, contentWords, keyStems, uniqueBy, truncate, BOILERPLATE } from './nlp.js';

export const ROLE = {
  COVER: 'cover',
  AGENDA: 'agenda',
  OBJECTIVES: 'objectives',
  SECTION: 'section',
  CONTENT: 'content',
  CODE: 'code',
  ACTIVITY: 'activity',
  QUIZ: 'quiz',
  RECAP: 'recap',
  REFERENCES: 'references',
  THANKS: 'thanks',
  VISUAL: 'visual',
};

export const ROLE_LABEL = {
  cover: 'Cover',
  agenda: 'Agenda',
  objectives: 'Objectives',
  section: 'Section',
  content: 'Content',
  code: 'Code',
  activity: 'Exercise',
  quiz: 'Quiz',
  recap: 'Recap',
  references: 'References',
  thanks: 'Closing',
  visual: 'Diagram',
};

/** Roles that Cyzie never quizzes: there is nothing to retrieve from them. */
export const UNQUIZZABLE = new Set([ROLE.COVER, ROLE.AGENDA, ROLE.OBJECTIVES, ROLE.SECTION, ROLE.REFERENCES, ROLE.THANKS, ROLE.VISUAL, ROLE.ACTIVITY, ROLE.QUIZ]);

const PATTERNS = [
  [ROLE.THANKS, /^(?:thank you|thanks|any questions|questions|end of|the end|goodbye|have a (?:great|good) (?:day|week|semester))/i],
  [ROLE.REFERENCES, /^(?:references?|bibliography|further reading|sources|useful links|reading list|further resources)/i],
  [ROLE.AGENDA, /^(?:agenda|outline|contents|table of contents|what we.?ll cover|what we will cover|what to expect|topics|course outline|roadmap|today.?s (?:plan|topics)|lesson (?:plan|outline)|module outline|schedule)/i],
  [ROLE.OBJECTIVES, /^(?:learning (?:objectives?|outcomes?|goals?)|objectives?|goals?|aims?|by the end of|you will be able to|at the end of this|what you.?ll learn|expected outcomes?|purpose of this)/i],
  [ROLE.RECAP, /^(?:recap|summary|summing up|key (?:points|takeaways?|ideas|concepts)|review|conclusion|wrap.?up|what we (?:covered|learned|did)|takeaways?|in summary|cheat ?sheet|quick reference)/i],
  [ROLE.ACTIVITY, /^(?:exercise|activity|practice|lab|task|workshop|discussion|group work|pair work|try it|your turn|hands.?on|assignment|homework|problem set|checkpoint|mini.?project|case study)/i],
  [ROLE.QUIZ, /^(?:quiz|test yourself|self.?check|knowledge check|questions? to (?:check|test)|practice questions?)/i],
  [ROLE.SECTION, /^(?:week|chapter|part|section|module|unit|topic|lecture|lesson)\s*\d*\b/i],
  [ROLE.COVER, /^(?:introduction(?: to)?|welcome|course (?:info|information|description|overview)|about this (?:course|module|unit)|overview of (?:the )?(?:course|module)|lecture \d+ ?[-:]|meet your (?:lecturer|tutor)|module (?:info|guide))/i],
];

function titleOf(slide) {
  return normalize(slide.fullTitle || slide.title || '');
}

function isItemLine(line) {
  const t = normalize(line.text || '');
  if (!t) return false;
  if (words(t).length < 2 || words(t).length > 18) return false;
  if (/^(contents?|agenda|outline|objectives?|summary|topics)$/i.test(t)) return false;
  return true;
}

function cleanTopic(raw = '') {
  return truncate(
    normalize(raw)
      .replace(/^[-•\u2022\u25cf\u25aa\u25e6\u2023\u2043\u00b7\u25a0\u25b8\u27a4\u2192*>\s]+/, '')
      .replace(/^\d{1,2}[.)]\s*/, '')
      .replace(/^(?:introduction to|intro to|overview of|basics of|fundamentals of)\s+/i, '')
      .replace(/[\s:;,.\-–—]+$/, ''),
    80,
  );
}

/** Classify one slide. `index` is 1-based, `total` is the deck size. */
export function classifySlide(slide, index, total) {
  const title = titleOf(slide);
  const lines = (slide.lines || []).filter(l => words(l.text).length >= 2);
  const code = slide.code || null;
  const hasCode = !!(code && code.codeLineCount >= 3);
  const definedTerms = (slide.terms || []).filter(t => t.definition).length;
  const proseLines = lines.filter(l => !(code && code.blocks.some(b => b.lines.includes(l.text))));
  const itemLines = lines.filter(isItemLine);
  const bodyWords = words(proseLines.map(l => l.text).join(' ')).length;

  const match = (patternsRole, text) => PATTERNS.find(([role]) => role === patternsRole)?.[1]?.test(text);
  const roleHit = (text) => {
    for (const [role, re] of PATTERNS) if (re.test(text)) return role;
    return null;
  };

  // A slide with no readable text at all (picture/decorative slide).
  if (!lines.length && !hasCode) {
    return { role: ROLE.VISUAL, why: 'no readable text on the slide' };
  }

  const byTitle = roleHit(title);
  const titleWordCount = words(title).length;

  // Closing / reference slides: short and self-describing.
  if (byTitle === ROLE.THANKS && lines.length <= 4) return { role: ROLE.THANKS, why: `titled “${title}”` };
  if (byTitle === ROLE.REFERENCES) return { role: ROLE.REFERENCES, why: `titled “${title}”` };

  // The very first slide of a deck, or a sparse opening slide, is the cover.
  const looksLikeCover = index <= 2 && definedTerms === 0 && !hasCode
    && (slide.facts?.length || 0) === 0
    && (index === 1 || proseLines.length <= 2)
    && itemLines.length < 3
    && titleWordCount <= 14 && bodyWords < 70;
  if (looksLikeCover) return { role: ROLE.COVER, why: 'first slide of the deck, no teachable content' };

  if (byTitle === ROLE.AGENDA && itemLines.length >= 2) return { role: ROLE.AGENDA, why: `lists what the deck covers` };
  if (byTitle === ROLE.OBJECTIVES && itemLines.length >= 1) return { role: ROLE.OBJECTIVES, why: 'states the learning objectives' };
  if (byTitle === ROLE.RECAP && itemLines.length >= 2) return { role: ROLE.RECAP, why: 'summarises earlier material' };
  if (byTitle === ROLE.ACTIVITY) return { role: ROLE.ACTIVITY, why: 'an exercise for the class to do' };
  if (byTitle === ROLE.QUIZ) return { role: ROLE.QUIZ, why: 'a self-check slide' };

  if (hasCode && (code.isCodeHeavy || code.codeLineCount >= 4)) {
    return { role: ROLE.CODE, why: `${code.codeLineCount} lines of ${code.lang.label} on the slide`, lang: code.lang.id };
  }

  if (byTitle === ROLE.SECTION) {
    const sparse = proseLines.length <= 4 || bodyWords < 40;
    return sparse
      ? { role: ROLE.SECTION, why: `a divider slide (“${truncate(title, 50)}”)` }
      : { role: ROLE.CONTENT, why: 'a titled content slide' };
  }
  if (byTitle === ROLE.COVER && proseLines.length <= 5) return { role: ROLE.COVER, why: `introductory slide (“${truncate(title, 40)}”)` };

  if (!proseLines.length && !hasCode) return { role: ROLE.VISUAL, why: 'nothing but a heading and a picture' };

  return { role: ROLE.CONTENT, why: '' };
}

/** Topics listed on the agenda slide(s), each mapped to the slides that cover it. */
export function buildRoadmap(deck) {
  const topics = [];
  const collectionSlides = deck.slides.filter(s => s.role === ROLE.AGENDA || s.role === ROLE.OBJECTIVES);
  for (const slide of collectionSlides) {
    for (const line of slide.lines) {
      if (!isItemLine(line)) continue;
      const label = cleanTopic(line.text);
      if (!label || label.length < 3) continue;
      const stems = keyStems(label);
      if (!stems.length) continue;
      topics.push({ label, from: slide.index, fromRole: slide.role, stems });
    }
  }

  const contentSlides = deck.slides.filter(s => [ROLE.CONTENT, ROLE.CODE, ROLE.RECAP].includes(s.role));
  for (const topic of topics) {
    const scored = contentSlides.map(s => {
      const pool = new Set([...(s.topics || []), ...keyStems(s.title)]);
      let hit = 0;
      for (const stem of topic.stems) if (pool.has(stem)) hit++;
      return { index: s.index, score: hit / Math.max(1, topic.stems.length) };
    }).sort((a, b) => b.score - a.score);
    topic.slides = scored.filter(x => x.score >= 0.34).map(x => x.index);
    topic.best = scored[0] && scored[0].score >= 0.34 ? scored[0].index : null;
  }
  return uniqueBy(topics, t => t.label.toLowerCase()).slice(0, 14);
}

/** The objectives slide's statements, each mapped to the slides that teach it. */
export function buildObjectives(deck) {
  const slide = deck.slides.find(s => s.role === ROLE.OBJECTIVES);
  if (!slide) return [];
  return slide.lines.filter(isItemLine).map(line => {
    const text = cleanTopic(line.text);
    const stems = keyStems(text);
    const mapped = deck.slides
      .filter(s => [ROLE.CONTENT, ROLE.CODE, ROLE.RECAP].includes(s.role))
      .map(s => {
        const pool = new Set([...(s.topics || []), ...keyStems(s.title)]);
        let hit = 0;
        for (const stem of stems) if (pool.has(stem)) hit++;
        return { index: s.index, score: hit / Math.max(1, stems.length) };
      })
      .filter(x => x.score >= 0.34)
      .map(x => x.index);
    return { text, from: slide.index, slides: mapped };
  }).filter(o => o.text.length > 6).slice(0, 10);
}

/** Summary of the deck's shape, used for the opening message and the progress panel. */
export function deckMap(deck) {
  const counts = {};
  for (const slide of deck.slides) counts[slide.role || ROLE.CONTENT] = (counts[slide.role || ROLE.CONTENT] || 0) + 1;
  const teachable = deck.slides.filter(s => !UNQUIZZABLE.has(s.role));
  const codeSlides = deck.slides.filter(s => s.role === ROLE.CODE);
  const langs = uniqueBy(codeSlides.map(s => s.code?.lang).filter(Boolean), l => l.id);
  return {
    counts,
    total: deck.slides.length,
    teachable: teachable.map(s => s.index),
    codeSlides: codeSlides.map(s => s.index),
    languages: langs,
    firstContent: teachable[0]?.index ?? null,
    agendaSlide: deck.slides.find(s => s.role === ROLE.AGENDA)?.index ?? null,
    objectivesSlide: deck.slides.find(s => s.role === ROLE.OBJECTIVES)?.index ?? null,
    closingSlide: deck.slides.find(s => s.role === ROLE.THANKS || s.role === ROLE.RECAP)?.index ?? null,
  };
}

/** Which objective is covered by which slide, scored against a finished session. */
export function evaluateObjectives(objectives, session) {
  return objectives.map(objective => {
    const slideScores = objective.slides
      .map(n => session.perSlide?.[n])
      .filter(Boolean)
      .filter(st => st.asked > 0);
    if (!slideScores.length) return { ...objective, status: 'untested', pct: null };
    const asked = slideScores.reduce((n, st) => n + st.asked, 0);
    const correct = slideScores.reduce((n, st) => n + st.correct, 0);
    const p = correct / Math.max(1, asked);
    return { ...objective, pct: Math.round(p * 100), status: p >= 0.7 ? 'demonstrated' : p >= 0.4 ? 'partial' : 'shaky' };
  });
}

export { cleanTopic, isItemLine, titleOf };

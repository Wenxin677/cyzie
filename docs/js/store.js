/* Local storage for lessons and transcripts. IndexedDB only — nothing leaves the browser. */

const DB_NAME = 'cyzie';
const DB_VERSION = 1;
const LESSONS = 'lessons';
const HISTORY = 'history';
const SETTINGS_KEY = 'cyzie:settings';

let dbPromise = null;
let storageDisabled = false;

/** Used by tests, and by the app when the browser blocks storage (private windows). */
export function disableStorage(reason = 'storage unavailable') {
  storageDisabled = true;
  dbPromise = Promise.reject(new Error(reason));
  dbPromise.catch(() => {});
}

export function storageAvailable() { return !storageDisabled; }

export function openDb() {
  if (storageDisabled) return Promise.reject(new Error('storage unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LESSONS)) {
        const store = db.createObjectStore(LESSONS, { keyPath: 'id' });
        store.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains(HISTORY)) {
        const h = db.createObjectStore(HISTORY, { keyPath: 'id' });
        h.createIndex('lessonId', 'lessonId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try { result = fn(store); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => ({ __req: req });

export function serializeDeck(deck, session) {
  return {
    deckTitle: deck.deckTitle,
    kind: deck.kind,
    stats: deck.stats,
    roadmap: deck.roadmap || [],
    objectives: deck.objectives || [],
    map: deck.map || null,
    slides: deck.slides.map(s => ({
      index: s.index, title: s.title, fullTitle: s.fullTitle, rawTitle: s.rawTitle,
      lines: s.lines, notes: s.notes, text: s.text, bodyText: s.bodyText,
      terms: s.terms, facts: s.facts, numbers: s.numbers, lists: s.lists,
      topics: s.topics, titleWords: s.titleWords, source: s.source,
      width: s.width, height: s.height, codeHeavy: s.codeHeavy, skipQuestions: s.skipQuestions,
      role: s.role, roleWhy: s.roleWhy, code: s.code || null,
    })),
    glossary: [...deck.glossary.entries()],
  };
}

export function reviveDeck(saved) {
  return {
    deckTitle: saved.deckTitle,
    kind: saved.kind,
    stats: saved.stats,
    roadmap: saved.roadmap || [],
    objectives: saved.objectives || [],
    map: saved.map || null,
    slides: saved.slides,
    glossary: new Map(saved.glossary || []),
  };
}

export async function saveLesson(lesson) {
  const record = { ...lesson, addedAt: lesson.addedAt || Date.now() };
  await tx(LESSONS, 'readwrite', store => wrap(store.put(record)));
  return record;
}

export async function listLessons() {
  const all = await tx(LESSONS, 'readonly', store => wrap(store.getAll()));
  return (all || []).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .map(l => ({
      id: l.id, name: l.name, deckTitle: l.deckTitle, addedAt: l.addedAt,
      stats: l.stats, progress: l.progress, fileName: l.fileName,
    }));
}

export async function getLesson(id) {
  return tx(LESSONS, 'readonly', store => wrap(store.get(id)));
}

export async function deleteLesson(id) {
  await tx(LESSONS, 'readwrite', store => wrap(store.delete(id)));
  await tx(HISTORY, 'readwrite', store => wrap(store.delete(id)));
}

export async function clearAll() {
  await tx(LESSONS, 'readwrite', store => wrap(store.clear()));
  await tx(HISTORY, 'readwrite', store => wrap(store.clear()));
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
}

/** Transcript snapshot per lesson (kept small: text + metadata only). */
export async function saveTranscript(lessonId, messages, sessionSnapshot) {
  const record = {
    id: lessonId,
    lessonId,
    savedAt: Date.now(),
    session: sessionSnapshot,
    messages: (messages || []).slice(-300).map(m => ({
      role: m.role, text: m.text, kind: m.kind, tone: m.tone, slide: m.slide,
      chips: m.chips, sources: m.sources,
      questionId: m.questionId, questionType: m.questionType,
      choices: m.choices ? m.choices.map(c => ({ text: c.text, correct: !!c.correct })) : undefined,
    })),
  };
  await tx(HISTORY, 'readwrite', store => wrap(store.put(record)));
  return record;
}

export async function getTranscript(lessonId) {
  return tx(HISTORY, 'readonly', store => wrap(store.get(lessonId)));
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { learner: '', density: 'standard', theme: 'light', ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { learner: '', density: 'standard', theme: 'light' };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function estimateBytes(record) {
  try { return new Blob([JSON.stringify(record)]).size; } catch { return 0; }
}

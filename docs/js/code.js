/* Cyzie's coding layer — language detection, code-block extraction, syntax highlighting,
   structural reading of code, and a tiny simulator for simple counter loops.
   Everything here is derived from the slide's own code: no invented APIs. */

import { normalize, words, escapeHtml, uniqueBy, truncate } from './nlp.js';

/* ------------------------------------------------------------- languages --- */

export const LANGUAGES = [
  { id: 'python', label: 'Python', ext: '.py', signals: [
    /\bdef\s+\w+\s*\(/, /\bself\b/, /\belif\b/, /\bprint\s*\(/, /^\s*import\s+\w+/m, /\bNone\b/, /\bTrue\b|\bFalse\b/, /:\s*$/m, /\brange\s*\(/,
  ] },
  { id: 'java', label: 'Java', ext: '.java', signals: [
    /\bpublic\s+(static\s+)?(void|int|String|double|boolean|class)\b/, /\bSystem\.out\.print/, /\bnew\s+[A-Z]\w*\s*\(/, /\bString\[\]/, /\bimport\s+java\./,
  ] },
  { id: 'javascript', label: 'JavaScript', ext: '.js', signals: [
    /\b(const|let)\s+\w+\s*=/, /\bfunction\s+\w+\s*\(/, /console\.log/, /=>/, /\bdocument\./, /\bvar\s+\w+\s*=/,
  ] },
  { id: 'c', label: 'C', ext: '.c', signals: [/#include\s*</, /\bprintf\s*\(/, /\bscanf\s*\(/, /\bint\s+main\s*\(/] },
  { id: 'cpp', label: 'C++', ext: '.cpp', signals: [/#include\s*<iostream>/, /\bstd::/, /\bcout\s*<</, /\bcin\s*>>/] },
  { id: 'csharp', label: 'C#', ext: '.cs', signals: [/\bConsole\.WriteLine/, /\busing\s+System;/, /\bnamespace\s+\w+/] },
  { id: 'sql', label: 'SQL', ext: '.sql', signals: [/\bSELECT\b[\s\S]{0,80}\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bWHERE\b/i] },
  { id: 'html', label: 'HTML', ext: '.html', signals: [/<(!DOCTYPE|html|div|span|body|head|p|a|ul|li)\b/i] },
  { id: 'css', label: 'CSS', ext: '.css', signals: [/[.#]?[\w-]+\s*\{[^}]*:[^}]*;\s*\}/] },
  { id: 'shell', label: 'Shell', ext: '.sh', signals: [/^\s*\$\s+\w+/m, /\bsudo\b/, /\bapt(-get)?\s+install\b/, /\bgit\s+(clone|commit|push)\b/] },
];

export function detectLanguage(text = '') {
  const t = normalize(text);
  if (!t) return { id: 'unknown', label: 'Code', ext: '.txt', score: 0 };
  let best = { id: 'unknown', label: 'Code', ext: '.txt', score: 0 };
  for (const lang of LANGUAGES) {
    let score = 0;
    for (const re of lang.signals) if (re.test(t)) score += 1;
    if (score > best.score) best = { id: lang.id, label: lang.label, ext: lang.ext, score };
  }
  return best;
}

/* --------------------------------------------------------------- blocks --- */

/** A line is a standalone code line when it carries syntax, not prose. */
export function isCodeLine(raw = '') {
  const t = normalize(raw);
  if (!t) return false;
  if (t.length > 160) return false;

  // A bullet that reads like a sentence is prose, even though it starts with a dash.
  const proseBullet = /^[-*•\u2022\u25cf\u25aa]\s+[A-Z]/.test(t)
    && words(t).length >= 4
    && !/[;{}()=<>]|=>|\bprint\s*\(/.test(t)
    && /\b(is|are|was|were|means|refers|the|a|an|of|to|that|which|in|for)\b/.test(t);
  if (proseBullet) return false;

  if (/[{};]$/.test(t)) return true;
  if (/^\s*(\/\/|#|--|\*)\s/.test(t)) return true;                 // comments
  if (/^\s*(if|else|elif|for|while|do|switch|case|try|catch|except|finally|def|function|class|return|break|continue|pass|import|from|package|public|private|protected|static|void|final|new|delete|throw|yield|async|await)\b/.test(t)) return true;
  if (/\b(System\.out\.(print|println)|console\.log|printf|scanf|cout|cin|print\s*\()/.test(t)) return true;
  if (/(^|\s)(int|float|double|char|bool|boolean|String|var|let|const|long|short|unsigned|struct)\s+\w+\s*(=|;|,|\[)/.test(t)) return true;
  if (/^\s*[\w.$\[\]]+\s*(=|\+=|-=|\*=|\/=|\+\+|--)\s*[^\s]/.test(t) && !/\b(is|are|was|were|means|refers)\b/.test(t)) return true;
  if (/^\s*[\w.$\[\]]+\s*\([^)]*\)\s*;?\s*$/.test(t)) return true;   // bare call
  if (/^\s*[<>!=+/%&|^]=?\s/.test(t)) return true;                   // operators (not "-" or "*": those are bullets in prose)
  if (/[a-z][A-Z]\w*\s*\(/.test(t)) return true;                     // camelCase call
  if (/^\s*(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE)\b/i.test(t)) return true;
  if (/^\s*[.#]?[\w-]+\s*\{/.test(t)) return true;
  return false;
}

/** Group consecutive code lines into blocks (keeping the nearest lead-in line as context). */
export function extractCodeBlocks(lines = []) {
  const blocks = [];
  let current = null;
  lines.forEach((line, i) => {
    const text = line.text || '';
    const codeish = isCodeLine(text);
    if (codeish) {
      if (!current) {
        // Look back for a lead-in like "Example:" or "Output:".
        const lead = lines[i - 1]?.text || '';
        current = { lead: !isCodeLine(lead) && words(lead).length <= 14 ? lead : '', start: i, lines: [] };
      }
      current.lines.push(text);
    } else if (current) {
      const pending = current;
      const next = lines[i]?.text || '';
      // A blank or short prose line between code lines should not break the block.
      const nextIsCode = isCodeLine(next);
      if (!nextIsCode) { blocks.push(pending); current = null; }
      else pending.lines.push(text);
    }
  });
  if (current) blocks.push(current);

  return blocks
    .filter(b => b.lines.length >= 1)
    .map(b => {
      const code = b.lines.join('\n');
      const lang = detectLanguage(code);
      return {
        code,
        lines: b.lines,
        lead: b.lead,
        lang: lang.id,
        langLabel: lang.label,
        ext: lang.ext,
        size: b.lines.length,
      };
    });
}

/* ---------------------------------------------------------- highlighting --- */

const KEYWORDS = {
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self None True False print range len input int str float list dict set tuple'.split(' '),
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public return short static super switch synchronized this throw throws try void volatile while String System out println print true false null'.split(' '),
  javascript: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined console document window'.split(' '),
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while printf scanf include define true false NULL'.split(' '),
  cpp: 'auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while cout cin endl std string include'.split(' '),
  csharp: 'abstract as bool break byte case catch class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get if implicit in int interface internal is lock namespace new null object out override private protected public readonly ref return set sealed short sizeof static string struct switch this throw true try typeof uint ulong using var virtual void while Console WriteLine'.split(' '),
  sql: 'select from where group by order having insert into values update set delete create table drop alter join left right inner outer on as and or not null distinct limit offset count sum avg min max'.split(' '),
  html: 'html head body div span p a ul ol li table tr td th img script style link meta title h1 h2 h3 h4 h5 h6 form input button'.split(' '),
  css: 'color background margin padding border display flex grid position top left right bottom width height font size weight'.split(' '),
  shell: 'cd ls rm cp mv mkdir echo sudo apt git python pip node npm curl cat grep chmod export'.split(' '),
};

const LANGUAGE_COMMENT = { python: '#', shell: '#', sql: '--', html: null, css: null };

/** Offline syntax highlighter. Escapes everything; never trusts the source. */
export function highlightCode(code = '', langId = 'unknown') {
  const keywords = new Set(KEYWORDS[langId] || []);
  const commentToken = LANGUAGE_COMMENT[langId] || '//';
  const src = String(code);
  let out = '';
  let i = 0;
  const n = src.length;

  const isWordChar = c => /[A-Za-z0-9_$]/.test(c);
  const htmlComment = langId === 'html';

  while (i < n) {
    const c = src[i];
    const rest = src.slice(i);

    // Comments to end of line
    if (!htmlComment && rest.startsWith(commentToken) && !(commentToken === '//' && rest.startsWith('///'))) {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += `<span class="tok-com">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    if (htmlComment && rest.startsWith('<!--')) {
      const end = src.indexOf('-->', i);
      const stop = end === -1 ? n : end + 3;
      out += `<span class="tok-com">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // Block comments /* */
    if (!htmlComment && rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += `<span class="tok-com">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // Strings
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      const stop = Math.min(n, j + 1);
      out += `<span class="tok-str">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) && (i === 0 || !isWordChar(src[i - 1]))) {
      let j = i;
      while (j < n && /[0-9._xXa-fA-F]/.test(src[j])) j++;
      out += `<span class="tok-num">${escapeHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // Words
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      const word = src.slice(i, j);
      const after = src.slice(j).match(/^\s*\(/);
      const lower = word.toLowerCase();
      if (keywords.has(word) || keywords.has(lower)) out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
      else if (after) out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) out += `<span class="tok-cls">${escapeHtml(word)}</span>`;
      else out += escapeHtml(word);
      i = j;
      continue;
    }
    // Operators / punctuation
    if (/[=+\-*/%<>!&|^~?:]/.test(c)) {
      out += `<span class="tok-op">${escapeHtml(c)}</span>`;
      i++;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

/* ------------------------------------------------------- reading code --- */

export function codeLines(code = '') {
  return String(code).split('\n').filter(l => l.trim().length);
}

function indentOf(line = '') { return (line.match(/^\s*/) || [''])[0].length; }

/** The body of a block: indentation when the source kept it, otherwise the run of lines
 *  that follow until the next top-level statement. Slide decks often lose leading spaces,
 *  so the structural fallback matters for Python. */
function codeBody(lines, headerIndex, { python = false, max = 6 } = {}) {
  const body = [];
  const headerIndent = indentOf(lines[headerIndex] || '');
  for (let j = headerIndex + 1; j < lines.length && body.length < max; j++) {
    const raw = lines[j];
    if (!raw || !raw.trim()) { if (!body.length) continue; break; }
    const ind = indentOf(raw);
    const trimmed = raw.trim();
    if (ind > headerIndent) { body.push(trimmed); continue; }
    if (ind === headerIndent && ind > 0) break;   // real dedent ends the block
    // No indentation information left in the text: fall back to structure.
    if (python) {
      if (/^(for|while|if|elif|else|def|class|try|except|finally|import|from)\b/.test(trimmed)) break;
      if (/^#/.test(trimmed)) break;
      body.push(trimmed);
      continue;
    }
    if (/^(for|while|if|else|public|private|static|void|class|return|int|double|String|System|#include|\/\/)/.test(trimmed)) break;
    body.push(trimmed);
    break;                                        // one unbraced statement is the whole body
  }
  return body;
}

/** Named things the code declares: functions, classes, variables. */
export function codeSymbols(code = '', langId = 'unknown') {
  const out = { functions: [], classes: [], variables: [], calls: [], imports: [] };
  for (const line of codeLines(code)) {
    let m;
    if ((m = line.match(/\bdef\s+(\w+)\s*\(([^)]*)\)/))) out.functions.push({ name: m[1], args: m[2], line });
    else if ((m = line.match(/\b(?:public|private|protected|static|final|\s)*[\w<>\[\]]+\s+(\w+)\s*\(([^)]*)\)\s*\{/))) out.functions.push({ name: m[1], args: m[2], line });
    else if ((m = line.match(/\bfunction\s+(\w+)\s*\(([^)]*)\)/))) out.functions.push({ name: m[1], args: m[2], line });
    if ((m = line.match(/\bclass\s+(\w+)/))) out.classes.push({ name: m[1], line });
    if ((m = line.match(/\bimport\s+([\w.*{}, ]+)/))) out.imports.push({ what: m[1].trim(), line });
    if ((m = line.match(/\b(?:int|float|double|char|bool|boolean|String|var|let|const|long|short)\s+(\w+)\s*(?:=|;|,|\[)/))) out.variables.push({ name: m[1], line });
    if ((m = line.match(/^\s*(\w+)\s*=\s*[^=]/)) && !/\b(if|while|for|return)\b/.test(line)) out.variables.push({ name: m[1], line });
    for (const call of line.matchAll(/\b([A-Za-z_][\w.]*)\s*\(/g)) {
      if (/^(if|for|while|switch|catch|return|def|function|class|new)$/.test(call[1])) continue;
      out.calls.push({ name: call[1], line });
    }
  }
  return {
    functions: uniqueBy(out.functions, f => f.name),
    classes: uniqueBy(out.classes, c => c.name),
    variables: uniqueBy(out.variables, v => v.name),
    calls: uniqueBy(out.calls, c => c.name),
    imports: out.imports,
  };
}

/** Which constructs appear, and how many times. */
export function codeConstructs(code = '', langId = 'unknown') {
  const t = code;
  const found = [];
  const add = (kind, label, re) => { const m = t.match(re); if (m) found.push({ kind, label, sample: m[0].trim() }); };
  add('for', langId === 'python' ? 'a for loop' : 'a for loop', /\bfor\s*\(?[^\n]*/);
  add('while', 'a while loop', /\bwhile\s*\(?[^\n]*/);
  add('dowhile', 'a do-while loop', /\bdo\s*\{/);
  add('foreach', 'a for-each loop', /\b(foreach|for\s*\([^;]*:[^;]*\))/);
  add('if', 'an if statement', /\b(if|elif)\s*\(?[^\n]*/);
  add('else', 'an else branch', /\belse\b/);
  add('switch', 'a switch/match statement', /\b(switch|match)\s*\(?[^\n]*/);
  add('function', 'a function definition', /\b(def|function)\s+\w+\s*\([^)]*\)/);
  add('method', 'a method definition', /\b(public|private|protected|static)[\w\s<>\[\]]*\s\w+\s*\([^)]*\)\s*\{/);
  add('class', 'a class', /\bclass\s+\w+/);
  add('return', 'a return statement', /\breturn\b[^\n]*/);
  add('print', 'an output statement', /\b(print|println|printf|cout|console\.log|System\.out\.print\w*)\b[^\n]*/);
  add('import', 'an import', /\b(import|#include|using)\b[^\n]*/);
  add('array', 'an array or list', /\b(new\s+\w+\s*\[|\[\s*\w+\s*\]|list\(|\[\]|ArrayList)/);
  add('increment', 'a counter update', /\b(\w+\+\+|\+\+\w+|\w+\s*\+=|\w+\s*-=)/);
  add('compare', 'a comparison', /(==|!=|<=|>=|<|>)/);
  add('try', 'error handling', /\b(try|catch|except)\b/);
  add('break', 'a break/continue', /\b(break|continue)\b/);
  add('call', 'a function call', /\b\w+\s*\([^)]*\)\s*;?/);
  return found;
}

/** Plain-English reading of one line of code, so Cyzie can walk a slide line by line. */
export function readLine(line = '', langId = 'unknown') {
  const t = line.trim();
  if (!t) return '';
  let m;
  if ((m = t.match(/^for\s+(\w+)\s+in\s+range\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(-?\d+))?\s*\)\s*:/))) {
    const [_, v, a, b, step] = m;
    const stepN = step ? parseInt(step, 10) : 1;
    const count = Math.max(0, Math.ceil((parseInt(b, 10) - parseInt(a, 10)) / (stepN || 1)));
    return `starts ${v} at ${a}, keeps going while ${v} is below ${b}${step ? ` in steps of ${step}` : ''} — the body runs ${count} time${count === 1 ? '' : 's'}`;
  }
  if ((m = t.match(/^for\s+(\w+)\s+in\s+(\w+)/))) {
    return `takes each value from ${m[2]} in turn, calling it ${m[1]}`;
  }
  if ((m = t.match(/^for\s*\(\s*(?:int\s+)?(\w+)\s*=\s*(\d+)\s*;\s*\1\s*(<|<=|>|>=)\s*(\d+)\s*;\s*\1\s*(\+\+|--|\+=\s*(\d+)|-=\s*(\d+))/))) {
    const [_, v, start, op, bound, stepTok, plus, minus] = m;
    const stepN = plus ? parseInt(plus, 10) : minus ? -parseInt(minus, 10) : (stepTok === '--' ? -1 : 1);
    const lo = parseInt(start, 10); const hi = parseInt(bound, 10);
    let count = 0;
    if (stepN > 0 && (op === '<' || op === '<=')) count = Math.max(0, Math.ceil((hi - lo + (op === '<=' ? 1 : 0)) / stepN));
    else if (stepN < 0 && (op === '>' || op === '>=')) count = Math.max(0, Math.ceil((lo - hi + (op === '>=' ? 1 : 0)) / -stepN));
    return `runs ${v} from ${start} while it stays ${op === '<' ? 'below' : op === '<=' ? 'at or below' : op === '>' ? 'above' : 'at or above'} ${bound}, changing it each pass — the body runs ${count} time${count === 1 ? '' : 's'}`;
  }
  if ((m = t.match(/^while\s*\(?\s*(\w+)\s*(<|<=|>|>=|==|!=)\s*(\d+)/))) {
    return `keeps looping while ${m[1]} is ${m[2]} ${m[3]}`;
  }
  if ((m = t.match(/^(if|elif)\s*\(?\s*(.+?)\s*[:,]?\s*$/))) {
    return `checks whether ${humanCondition(m[2])}, and only then runs what is indented underneath`;
  }
  if ((m = t.match(/^else\s*[:{]?/))) return 'the branch that runs when the check above is false';
  if ((m = t.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:void|int|double|String|float|boolean|bool|[\w<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/)) && !/^(if|while|for|switch)$/.test(m[1])) {
    const args = m[2].trim();
    return `defines a method called ${m[1]}${args ? ` that takes ${args.split(',').map(a => a.trim().split(' ').pop()).join(', ')}` : ' with no inputs'}`;
  }
  if ((m = t.match(/^def\s+(\w+)\s*\(([^)]*)\)/))) {
    const args = m[2].trim();
    return `defines a function called ${m[1]}${args ? ` that takes ${args.split(',').map(a => a.trim()).join(', ')}` : ' with no inputs'}`;
  }
  if ((m = t.match(/^\s*(?:System\.out\.println|console\.log|print|printf|cout)\s*\(?\s*(.+?)\s*\)?\s*;?\s*$/))) {
    const arg = m[1].replace(/^"|"$/g, '');
    return `prints ${/^["']/.test(m[1]) ? `the text “${truncate(arg, 60)}”` : `the value of ${truncate(arg, 40)}`}`;
  }
  if ((m = t.match(/^return\s+(.+?);?\s*$/))) return `hands ${truncate(m[1], 40)} back to whoever called this`;
  if ((m = t.match(/^(?:int|float|double|char|bool|boolean|String|long|short|var|let|const)\s+(\w+)\s*=\s*(.+?);?\s*$/))) return `creates ${m[1]} and sets it to ${humanValue(m[2])}`;
  if ((m = t.match(/^(\w+)\s*=\s*(.+?);?\s*$/) )) return `sets ${m[1]} to ${humanValue(m[2])}`;
  if ((m = t.match(/^(\w+\+\+|\+\+\w+|\w+\s*[-+*/]?=\s*\d+)/))) return `changes a counter: ${m[1]}`;
  if ((m = t.match(/^(\w+)\s*\('([^')]*)'\)/))) return `calls ${m[1]}()`;
  if ((m = t.match(/^import\s+(.+?);?\s*$/))) return `brings in ${m[1]} so the code can use it`;
  if ((m = t.match(/^#include\s*<(.+?)>/))) return `brings in the ${m[1]} library`;
  if ((m = t.match(/^class\s+(\w+)/))) return `starts a class named ${m[1]}`;
  if (/^(\/\/|#|--)/.test(t)) return `a comment — the author's own note, ignored by the computer`;
  if (/^\s*[\{\}]/.test(t)) return '';
  return '';
}

function humanCondition(cond = '') {
  const c = cond.replace(/[():]/g, ' ').trim();
  const m = c.match(/^(\w+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (!m) return truncate(c, 60);
  const [, left, op, right] = m;
  const ops = { '==': 'is equal to', '!=': 'is not equal to', '<': 'is less than', '>': 'is greater than', '<=': 'is at most', '>=': 'is at least' };
  return `${left} ${ops[op] || op} ${right}`;
}

function humanValue(v = '') {
  const t = v.trim();
  if (/^["'].*["']$/.test(t)) return `the text ${truncate(t, 50)}`;
  if (/^-?\d+(\.\d+)?$/.test(t)) return `the number ${t}`;
  if (/^(true|false|True|False)$/.test(t)) return `the truth value ${t}`;
  return `the result of ${truncate(t, 50)}`;
}

/** A line-by-line walkthrough Cyzie can teach from. */
export function walkthrough(code = '', langId = 'unknown') {
  return codeLines(code)
    .map((line, i) => ({ n: i + 1, line, meaning: readLine(line, langId) }))
    .filter(row => row.meaning);
}

/* ------------------------------------------------- simulation (narrow) --- */

/**
 * Evaluate the tiny subset of loops Cyzie sees most often: a counter that counts to a
 * literal bound while printing its value. Returns null when the code is outside that subset —
 * in that case Cyzie will not claim to know the output.
 */
export function simulateOutput(code = '', langId = 'unknown') {
  const lines = codeLines(code);
  const outputs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // python: for x in range(a, b): with an indented print underneath
    let m = line.match(/^for\s+(\w+)\s+in\s+range\(\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,\s*(-?\d+))?\s*\)\s*:/);
    if (m) {
      const [_, v, a, b, step] = m;
      const body = codeBody(lines, i, { python: true });
      const printed = pythonPrintTarget(body, v);
      if (printed === null) return null;
      const from = parseInt(a, 10); const to = parseInt(b, 10); const st = step ? parseInt(step, 10) : 1;
      if (st === 0) return null;
      for (let x = from; st > 0 ? x < to : x > to; x += st) outputs.push(printed(x, v));
      i = i + 1 + body.length;
      continue;
    }

    // java / C style: for (int i = a; i < b; i++) { println(i); }
    m = line.match(/for\s*\(\s*(?:int\s+)?(\w+)\s*=\s*(-?\d+)\s*;\s*\1\s*(<|<=|>|>=)\s*(-?\d+)\s*;\s*\1\s*(\+\+|--|\+=\s*(\d+)|-=\s*(\d+))\s*\)/);
    if (m) {
      const [_, v, start, op, bound, stepTok, plus, minus] = m;
      const body = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*(for|while|if|else|public|private|static|class|\}|return)\b/.test(lines[j].trim())) { body.push(lines[j].trim()); j++; }
      const printed = javaPrintTarget(body, v);
      if (printed === null) return null;
      const from = parseInt(start, 10); const to = parseInt(bound, 10);
      const step = plus ? parseInt(plus, 10) : minus ? -parseInt(minus, 10) : (stepTok === '--' ? -1 : 1);
      if (step === 0) return null;
      let guard = 0;
      for (let x = from; guard++ < 10000; x += step) {
        const keepGoing = op === '<' ? x < to : op === '<=' ? x <= to : op === '>' ? x > to : x >= to;
        if (!keepGoing) break;
        outputs.push(printed(x, v));
      }
      i = j;
      continue;
    }

    // while (i < n) { ...; i++; }
    m = line.match(/while\s*\(?\s*(\w+)\s*(<|<=|>|>=)\s*(-?\d+)/);
    if (m) {
      const [_, v, op, bound] = m;
      const body = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*(for|while|if|else|public|private|static|class|\}|return)\b/.test(lines[j].trim())) { body.push(lines[j].trim()); j++; }
      const printed = javaPrintTarget(body, v) ?? pythonPrintTarget(body, v);
      if (printed === null) return null;
      const stepMatch = body.join(' ').match(new RegExp(`\\b${v}\\s*(\\+\\+|--)|\\b${v}\\s*\\+=\\s*(\\d+)|\\b${v}\\s*-=\\s*(\\d+)`));
      if (!stepMatch) return null;
      const step = stepMatch[2] ? parseInt(stepMatch[2], 10) : stepMatch[3] ? -parseInt(stepMatch[3], 10) : (stepMatch[1] === '--' ? -1 : 1);
      let start = null;
      for (let k = 0; k < i; k++) {
        const init = lines[k].match(new RegExp(`(?:int\\s+)?${v}\\s*=\\s*(-?\\d+)`));
        if (init) start = parseInt(init[1], 10);
      }
      if (start === null) return null;
      let guard = 0;
      for (let x = start; guard++ < 10000; x += step) {
        const keepGoing = op === '<' ? x < parseInt(bound, 10) : op === '<=' ? x <= parseInt(bound, 10) : op === '>' ? x > parseInt(bound, 10) : x >= parseInt(bound, 10);
        if (!keepGoing) break;
        outputs.push(printed(x, v));
      }
      i = j;
      continue;
    }
    i++;
  }
  if (!outputs.length) return null;
  return { outputs, summary: outputs.join(' ') };
}

/** Build a printer function for a python-style loop body, or null when unsupported. */
function pythonPrintTarget(body = [], varName = '') {
  const printLines = body.filter(l => /^print\s*\(/.test(l));
  if (!printLines.length) return null;
  const arg = (printLines[0].match(/^print\s*\(\s*(.+?)\s*\)/) || [])[1] || '';
  if (arg === varName) return x => String(x);
  if (/^f?["'].*["']$/.test(arg) && !arg.includes('{')) return () => arg.replace(/^f?["']|["']$/g, '');
  if (arg.includes('{')) {
    return x => arg.replace(/^f?["']|["']$/g, '').replace(/\{(\w+)([^}]*)\}/g, (mm, name, fmt) => (name === varName ? String(x) : mm));
  }
  return null;
}

/** Build a printer function for a java/C-style loop body, or null when unsupported. */
function javaPrintTarget(body = [], varName = '') {
  for (const l of body) {
    const println = l.match(/System\.out\.println\s*\(\s*(.+?)\s*\)\s*;/);
    if (println) {
      const arg = println[1];
      if (arg === varName) return x => String(x);
      if (/^".*"$/.test(arg)) return () => arg.slice(1, -1);
      if (arg === varName + '+ ""') return x => String(x);
      const concat = arg.match(/^"([^"]*)"\s*\+\s*(\w+)/);
      if (concat && concat[2] === varName) return x => `${concat[1]}${x}`;
      const concat2 = arg.match(/^(\w+)\s*\+\s*"([^"]*)"$/);
      if (concat2 && concat2[1] === varName) return x => `${x}${concat2[2]}`;
      return null;
    }
    const printf = l.match(/printf\s*\(\s*"([^"]*)"\s*,\s*(\w+)\s*\)/);
    if (printf && printf[2] === varName) {
      const fmt = printf[1].replace(/\\n/g, '').replace(/%[diu]/, '');
      return x => `${fmt}${x}`;
    }
    const cout = l.match(/cout\s*<<\s*(\w+)/);
    if (cout && cout[1] === varName) return x => String(x);
    if (/console\.log\s*\(\s*(\w+)\s*\)/.test(l) && RegExp.$1 === varName) return x => String(x);
    if (/console\.log\s*\(\s*(\w+)\s*\)/.test(l)) continue;
  }
  return null;
}

/** "Output: 55" style claims printed on the slide itself. */
export function statedOutput(lines = []) {
  const found = [];
  lines.forEach((line, i) => {
    const t = normalize(line.text || '');
    const m = t.match(/^(?:output|result|prints?|displays?|gives?)\s*:?\s*(.+)$/i);
    if (m && m[1].length <= 140) {
      found.push({ text: m[1].trim(), from: t });
      return;
    }
    const inline = t.match(/\b(?:output|prints? out|prints|displays)\b[^:]{0,20}:\s*(.+)$/i);
    if (inline && inline[1].length <= 140) found.push({ text: inline[1].trim(), from: t });
  });
  return uniqueBy(found, f => f.text.toLowerCase());
}

/* ------------------------------------------------------------- summary --- */

/**
 * Everything the tutor needs to know about the code on one slide.
 * @returns {{blocks:Array, lang:Object, symbols:Object, constructs:Array, walk:Array, output:object|null, stated:Array}}
 */
export function analyzeCode(lines = [], notes = '') {
  const blocks = extractCodeBlocks(lines);
  const allCode = blocks.map(b => b.code).join('\n');
  const lang = detectLanguage(`${allCode}\n${notes}`);
  const symbols = codeSymbols(allCode, lang.id);
  const constructs = codeConstructs(allCode, lang.id);
  const walk = blocks.flatMap(b => walkthrough(b.code, b.lang));
  let output = null;
  for (const b of blocks) {
    const sim = simulateOutput(b.code, b.lang);
    if (sim) { output = { ...sim, code: b.code, lang: b.lang, source: 'simulated' }; break; }
  }
  const stated = statedOutput(lines);
  const codeLineCount = lines.filter(l => isCodeLine(l.text || '')).length;
  return {
    blocks,
    lang,
    symbols,
    constructs,
    walk,
    output,
    stated,
    codeLineCount,
    proseLineCount: lines.length - codeLineCount,
    isCodeHeavy: lines.length > 0 && codeLineCount / lines.length >= 0.5,
  };
}

export { KEYWORDS };

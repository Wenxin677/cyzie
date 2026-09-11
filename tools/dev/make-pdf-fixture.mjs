/* Emit a small, valid, text-based PDF (2 pages) so the browser harness can exercise
   the pdf.js path — upload, text extraction, and page rendering — without private files. */

import { writeFile } from 'node:fs/promises';

function esc(s) { return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

const PAGES = [
  { title: 'Chapter 1: Bits and Bytes', lines: [
    'A bit is a single binary digit, either zero or one.',
    'A byte is a group of eight bits, which is enough to store one character.',
    'Data representation is how a computer stores information as numbers.',
    'Binary works because a switch has only two states: on and off.',
    'Question: how many different values can one byte hold?',
  ] },
  { title: 'Chapter 2: Hexadecimal', lines: [
    'Hexadecimal is a base-16 system that writes binary numbers in fewer digits.',
    'The hexadecimal digits are 0 to 9 and A to F.',
    'Example: the binary number 1111 1111 is FF in hexadecimal.',
    'Converting by repeated division is the method shown in this lecture.',
  ] },
];

function contentStream(page) {
  const ops = [];
  ops.push('BT /F1 24 Tf 60 720 Td (' + esc(page.title) + ') Tj ET');
  let y = 682;
  for (const line of page.lines) {
    ops.push('BT /F1 12 Tf 60 ' + y + ' Td (' + esc(line) + ') Tj ET');
    y -= 20;
  }
  // A bullet glyph, to exercise the bullet detector.
  ops.push('BT /F1 12 Tf 60 ' + (y - 10) + ' Td (\u2022 Storage is measured in bytes.) Tj ET');
  return ops.join('\n');
}

const objects = [];
function addObj(body) { objects.push(body); return objects.length; }

const catalogId = addObj('<< /Type /Catalog /Pages 2 0 R >>');
addObj('PLACEHOLDER_PAGES');             // id 2
const page1Id = addObj('PLACEHOLDER_PAGE1'); // 3
const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 4
const page2Id = addObj('PLACEHOLDER_PAGE2'); // 5
const stream1 = contentStream(PAGES[0]);
const stream2 = contentStream(PAGES[1]);
const content1Id = addObj(`<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`);
const content2Id = addObj(`<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`);

const pageBody = (contentId, label) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
  + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R /Tabs /S >>`;
objects[page1Id - 1] = pageBody(content1Id, 'p1');
objects[page2Id - 1] = pageBody(content2Id, 'p2');
objects[1] = `<< /Type /Pages /Kids [${page1Id} 0 R ${page2Id} 0 R] /Count 2 >>`;

let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

await writeFile('docs/tests/fixtures/sample.pdf', Buffer.from(pdf, 'latin1'));
console.log(`wrote docs/tests/fixtures/sample.pdf (${Buffer.byteLength(pdf, 'latin1')} bytes, ${PAGES.length} pages)`);

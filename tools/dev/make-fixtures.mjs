/* Generate small, shareable test fixtures (a 3-slide .pptx and a markdown note)
   so the browser harness can exercise the real upload path without private files. */

import { deflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, content] of entries) {
    const nameBuf = enc.encode(name);
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, Buffer.from(nameBuf), Buffer.from(data));
    central.push({ nameBuf, method, crc, comp: data.length, raw: raw.length, offset });
    offset += 30 + nameBuf.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(c.method, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14);
    head.writeUInt32LE(c.crc, 16);
    head.writeUInt32LE(c.comp, 20);
    head.writeUInt32LE(c.raw, 24);
    head.writeUInt16LE(c.nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(c.offset, 42);
    chunks.push(head, Buffer.from(c.nameBuf));
    centralSize += 46 + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

const para = (text, { level = 0, bold = false, size = 1800 } = {}) => `
      <a:p><a:pPr lvl="${level}"/><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a:t></a:r></a:p>`;

const slideXml = ({ title, body, bulletProps = true }) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/>${body.map(b => para(b.text || b, { level: b.level || 0, bold: !!b.bold })).join('')}</p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="12"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:t>#</a:t></a:fld></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const slides = [
  {
    title: 'Chapter 1: Binary and Data Representation',
    body: [
      { text: 'Bit: a single binary digit, either 0 or 1.', level: 0 },
      { text: 'Byte: a group of eight bits, the standard unit for a single character.', level: 0 },
      { text: 'Data representation is the way a computer stores information as numbers.', level: 0, bold: true },
      { text: 'Binary works because a switch has only two states: on and off.', level: 0 },
    ],
    notes: 'Open by asking the class why computers cannot simply use decimal digits.',
  },
  {
    title: 'Number Systems',
    body: [
      { text: 'Denary is the base-10 system that people use every day.', level: 0 },
      { text: 'Hexadecimal is a base-16 system that writes binary numbers in fewer digits.', level: 0 },
      { text: 'The hexadecimal digits are 0-9 and A-F.', level: 0 },
      { text: 'Example: the binary number 1111 1111 is FF in hexadecimal.', level: 0 },
      { text: 'Two common ways to convert a number: repeated division and place-value subtraction.', level: 0 },
    ],
    notes: 'Walk through the FF conversion on the board.',
  },
  {
    title: 'Why This Matters',
    body: [
      { text: 'Storage is measured in bytes, kilobytes, megabytes and gigabytes.', level: 0 },
      { text: '1 kilobyte is 1024 bytes.', level: 0 },
      { text: 'A computer cannot store text, images or sound directly; everything becomes binary numbers.', level: 0 },
      { text: 'Sound is sampled many times per second to approximate a continuous wave.', level: 0 },
    ],
    notes: '',
  },
];

const slideOverrides = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
  ${slides.map((_, i) => `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('\n  ')}
</Types>`;

const notesXml = text => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide Number Placeholder 3"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:fld id="{2}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:notes>`;

const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`;

const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n  ')}
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const slideRels = i => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i}.xml"/>
</Relationships>`;

const entries = [
  ['[Content_Types].xml', slideOverrides],
  ['_rels/.rels', rootRels],
  ['ppt/presentation.xml', presentation],
  ['ppt/_rels/presentation.xml.rels', presentationRels],
];
slides.forEach((s, i) => {
  entries.push([`ppt/slides/slide${i + 1}.xml`, slideXml(s)]);
  entries.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels(i + 1)]);
  if (s.notes) entries.push([`ppt/notesSlides/notesSlide${i + 1}.xml`, notesXml(s.notes)]);
});
// A non-text part, to prove the reader skips binary entries cleanly.
entries.push(['docProps/thumbnail.jpeg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])]);

const NOTES_MD = `# Study Session Notes

## What is active recall?

Active recall: recalling information from memory without notes in front of you.
It is harder than re-reading and it produces stronger memory.

## What is spaced repetition?

Spaced repetition: reviewing material at expanding intervals.
The first review should happen within a day of learning something new.

## Exam checklist

- Answer past questions without looking at notes
- Explain each key term out loud in one sentence
- Mark the topics that felt slow, and revisit them first
`;

await mkdir('docs/tests/fixtures', { recursive: true });
await writeFile('docs/tests/fixtures/sample.pptx', zip(entries));
await writeFile('docs/tests/fixtures/sample-notes.md', NOTES_MD);
console.log('wrote docs/tests/fixtures/sample.pptx and sample-notes.md');

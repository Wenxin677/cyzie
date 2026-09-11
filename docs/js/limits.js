/* Hard limits for untrusted input. One place, so the parsers and the UI agree.
   These exist to keep a hostile or simply enormous file from freezing the tab. */

export const LIMITS = {
  maxFileBytes: 60 * 1024 * 1024,            // the file the user picks
  maxPreviewBlobBytes: 24 * 1024 * 1024,     // original bytes kept for PDF page rendering
  maxZipEntries: 5000,                       // parts inside one .pptx / .docx
  maxEntryBytes: 64 * 1024 * 1024,           // one decompressed part
  maxTotalBytes: 256 * 1024 * 1024,          // everything decompressed together
  maxXmlChars: 24 * 1024 * 1024,             // one XML part we are willing to scan
  maxLineChars: 4000,                        // one line of text we will analyse
  maxSlideChars: 200000,                     // one slide / page of text
  maxPages: 2000,                            // pages Cyzie will index in one file
  maxPdfRenderCache: 12,                     // rendered page images kept in memory
  maxStoredLessons: 200,
};

export default LIMITS;

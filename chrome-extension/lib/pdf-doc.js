// Reads a PDF with pdf.js into the document shape used everywhere else:
//   { hash, title, pdf, pages: [{ n, text, width, height }] }
// `pdf` is the pdf.js document, kept for drawing the pages. docText() leaves it out.
// pdf.js is passed in (not imported) so this file also runs in Node tests.

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// pdf.js text items -> lines. Each item is a run of text; hasEOL marks the end of a line.
export function linesFromTextItems(items) {
  const lines = [];
  let line = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content markers have no text
    line += item.str;
    if (item.hasEOL) {
      lines.push(line);
      line = '';
    }
  }
  lines.push(line);
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export async function parsePdf(buffer, { pdfjsLib, fileName }) {
  const hash = await sha256Hex(buffer); // first: pdf.js takes over (detaches) the buffer
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
    isEvalSupported: false, // the extension's CSP forbids eval
  }).promise;

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    pages.push({ n, text: linesFromTextItems(items).join('\n'), width, height });
    page.cleanup();
  }

  return { hash, title: fileName.replace(/\.pdf$/i, ''), pdf, pages };
}

// What the service worker gets: text only.
export function docText(doc) {
  return { title: doc.title, pages: doc.pages.map(({ n, text }) => ({ n, text })) };
}

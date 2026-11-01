// Helpers for opening PDFs from the address bar in the viewer.
// Viewer URLs:
//   viewer.html?doc=<id>      the normal, short form (see access.js)
//   viewer.html?file=<URL>    where our redirect rule lands for online PDFs: declarativeNetRequest's
//                             regexSubstitution can only append the original URL, unencoded, so
//                             everything after "file=" is that URL, query string included.
// Neither form grants anything: the background checks the tab's grant (access.js).

export function fileViewerUrl(viewerBase, fileUrl) {
  return `${viewerBase}?file=${fileUrl}`;
}

export function docViewerUrl(viewerBase, id) {
  return `${viewerBase}?doc=${id}`;
}

// '?doc=…' or '?file=…' (from location.search or a full viewer URL) -> { doc } | { file } | null
export function parseViewerQuery(search) {
  const query = search.slice(search.indexOf('?'));
  const file = /^\?file=(.+)$/s.exec(query);
  if (file) return { file: file[1] };
  const doc = /^\?doc=([a-z0-9]+)$/.exec(query);
  return doc ? { doc: doc[1] } : null;
}

// Same test as our redirect rules (background.js), on a webRequest header list.
export function looksLikePdfResponse(headers = []) {
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value?.toLowerCase() ?? '';
  const type = get('content-type');
  if (/^application\/(x-)?pdf\b/.test(type)) return true;
  return /\.pdf\b/.test(get('content-disposition')) && !type.startsWith('text/');
}

// PDF files start with "%PDF-"; some servers put a few junk bytes before it, which readers tolerate.
export function isPdfBytes(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let i = 0; i + magic.length <= head.length; i++) {
    if (magic.every((b, j) => head[i + j] === b)) return true;
  }
  return false;
}

// Name for the title bar: Content-Disposition filename, else the last path segment, else the host.
export function pdfNameFor(url, contentDisposition = '') {
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(contentDisposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  let name = '';
  try {
    if (star) name = decodeURIComponent(star[1].trim());
    else if (plain) name = plain[1].trim();
  } catch {
    name = plain?.[1].trim() ?? '';
  }
  if (!name) {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    try {
      name = last ? decodeURIComponent(last) : u.hostname;
    } catch {
      name = last;
    }
  }
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

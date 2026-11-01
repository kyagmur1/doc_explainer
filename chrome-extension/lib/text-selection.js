// Smooth text selection over pdf.js text layers, the way pdf.js's own viewer does it
// (TextLayerBuilder in pdfjs-dist 4.10 web/pdf_viewer.mjs, Chrome part only).
//
// A text layer is a set of transparent, absolutely positioned spans with gaps between them.
// When a drag passes over a gap, Chrome looks for the nearest text in DOM order, so the
// selection jumps or collapses. To prevent that, every layer gets an "endOfContent" div.
// While selecting, it is stretched over the whole layer (CSS: .textLayer.selecting
// .endOfContent) and moved right next to the moving end of the selection, so gaps "hit"
// that spot instead of text elsewhere on the page.

const layers = new Map(); // text layer div -> its endOfContent div

// Call once per text layer, after its text has been rendered.
export function enableSelection(textLayer) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  textLayer.append(end);
  textLayer.addEventListener('mousedown', () => textLayer.classList.add('selecting'));
  layers.set(textLayer, end);
}

function reset(end, textLayer) {
  textLayer.append(end);
  end.style.width = '';
  end.style.height = '';
  textLayer.classList.remove('selecting');
}

let pointerDown = false;
let prevRange = null;

document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => {
  pointerDown = false;
  layers.forEach(reset);
});
addEventListener('blur', () => {
  pointerDown = false;
  layers.forEach(reset);
});
document.addEventListener('keyup', () => !pointerDown && layers.forEach(reset));

document.addEventListener('selectionchange', () => {
  const selection = getSelection();
  if (selection.rangeCount === 0) return layers.forEach(reset);

  // Layers the selection touches are "selecting"; the others go back to normal.
  const range = selection.getRangeAt(0);
  for (const [textLayer, end] of layers) {
    if (range.intersectsNode(textLayer)) textLayer.classList.add('selecting');
    else reset(end, textLayer);
  }

  // Which end is moving: the start if the end stayed put since the last change.
  const movingStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
  let anchor = movingStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  const textLayer = anchor.parentElement?.closest('.textLayer');
  const end = layers.get(textLayer);
  if (end) {
    end.style.width = textLayer.style.width;
    end.style.height = textLayer.style.height;
    anchor.parentElement.insertBefore(end, movingStart ? anchor : anchor.nextSibling);
  }
  prevRange = range.cloneRange();
});

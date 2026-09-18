/* ============================================================
   capture — freezing a screen and cutting a piece out of it

   The long edge cap is the important number in this file. A raw
   1440p frame is mostly wasted on a small vision model and slows
   the first token down badly; a tight region scaled to about this
   is where small text stays readable.
   ============================================================ */

const { desktopCapturer, screen, nativeImage } = require('electron');

const MAX_EDGE = 1280;

function displayUnderCursor() {
  const point = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point);
}

/**
 * Grab one display at its true pixel size. Asking for the display's DIP
 * size on a scaled monitor hands back a soft image and the OCR goes with
 * it, so the thumbnail is requested at size x scaleFactor.
 */
async function grabDisplay(display) {
  const scale = display.scaleFactor || 1;
  const width = Math.round(display.size.width * scale);
  const height = Math.round(display.size.height * scale);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  });

  if (!sources.length) throw new Error('No screen was available to capture.');

  // display_id is the reliable match on a multi monitor setup; the name
  // and ordering are not, so only fall back to the first source when
  // there is nothing better to go on.
  const match =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

  if (!match.thumbnail || match.thumbnail.isEmpty()) {
    throw new Error('The screen came back empty.');
  }

  return match.thumbnail;
}

/**
 * Cut a rectangle out of a captured frame and shrink it to something a
 * small model can actually read. The rect arrives in the overlay's CSS
 * pixels, which are display independent, so it has to be scaled up to
 * meet the native resolution image before cropping.
 */
function cropAndShrink(image, rect, scaleFactor, maxEdge = MAX_EDGE) {
  const scale = scaleFactor || 1;
  const full = image.getSize();

  let x = Math.round(rect.x * scale);
  let y = Math.round(rect.y * scale);
  let width = Math.round(rect.width * scale);
  let height = Math.round(rect.height * scale);

  // a drag that ends past the edge of the screen should still produce a
  // picture rather than an exception out of crop()
  x = Math.max(0, Math.min(x, full.width - 1));
  y = Math.max(0, Math.min(y, full.height - 1));
  width = Math.max(1, Math.min(width, full.width - x));
  height = Math.max(1, Math.min(height, full.height - y));

  let out = image.crop({ x, y, width, height });

  const size = out.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > maxEdge) {
    const factor = maxEdge / longest;
    out = out.resize({
      width: Math.max(1, Math.round(size.width * factor)),
      height: Math.max(1, Math.round(size.height * factor)),
      quality: 'best'
    });
  }

  return out;
}

// PNG keeps text edges crisp. JPEG at this size saves a little bandwidth
// over a loopback connection that is not short of any, and smears exactly
// the small glyphs the model is being asked to read.
function toDataURL(image) {
  return image.toDataURL();
}

function fromDataURL(url) {
  return nativeImage.createFromDataURL(url);
}

module.exports = {
  MAX_EDGE,
  displayUnderCursor,
  grabDisplay,
  cropAndShrink,
  toDataURL,
  fromDataURL
};

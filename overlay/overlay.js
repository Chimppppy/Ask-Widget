/* Drag a rectangle over a frozen screen. The rect goes back in CSS pixels,
   which the main process scales up to the captured image's real size. */

const frame = document.getElementById('frame');
const veil = document.getElementById('veil');
const sel = document.getElementById('sel');
const size = document.getElementById('size');
const hint = document.getElementById('hint');

let start = null;
let rect = null;

window.pick.onFrame((url) => {
  frame.src = url;
});

function draw(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);

  sel.style.left = x + 'px';
  sel.style.top = y + 'px';
  sel.style.width = width + 'px';
  sel.style.height = height + 'px';
  sel.classList.add('on');

  size.textContent = Math.round(width) + ' x ' + Math.round(height);
  size.classList.add('on');

  // keep the readout on screen when the drag runs into an edge
  const pad = 8;
  const below = y + height + pad;
  const fits = below + size.offsetHeight < window.innerHeight;
  size.style.top = (fits ? below : Math.max(pad, y - size.offsetHeight - pad)) + 'px';
  size.style.left =
    Math.min(Math.max(pad, x), window.innerWidth - size.offsetWidth - pad) + 'px';

  return { x, y, width, height };
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  rect = null;
  veil.classList.add('picking');
  hint.classList.add('gone');
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  rect = draw(start, { x: e.clientX, y: e.clientY });
});

window.addEventListener('mouseup', (e) => {
  if (!start) return;
  const finished = draw(start, { x: e.clientX, y: e.clientY });
  start = null;

  // a click rather than a drag means they changed their mind
  if (finished.width < 8 || finished.height < 8) {
    window.pick.cancel();
    return;
  }
  window.pick.done(finished);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pick.cancel();
});

// losing the overlay's focus without a pick leaves a full screen window
// sitting over everything, so treat it as a cancel
window.addEventListener('blur', () => {
  if (!start) window.pick.cancel();
});

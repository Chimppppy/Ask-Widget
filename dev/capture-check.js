/* Checks the capture pipeline against the real display: that the frame comes
   back at native pixels, that a rectangle drawn in the overlay's CSS pixels
   lands where it should on a scaled monitor, and that an oversized region is
   brought down to something a small model can read.

   Writes one sample PNG so the downscale can be judged by eye — the whole
   question of whether screen reading is useful comes down to that image.

   Run with:  npx electron dev/capture-check.js  */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const capture = require('../capture');

const OUT = process.env.ASK_SHOT_DIR || __dirname;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

app.whenReady().then(async () => {
  const display = capture.displayUnderCursor();
  const scale = display.scaleFactor || 1;

  console.log(
    'display ' + display.size.width + 'x' + display.size.height +
    ' at ' + scale + 'x  (' + Math.round(display.size.width * scale) + 'x' +
    Math.round(display.size.height * scale) + ' real pixels)'
  );

  const frame = await capture.grabDisplay(display);
  const got = frame.getSize();
  console.log('captured ' + got.width + 'x' + got.height);

  check('frame comes back at native resolution', () => {
    const wantW = Math.round(display.size.width * scale);
    if (Math.abs(got.width - wantW) > 2) {
      throw new Error('expected about ' + wantW + ' wide, got ' + got.width);
    }
  });

  // a modest region, the size of a dialog or an error message
  const small = capture.cropAndShrink(frame, { x: 80, y: 80, width: 420, height: 260 }, scale);
  const smallSize = small.getSize();
  console.log('420x260 region  ->  ' + smallSize.width + 'x' + smallSize.height);

  check('a small region keeps its captured detail', () => {
    if (smallSize.width !== Math.round(420 * scale)) {
      throw new Error('expected ' + Math.round(420 * scale) + ', got ' + smallSize.width);
    }
  });

  check('a small region keeps its aspect ratio', () => {
    const before = 420 / 260;
    const after = smallSize.width / smallSize.height;
    if (Math.abs(before - after) > 0.02) throw new Error('aspect drifted');
  });

  // the whole screen, which is the case that needs bringing down
  const big = capture.cropAndShrink(
    frame,
    { x: 0, y: 0, width: display.size.width, height: display.size.height },
    scale
  );
  const bigSize = big.getSize();
  console.log('full screen     ->  ' + bigSize.width + 'x' + bigSize.height);

  check('a full screen is capped at the long edge', () => {
    const longest = Math.max(bigSize.width, bigSize.height);
    if (longest !== capture.MAX_EDGE) {
      throw new Error('expected ' + capture.MAX_EDGE + ', got ' + longest);
    }
  });

  check('the cap keeps the aspect ratio', () => {
    const before = display.size.width / display.size.height;
    const after = bigSize.width / bigSize.height;
    if (Math.abs(before - after) > 0.02) throw new Error('aspect drifted');
  });

  // a drag that ran off the edge of the screen
  const spill = capture.cropAndShrink(
    frame,
    { x: display.size.width - 60, y: display.size.height - 40, width: 400, height: 400 },
    scale
  );
  check('a drag past the edge still produces an image', () => {
    const s = spill.getSize();
    if (s.width < 1 || s.height < 1) throw new Error('came back empty');
  });

  check('a zero sized drag does not throw', () => {
    capture.cropAndShrink(frame, { x: 10, y: 10, width: 0, height: 0 }, scale);
  });

  const sample = path.join(OUT, 'capture-sample.png');
  fs.writeFileSync(sample, small.toPNG());
  console.log('\nsample written to ' + sample);

  console.log(failures ? failures + ' FAILED' : 'all passed');
  app.exit(failures ? 1 : 0);
});

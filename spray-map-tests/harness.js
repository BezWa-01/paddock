/* Shared plumbing for the Aerial Spraying Plan Map test suites.

   Two things this exists to do:
   1. Point every suite at the ONE real deliverable (../aerial-spraying-plan-map.html).
      There is no build step and no test-only copy of the app — a test that
      passes against a stale copy is worse than no test.
   2. Let suites that need large private GIS extracts SKIP cleanly instead of
      failing, so CI is green on a fresh clone that has no such data. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'aerial-spraying-plan-map.html');
const DATA_DIR = path.join(__dirname, 'data');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function appUrl() {
  if (!fs.existsSync(APP)) {
    console.error('FAIL: cannot find the app at ' + APP);
    process.exit(1);
  }
  return 'file://' + APP;
}

function fixture(name) {
  const p = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(p)) {
    console.error('FAIL: missing committed fixture ' + name);
    process.exit(1);
  }
  return p;
}

/* A large GIS source that is deliberately NOT in the repo (size, and it is the
   farm's own licensed extract). Absent => skip, not fail. */
function dataFile(name, why) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) {
    console.log('SKIP: needs spray-map-tests/data/' + name + ' — ' + why);
    console.log('SKIP: see spray-map-tests/README.md for where to get it.');
    process.exit(0);
  }
  return p;
}

function haveCommand(cmd) {
  try { execSync(process.platform === 'win32' ? 'where ' + cmd : 'command -v ' + cmd, { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

/* A 1x1 PNG served in place of real basemap tiles, so no suite depends on a
   tile server being up (or on burdening one). */
const FAKE_TILE = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080200000090771530000000a49444154789c6360000002000100', 'hex');

async function stubTiles(page) {
  await page.route('**://*.tile.openstreetmap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://server.arcgisonline.com/**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
}

module.exports = { ROOT, APP, DATA_DIR, FIXTURE_DIR, appUrl, fixture, dataFile, haveCommand, FAKE_TILE, stubTiles };

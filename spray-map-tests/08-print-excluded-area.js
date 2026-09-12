const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');
const { execSync } = require('child_process');


/* Round 13 — the excluded area must be free of crop hatch in the PRINTED
   output, not merely on screen.

   Reported from a real print: preview correct, print showed hatch over the
   excluded ground. Root cause was that the full-paddock base layer carried
   the hatch fill and was hidden ONLY by fill-opacity:0 — so any print path
   that drops or overrides a fill-opacity paints crop hatch over ground that
   must not be sprayed. That is a spray-safety defect, not a cosmetic one.

   This asserts the property that actually matters and that no styling accident
   can satisfy by luck: NO hatch-filled path may contain the excluded area's
   centre, tested with the browser's own isPointInFill (which honours fill-rule
   and so understands holes), on screen AND under print media emulation. */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', async d => { await d.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([{ id:'F__Big', name:'Big', farm:'F', area_ha:400, exterior:rect(116.00,-30.90,116.02,-30.88), interior:[] }]);
    document.getElementById('showNamesChk').checked = false;
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    selectedCrop = 'W';
    editPolyLayers['F__Big'].fire('click', { latlng: L.latLng(-30.890, 116.010) });
    armedExclusion = true;
    exclusionDraft = [[-30.896,116.004],[-30.896,116.016],[-30.884,116.016],[-30.884,116.004]];
    exclusionSnapMarks = [null,null,null,null];
    finishExclusion();
  });
  await page.waitForTimeout(600);

  // The property, checked against every painted path in a given map pane.
  const probe = (sel) => page.evaluate((sel) => {
    // Centre of the excluded zone, in this map's screen coordinates.
    const map = sel === '#editMap' ? editMap : previewMap;
    const c = map.latLngToContainerPoint(L.latLng(-30.890, 116.010));
    const box = document.querySelector(sel).getBoundingClientRect();
    const clientX = box.left + c.x, clientY = box.top + c.y;
    const out = [];
    document.querySelectorAll(sel + ' path').forEach(p => {
      const svg = p.ownerSVGElement;
      if (!svg || !p.isPointInFill) return;
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const local = pt.matrixTransform(p.getScreenCTM().inverse());
      let inFill = false;
      try { inFill = p.isPointInFill(local); } catch (e) { inFill = false; }
      const cs = getComputedStyle(p);
      out.push({
        inFill,
        fill: p.getAttribute('fill'),
        computedFill: cs.fill,
        fillOpacityAttr: p.getAttribute('fill-opacity'),
        computedFillOpacity: cs.fillOpacity,
        cls: p.getAttribute('class') || '',
      });
    });
    return out;
  }, sel);

  const check = (paths, where) => {
    const offenders = paths.filter(p =>
      p.inFill && /hatchPattern/.test(String(p.computedFill) + String(p.fill)) && parseFloat(p.computedFillOpacity || '1') > 0
    );
    // Anything that COULD paint hatch over the hole if opacity were ignored.
    const latent = paths.filter(p => p.inFill && /hatchPattern/.test(String(p.fill)));
    console.log(where + ':', JSON.stringify({ total: paths.length, coveringHole: paths.filter(p => p.inFill).length, hatchOverHole: offenders.length, latentHatchOverHole: latent.length }));
    if (offenders.length) throw new Error('Crop hatch is painted over the excluded area in ' + where + ': ' + JSON.stringify(offenders));
    if (latent.length) throw new Error('A path over the excluded area still carries the hatch fill in ' + where + ' — it is one dropped fill-opacity away from printing hatch on no-spray ground: ' + JSON.stringify(latent));
  };

  check(await probe('#editMap'), 'edit map (screen)');

  await page.evaluate(() => document.getElementById('previewBtn').click());
  await page.waitForTimeout(2200);
  check(await probe('#previewMap'), 'print preview (screen)');

  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(600);
  check(await probe('#previewMap'), 'print preview (PRINT media)');

  // The on-screen notices must not appear on the operator's map.
  const bars = await page.evaluate(() => ({
    tile: getComputedStyle(document.getElementById('tileWarningBar')).display,
    excl: getComputedStyle(document.getElementById('exclWarningBar')).display,
  }));
  console.log('warning bars under print media:', JSON.stringify(bars));
  if (bars.tile !== 'none' || bars.excl !== 'none') throw new Error('On-screen warning bars must not print: ' + JSON.stringify(bars));
  await page.emulateMedia({ media: null });

  // Clicking the excluded area must still open its delete popup even though
  // the click target now has no fill at all.
  const clickable = await page.evaluate(() => {
    const layers = exclusionGroup.getLayers();
    if (!layers.length) return { ok: false, reason: 'no exclusion layer' };
    layers[0].fire('click', { latlng: L.latLng(-30.890, 116.010) });
    const open = document.querySelector('.leaflet-popup-content');
    return { ok: !!open, text: open ? open.textContent.slice(0, 40) : '' };
  });
  console.log('excluded area still click-to-delete:', JSON.stringify(clickable));
  if (!clickable.ok) throw new Error('Removing the fill broke click-to-delete on the excluded area');

  // Finally: a real PDF, rasterised, with the hole's pixels measured. The
  // geometric assertions above are the primary check and always run; this
  // extra belt-and-braces step needs poppler + Pillow, so skip it if absent
  // rather than failing a clean machine that simply hasn't got them.
  const canRaster = haveCommand('pdftoppm');
  if (!canRaster) {
    console.log('note: pdftoppm not installed — skipping the PDF pixel count (geometry checks above still ran)');
  } else {
  const tmp = require('os').tmpdir();
  await page.pdf({ path: require('path').join(tmp, 'printhole_check.pdf'), printBackground: true, preferCSSPageSize: true });
  execSync('pdftoppm -png -r 100 -f 1 -l 1 printhole_check.pdf printhole_check', { cwd: tmp });
  const stats = execSync(`python3 - <<'PY'
from PIL import Image
im = Image.open("printhole_check-1.png").convert('L')
w,h = im.size
cx, cy = w//2, int(h*0.52)
patch = [im.getpixel((cx+dx, cy+dy)) for dx in range(-30,31,2) for dy in range(-30,31,2)]
dark = sum(1 for v in patch if v < 140)
print(f"{dark}/{len(patch)}")
PY`, { cwd: tmp }).toString().trim();
  console.log('dark (hatch) pixels inside the printed hole:', stats);
  const [dark] = stats.split('/').map(Number);
  if (dark > 0) throw new Error('The printed PDF has hatch pixels inside the excluded area: ' + stats);
  }

  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors: ' + JSON.stringify(pageErrors));
  await browser.close();
  console.log('ALL PRINT-HOLE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

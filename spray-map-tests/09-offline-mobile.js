const { webkit, chromium, devices } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

/* Round 14 — the file must work on an iPad, with NO network at all.

   Mike hit "Can't find variable: shp" on iPad: shpjs was being fetched from a
   CDN, and one blocked or slow request left the shapefile reader simply absent
   — with the failure surfacing only when he tried to load boundaries. Every
   library is now bundled, so this test runs Safari's own engine (WebKit) on an
   iPad profile with EVERY outbound request aborted, and loads a real shapefile
   zip through the actual file input. Nothing may be fetched; everything must
   still work. */
const ZIP = fixture('Koojan_Test_Boundaries.zip');

async function run(engine, name, deviceProfile) {
  const browser = await engine.launch({ headless: true });
  const ctx = await browser.newContext(Object.assign({}, deviceProfile || {}));
  const page = await ctx.newPage();
  const pageErrors = [], consoleErrors = [], attempted = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', async d => { consoleErrors.push('DIALOG: ' + d.message()); await d.accept(); });

  // Hard offline: abort every non-file request. If anything is still fetched
  // from a CDN, the app must fail here — which is the point.
  await page.route('**', route => {
    const u = route.request().url();
    if (u.startsWith('file://')) return route.continue();
    attempted.push(u.slice(0, 80));
    return route.abort();
  });

  await page.goto(appUrl());
  await page.waitForTimeout(1200);

  const globals = await page.evaluate(() => ({
    L: typeof L, shp: typeof shp, JSZip: typeof JSZip,
    polygonClipping: typeof polygonClipping, startApp: typeof startApp,
  }));
  console.log(`[${name}] globals:`, JSON.stringify(globals));
  for (const [k, v] of Object.entries(globals)) {
    if (v === 'undefined') throw new Error(`[${name}] ${k} is not defined with no network — it is still being fetched`);
  }

  // Load real boundaries through the real file input — the exact path that
  // produced "Can't find variable: shp".
  await page.setInputFiles('#fileInput', ZIP);
  let loaded = false;
  for (let i = 0; i < 60; i++) {
    loaded = await page.evaluate(() => typeof PADDOCKS !== 'undefined' && PADDOCKS.length > 0);
    if (loaded) break;
    await page.waitForTimeout(250);
  }
  const state = await page.evaluate(() => ({
    paddocks: typeof PADDOCKS !== 'undefined' ? PADDOCKS.length : 0,
    farms: typeof FARMS !== 'undefined' ? FARMS.slice() : [],
    names: typeof PADDOCKS !== 'undefined' ? PADDOCKS.map(p => p.name).sort() : [],
    uploadHidden: document.getElementById('uploadScreen').classList.contains('hidden'),
    status: document.getElementById('uploadStatus').textContent,
  }));
  console.log(`[${name}] after upload:`, JSON.stringify(state));
  if (!state.paddocks) throw new Error(`[${name}] Boundaries did not parse offline. Status: "${state.status}"`);
  if (state.paddocks !== 3) throw new Error(`[${name}] Expected 3 paddocks, got ${state.paddocks}`);
  if (!state.uploadHidden) throw new Error(`[${name}] Upload screen did not clear`);

  // Exercise the core workflow: assign a crop, draw a snapped exclusion.
  const work = await page.evaluate(() => {
    const p = PADDOCKS.find(x => x.name === 'Borehill');
    selectedCrop = 'W';
    editPolyLayers[p.id].fire('click', { latlng: L.latLng(p.centerLatLng[0], p.centerLatLng[1]) });
    armedExclusion = true; exclusionDraft = []; exclusionSnapMarks = [];
    rebuildSnapIndex();
    const [lat, lon] = p.centerLatLng;
    exclusionDraft = [[lat-0.002,lon-0.002],[lat-0.002,lon+0.002],[lat+0.002,lon+0.002],[lat+0.002,lon-0.002]];
    exclusionSnapMarks = [null,null,null,null];
    finishExclusion();
    const { treated } = computeTreatedGeometry(p);
    let overlap = -1;
    try { overlap = multiPolygonAreaHa(polygonClipping.intersection(treated, exclusionMultiPolygon(state.exclusions[0]))); } catch (e) {}
    return {
      treatedCrop: state.treatment[p.id],
      exclusions: state.exclusions.length,
      exclusionHa: state.exclusions[0] ? state.exclusions[0].area_ha : 0,
      hatchOverExcluded: overlap,
      snapRings: snapIndex.length,
      degraded: exclusionGeometryDegraded,
    };
  });
  console.log(`[${name}] core workflow:`, JSON.stringify(work));
  if (work.treatedCrop !== 'W') throw new Error(`[${name}] Crop assignment failed`);
  if (work.exclusions !== 1) throw new Error(`[${name}] Exclusion was not created`);
  if (!(work.hatchOverExcluded >= 0 && work.hatchOverExcluded < 1e-9)) throw new Error(`[${name}] Hatch covers excluded ground offline: ${work.hatchOverExcluded}`);
  if (work.degraded) throw new Error(`[${name}] Exclusion clipping degraded — a library is missing offline`);
  if (!work.snapRings) throw new Error(`[${name}] Snap index empty`);

  // KML export must build with no network either.
  const kml = await page.evaluate(async () => {
    const icons = await buildKmlIconCache();
    const text = buildKML(icons, false);
    return { len: text.length, hasIcon: text.includes('data:image/png;base64,'), hasExcluded: text.includes('Excluded area') };
  });
  console.log(`[${name}] KML offline:`, JSON.stringify(kml));
  if (!kml.len || !kml.hasExcluded) throw new Error(`[${name}] KML export failed offline`);
  if (!kml.hasIcon) throw new Error(`[${name}] Icon rasterisation failed offline (canvas/SVG path)`);

  // Print preview must open (tiles are blocked, which is expected and handled).
  await page.evaluate(() => document.getElementById('previewBtn').click());
  await page.waitForTimeout(1800);
  const pv = await page.evaluate(() => ({
    inPreview: document.getElementById('root').classList.contains('preview-mode'),
    legend: (document.getElementById('pLegend').textContent || '').slice(0, 60),
    tileBar: document.getElementById('tileWarningBar').style.display,
  }));
  console.log(`[${name}] preview:`, JSON.stringify(pv));
  if (!pv.inPreview) throw new Error(`[${name}] Print preview did not open`);
  if (!/WHEAT|Excluded/i.test(pv.legend)) throw new Error(`[${name}] Legend did not build: ${pv.legend}`);

  const cdnAttempts = attempted.filter(u => /unpkg|jsdelivr|cdnjs|jquery/i.test(u));
  console.log(`[${name}] blocked requests: ${attempted.length} total, CDN attempts: ${JSON.stringify(cdnAttempts)}`);
  if (cdnAttempts.length) throw new Error(`[${name}] Still trying to fetch libraries from a CDN: ${JSON.stringify(cdnAttempts)}`);

  // This test aborts every network request on purpose, so the browser logs a
  // generic resource-load failure per blocked tile. Those are the test's own
  // doing; anything else is a real error.
  const realErrors = consoleErrors.filter(e =>
    !/tile|DIALOG/i.test(e) && !/Failed to load resource|ERR_FAILED|net::|Load failed/i.test(e));
  if (pageErrors.length) throw new Error(`[${name}] Page errors: ${JSON.stringify(pageErrors)}`);
  if (realErrors.length) throw new Error(`[${name}] Console errors: ${JSON.stringify(realErrors)}`);

  await page.screenshot({ path: require('path').join(require('os').tmpdir(), `shot_offline_${name}.png`) });
  await browser.close();
  console.log(`[${name}] OK`);
}

(async () => {
  await run(webkit, 'ipad-safari', Object.assign({}, devices['iPad Pro 11'], { hasTouch: true }));
  await run(webkit, 'iphone-safari', Object.assign({}, devices['iPhone 13'], { hasTouch: true }));
  await run(chromium, 'desktop-chrome', { viewport: { width: 1400, height: 900 } });
  console.log('ALL OFFLINE / MOBILE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e.message); process.exit(1); });

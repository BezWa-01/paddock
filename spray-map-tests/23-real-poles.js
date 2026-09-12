const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

const REAL_ZIP = dataFile('Poles.zip', 'the Western Power distribution pole shapefile (~17MB zip)');
const POLE_LIMIT_EXPECT = 400;

/* Round 11 — Western Power's REAL distribution pole shapefile, loaded through
   the actual file input.

   The file: 796,375 Point records (the parent of the coordinate-less CSV Mike
   sent in round 8 — same pick_id / pole_type columns), 22MB of geometry and a
   64MB attribute table, GDA94 lon/lat, statewide. */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', async (d) => { console.log('DIALOG:', d.message()); await d.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([
      { id:'Annadale__Borehill', name:'Borehill', farm:'Annadale', area_ha:106, exterior:rect(116.06,-30.89,116.08,-30.87), interior:[] },
      { id:'Annadale__West40',  name:'West 40',  farm:'Annadale', area_ha:88,  exterior:rect(116.08,-30.89,116.10,-30.875), interior:[] },
    ]);
  });
  await page.waitForTimeout(500);

  const t0 = Date.now();
  await page.setInputFiles('#poleInput', REAL_ZIP);
  let elapsed = -1;
  for (let i = 0; i < 240; i++) {
    if (await page.evaluate(() => typeof poleMeta !== 'undefined' && poleMeta !== null)) { elapsed = Date.now() - t0; break; }
    await page.waitForTimeout(250);
  }
  if (elapsed < 0) throw new Error('The real pole file never finished loading');

  const result = await page.evaluate(() => ({
    meta: poleMeta,
    count: polePoints.length,
    withMeta: polePoints.filter(p => p[2]).length,
    sample: polePoints.slice(0, 3).map(p => ({ lat: p[0], lon: p[1], meta: p[2] || null })),
    types: [...new Set(polePoints.map(p => p[2] && p[2].type).filter(Boolean))],
    status: document.getElementById('poleStatus').textContent,
  }));
  console.log('load time (ms):', elapsed);
  console.log('meta:', JSON.stringify(result.meta));
  console.log('poles matched:', result.count, 'with attributes:', result.withMeta);
  console.log('sample:', JSON.stringify(result.sample));
  console.log('pole types present:', JSON.stringify(result.types));
  console.log('status line:', result.status);

  if (result.meta.totalRecords !== 796375) throw new Error('Expected 796,375 pole records, got ' + result.meta.totalRecords);
  if (!(result.count > 0)) throw new Error('No poles matched the Koojan test paddocks');
  if (!(result.count < 20000)) throw new Error('Clip is not narrowing the statewide file: ' + result.count);
  if (result.withMeta !== result.count) throw new Error('Pole attributes missing for some poles: ' + result.withMeta + '/' + result.count);
  if (!result.types.length) throw new Error('No pole_type values read from the .dbf');
  if (!result.sample[0].meta.id) throw new Error('No pole id read from the .dbf');
  // Coordinates must be real Koojan values, not zeroes or projected metres.
  const s0 = result.sample[0];
  if (!(s0.lon > 116 && s0.lon < 116.2 && s0.lat < -30.8 && s0.lat > -30.95)) {
    throw new Error('Pole coordinates are not where they should be: ' + JSON.stringify(s0));
  }

  // ---- Re-clip on farm toggle without re-reading the file ----
  const reclipT0 = Date.now();
  const recheck = await page.evaluate(async () => {
    const before = polePoints.length;
    checkedFarms.delete('Annadale');
    await reclipPoles();
    const after = polePoints.length;
    checkedFarms.add('Annadale');
    await reclipPoles();
    return { before, after, restored: polePoints.length };
  });
  console.log('reclip on farm toggle:', JSON.stringify(recheck), '- two reclips took', (Date.now()-reclipT0)+'ms');
  if (recheck.restored !== recheck.before) throw new Error('Re-clip did not restore the same pole count');

  // ---- Rendering mode: icons under the limit, canvas dots over it ----
  const render = await page.evaluate(() => ({
    limit: POLE_ICON_LIMIT,
    count: polePoints.length,
    markerIcons: document.querySelectorAll('#editMap .leaflet-marker-icon').length,
    canvases: document.querySelectorAll('#editMap canvas').length,
  }));
  console.log('render mode:', JSON.stringify(render));
  if (render.count > render.limit && render.markerIcons > render.limit) {
    throw new Error('Above the icon limit the map should not be drawing an SVG icon per pole');
  }

  // ---- The canvas fallback: a buffer wide enough to pull in thousands of
  // poles must not draw an SVG icon each. This is the path Mike's whole
  // 7,900ha operation will actually hit. ----
  const wide = await page.evaluate(async () => {
    document.getElementById('poleBuffer').value = '15';
    const t = Date.now();
    await reclipPoles();
    return {
      ms: Date.now() - t,
      count: polePoints.length,
      markerIcons: document.querySelectorAll('#editMap .leaflet-marker-icon').length,
      canvases: document.querySelectorAll('#editMap canvas').length,
      status: document.getElementById('poleStatus').textContent,
    };
  });
  console.log('wide buffer (15km):', JSON.stringify({ms: wide.ms, count: wide.count, markerIcons: wide.markerIcons, canvases: wide.canvases}));
  console.log('wide status:', wide.status);
  if (!(wide.count > POLE_LIMIT_EXPECT)) throw new Error('Expected a 15km buffer to exceed the icon limit, got ' + wide.count);
  if (wide.markerIcons > POLE_LIMIT_EXPECT) throw new Error('Canvas fallback did not engage — still drawing ' + wide.markerIcons + ' icon markers');
  if (!wide.canvases) throw new Error('Expected a canvas renderer for the dot mode');
  if (!/small dots/.test(wide.status)) throw new Error('Status line should explain why icons became dots');
  await page.evaluate(async () => { document.getElementById('poleBuffer').value = '2'; await reclipPoles(); });

  // ---- Pole id/type reach the KML export ----
  const kml = await page.evaluate(() => {
    const text = buildKML();
    return {
      hasPole: text.includes('Power Pole'),
      hasType: /Power Pole \(wood\)/i.test(text),
      hasId: text.includes('Pole ID:'),
      poleCount: (text.match(/Power Pole/g) || []).length,
    };
  });
  console.log('KML with real poles:', JSON.stringify(kml));
  if (!kml.hasPole) throw new Error('Poles missing from the KML export');
  if (!kml.hasId) throw new Error('Pole IDs did not reach the KML export');
  if (!kml.hasType) throw new Error('Pole type did not reach the KML placemark name');

  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_real_poles.png') });

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL REAL-POLE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

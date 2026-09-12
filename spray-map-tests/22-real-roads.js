const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

const REAL_ZIP = dataFile('Road_Network.zip', 'the Main Roads WA road network (~36MB zip)');

/* Round 10 — Mike's REAL Main Roads WA road network, loaded through the actual
   file input, not a synthetic fixture.

   The file: 189,680 PolyLine records, 35MB of geometry and a 186MB attribute
   table (222MB uncompressed inside a 36MB zip), GDA94 lon/lat, statewide.
   Test paddocks are placed on his actual Koojan country so the clip has real
   roads to find. */
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

  // Paddocks on Mike's real Koojan ground (Bulbarnet Rd / Koojan West Rd area).
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([
      { id:'Annadale__Borehill', name:'Borehill', farm:'Annadale', area_ha:106, exterior:rect(116.08,-30.86,116.10,-30.84), interior:[] },
      { id:'Annadale__West40',  name:'West 40',  farm:'Annadale', area_ha:88,  exterior:rect(116.10,-30.86,116.12,-30.845), interior:[] },
    ]);
  });
  await page.waitForTimeout(500);

  const t0 = Date.now();
  await page.setInputFiles('#roadInput', REAL_ZIP);
  // roadMeta is a module-scope binding, not a window property, so poll it by
  // evaluating in page context rather than waitForFunction on window.*.
  let elapsed = -1;
  for (let i = 0; i < 240; i++) {
    if (await page.evaluate(() => typeof roadMeta !== 'undefined' && roadMeta !== null)) { elapsed = Date.now() - t0; break; }
    await page.waitForTimeout(250);
  }
  if (elapsed < 0) throw new Error('The real road network never finished loading within 60s');

  const result = await page.evaluate(() => ({
    meta: roadMeta,
    count: roadFeatures.length,
    named: roadFeatures.filter(f => f.name).length,
    names: [...new Set(roadFeatures.map(f => f.name).filter(Boolean))].sort(),
    status: document.getElementById('roadStatus').textContent,
  }));
  console.log('load time (ms):', elapsed);
  console.log('meta:', JSON.stringify(result.meta));
  console.log('features:', result.count, 'named:', result.named);
  console.log('distinct road names:', JSON.stringify(result.names));
  console.log('status line:', result.status);

  if (!result.meta) throw new Error('The real road network never finished loading');
  if (result.meta.totalRecords !== 189680) throw new Error('Expected 189,680 records in the real file, got ' + result.meta.totalRecords);
  if (!(result.count > 0)) throw new Error('No road features matched the Koojan test paddocks');
  if (!(result.count < 2000)) throw new Error('Clip is not narrowing the statewide file down: ' + result.count + ' features');
  if (!result.named) throw new Error('No road names were read from the 186MB .dbf');

  // The names should be real Koojan roads, read out of the real attribute table.
  const expectSome = ['Bulbarnet Rd', 'Koojan West Rd'];
  const found = expectSome.filter(n => result.names.includes(n));
  if (!found.length) throw new Error('Expected real Koojan road names (' + expectSome.join(', ') + '), got: ' + JSON.stringify(result.names));
  console.log('recognised real road names:', JSON.stringify(found));
  if (result.names.some(n => /^unknown/i.test(n))) throw new Error('Main Roads\' "Unknown Rd" placeholder should not be used as a label');

  // ---- Crossroads on real geometry ----
  const crossroads = await page.evaluate(() => {
    const cr = computeRoadCrossroads(roadFeatures);
    return { count: cr.length, sample: cr.slice(0, 6).map(c => c.names.join(' × ')) };
  });
  console.log('crossroads found on real data:', crossroads.count, JSON.stringify(crossroads.sample));
  if (!crossroads.count) throw new Error('No crossroads detected on a real road network around two paddocks');

  // ---- Re-clip on farm toggle, without re-uploading 36MB ----
  const reclipT0 = Date.now();
  const recheck = await page.evaluate(async () => {
    const before = roadFeatures.length;
    checkedFarms.delete('Annadale');
    await reclipRoads();
    const after = roadFeatures.length;
    checkedFarms.add('Annadale');
    await reclipRoads();
    return { before, after, restored: roadFeatures.length };
  });
  console.log('reclip on farm toggle:', JSON.stringify(recheck), '- two full reclips took', (Date.now()-reclipT0)+'ms');
  if (recheck.restored !== recheck.before) throw new Error('Re-clip did not restore the same feature count');

  // ---- Roads reach the KML export with their real names ----
  const kml = await page.evaluate(() => {
    const text = buildKML();
    return {
      hasBulbarnet: text.includes('Bulbarnet Rd'),
      crossroadCount: (text.match(/Crossroad/g) || []).length,
      length: text.length,
    };
  });
  console.log('KML with real roads:', JSON.stringify(kml));
  if (!kml.hasBulbarnet) throw new Error('Real road names did not reach the KML export');
  if (!kml.crossroadCount) throw new Error('No crossroad placemarks in the KML');

  // ---- Rendering ----
  const rendered = await page.evaluate(() => {
    const html = document.getElementById('editMap').innerHTML;
    return { label: html.includes('Bulbarnet Rd'), paths: document.querySelectorAll('#editMap path').length };
  });
  console.log('rendered on the edit map:', JSON.stringify(rendered));
  if (!rendered.label) throw new Error('Real road name labels are not rendering on the map');

  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_real_roads.png') });

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL REAL-ROAD TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

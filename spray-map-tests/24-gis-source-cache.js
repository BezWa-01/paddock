const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

const ROADS = dataFile('Road_Network.zip', 'the Main Roads WA road network (~36MB zip)');
const POLES = dataFile('Poles.zip', 'the Western Power distribution pole shapefile (~17MB zip)');

/* Round 12 — GIS source files must survive a page reload.
   Until now only the small clipped RESULT was cached (localStorage); the
   source file lived in a variable and died with the page, so every new
   browser session meant re-uploading a 36MB road network and a 17MB pole file
   before a farm tick or buffer change could re-clip. This proves the source
   itself comes back from IndexedDB and re-clips against the CURRENT settings.

   Uses a persistent browser context — IndexedDB is per-profile, so a throwaway
   context would make this test meaningless. */
(async () => {
  const userDataDir = require('path').join(require('os').tmpdir(), 'spraymap-pwprofile');
  require('fs').rmSync(userDataDir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', async (d) => { console.log('DIALOG:', d.message()); await d.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  const url = appUrl();
  const bootPaddocks = () => page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([
      { id:'Annadale__Borehill', name:'Borehill', farm:'Annadale', area_ha:106, exterior:rect(116.06,-30.89,116.08,-30.87), interior:[] },
      { id:'Annadale__West40',  name:'West 40',  farm:'Annadale', area_ha:88,  exterior:rect(116.08,-30.89,116.10,-30.875), interior:[] },
    ]);
  });

  // ---------- Session 1: load both real files ----------
  await page.goto(url); await page.waitForTimeout(400);
  await bootPaddocks(); await page.waitForTimeout(600);

  await page.setInputFiles('#roadInput', ROADS);
  for (let i = 0; i < 240; i++) { if (await page.evaluate(() => typeof roadMeta !== 'undefined' && roadMeta !== null)) break; await page.waitForTimeout(250); }
  await page.setInputFiles('#poleInput', POLES);
  for (let i = 0; i < 240; i++) { if (await page.evaluate(() => typeof poleMeta !== 'undefined' && poleMeta !== null)) break; await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);   // let the IndexedDB writes settle

  const s1 = await page.evaluate(() => ({ roads: roadFeatures.length, poles: polePoints.length }));
  console.log('session 1 (files uploaded):', JSON.stringify(s1));
  if (!s1.roads || !s1.poles) throw new Error('Setup failed — layers did not load in session 1');

  const cached = await page.evaluate(async () => {
    const r = await loadGisSource(GIS_CACHE_KEYS.roads);
    const p = await loadGisSource(GIS_CACHE_KEYS.poles);
    return {
      roadsBytes: r && r.buffer ? r.buffer.byteLength : 0,
      polesBytes: p && p.buffer ? p.buffer.byteLength : 0,
      roadsName: r && r.meta ? r.meta.sourceName : null,
    };
  });
  console.log('cached in IndexedDB:', JSON.stringify(cached));
  if (cached.roadsBytes < 30000000) throw new Error('Road source not cached at full size, got ' + cached.roadsBytes);
  if (cached.polesBytes < 15000000) throw new Error('Pole source not cached at full size, got ' + cached.polesBytes);

  // ---------- Session 2: reload, upload NOTHING ----------
  await page.reload(); await page.waitForTimeout(500);
  await bootPaddocks();
  let restored = null;
  for (let i = 0; i < 200; i++) {
    restored = await page.evaluate(() => ({
      roads: typeof roadFeatures !== 'undefined' ? roadFeatures.length : 0,
      poles: typeof polePoints !== 'undefined' ? polePoints.length : 0,
      roadRaw: typeof roadRawBuffer !== 'undefined' && !!roadRawBuffer,
      poleRaw: typeof poleRawBuffer !== 'undefined' && !!poleRawBuffer,
      roadStatus: (document.getElementById('roadStatus') || {}).textContent || '',
      poleStatus: (document.getElementById('poleStatus') || {}).textContent || '',
    }));
    // Wait for the restore pass to FINISH, not merely to have set the raw
    // buffer — the status text is written after each layer re-clips.
    if (restored.roadRaw && restored.poleRaw && await page.evaluate(() => gisCacheRestoreComplete)) break;
    await page.waitForTimeout(250);
  }
  console.log('session 2 (after reload, nothing re-uploaded):', JSON.stringify({
    roads: restored.roads, poles: restored.poles, roadRaw: restored.roadRaw, poleRaw: restored.poleRaw,
  }));
  console.log('road status:', restored.roadStatus);
  if (!restored.roadRaw) throw new Error('Road SOURCE file was not restored after reload');
  if (!restored.poleRaw) throw new Error('Pole SOURCE file was not restored after reload');
  if (restored.roads !== s1.roads) throw new Error('Restored road clip differs: ' + restored.roads + ' vs ' + s1.roads);
  if (restored.poles !== s1.poles) throw new Error('Restored pole clip differs: ' + restored.poles + ' vs ' + s1.poles);
  if (!/Restored from this browser/.test(restored.roadStatus)) throw new Error('Status should say the file came from cache: ' + restored.roadStatus);

  // ---------- The point of caching the SOURCE: re-clip without a re-upload ----------
  const reclip = await page.evaluate(async () => {
    document.getElementById('roadBuffer').value = '10';
    await reclipRoads();
    return { widened: roadFeatures.length };
  });
  console.log('re-clip to 10km after restore (no re-upload):', JSON.stringify(reclip));
  if (!(reclip.widened > restored.roads)) {
    throw new Error('A restored source must be re-clippable to a wider buffer — that is the whole point. Got ' + reclip.widened + ' vs ' + restored.roads);
  }

  // ---------- Clear must forget the cached source too ----------
  await page.evaluate(() => document.getElementById('clearRoadBtn').click());
  await page.waitForTimeout(800);
  const afterClear = await page.evaluate(async () => {
    const r = await loadGisSource(GIS_CACHE_KEYS.roads);
    return { stillCached: !!(r && r.buffer), features: roadFeatures.length };
  });
  console.log('after Clear:', JSON.stringify(afterClear));
  if (afterClear.stillCached) throw new Error('Clear must also drop the cached source file, or Clear is a lie');
  if (afterClear.features !== 0) throw new Error('Clear did not empty the road layer');

  // Poles were untouched by clearing roads.
  const polesIntact = await page.evaluate(async () => {
    const p = await loadGisSource(GIS_CACHE_KEYS.poles);
    return { cached: !!(p && p.buffer), features: polePoints.length };
  });
  console.log('poles after clearing roads:', JSON.stringify(polesIntact));
  if (!polesIntact.cached || !polesIntact.features) throw new Error('Clearing one layer must not disturb another');

  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await ctx.close();
  console.log('ALL GIS-CACHE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

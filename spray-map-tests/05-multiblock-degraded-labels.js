const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');


(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', async (dialog) => { await dialog.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  // --- Setup: one simple paddock (for the label-reanchor test) and one
  // multi-block paddock with a hole that belongs to only ONE block (for the
  // interior-ring mis-attachment test). ---
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const blockA=[[116.00,-30.90],[116.02,-30.90],[116.02,-30.88],[116.00,-30.88],[116.00,-30.90]];
    const blockB=[[116.10,-30.90],[116.12,-30.90],[116.12,-30.88],[116.10,-30.88],[116.10,-30.90]]; // disjoint, far away
    const holeInA=[[116.006,-30.897],[116.010,-30.897],[116.010,-30.893],[116.006,-30.893],[116.006,-30.897]]; // a dam, inside block A only
    const paddocks=[
      { id:'F__Simple', name:'Simple', farm:'F', area_ha:44.0, exterior:rect(116.20,-30.90,116.22,-30.88), interior:[] },
      { id:'F__MultiHole', name:'MultiHole', farm:'F', area_ha:80.0, exterior:[blockA,blockB], interior:[holeInA] },
    ];
    startApp(paddocks);
  });
  await page.waitForTimeout(300);

  // --- Test 1: interior-ring mis-attachment fix — a hole that belongs to
  // only one block of a multi-block paddock must not corrupt the OTHER
  // block, and clipping must not silently degrade. ---
  const multiHoleCheck = await page.evaluate(() => {
    const p = PADDOCKS.find(pp => pp.id === 'F__MultiHole');
    const multi = paddockMultiPolygonLonLat(p);
    return {
      blockCount: multi.length,
      block0RingCount: multi[0].length,  // should have the hole (2 rings: exterior+hole)
      block1RingCount: multi[1].length,  // should NOT have the hole (1 ring: exterior only)
    };
  });
  console.log('multi-block hole attachment check:', JSON.stringify(multiHoleCheck));
  if (multiHoleCheck.blockCount !== 2) throw new Error('Expected 2 blocks, got ' + multiHoleCheck.blockCount);
  const ringCounts = [multiHoleCheck.block0RingCount, multiHoleCheck.block1RingCount].sort();
  if (ringCounts[0] !== 1 || ringCounts[1] !== 2) throw new Error('Expected exactly one block to carry the hole (1 ring vs 2 rings), got: ' + JSON.stringify(multiHoleCheck));

  // Now exclude part of block A (away from the hole) and confirm the clip
  // still runs cleanly (no exception, no degraded flag) despite the paddock
  // having a hole that only belongs to one of its two blocks.
  const clipWithHoleCheck = await page.evaluate(() => {
    exclusionGeometryDegraded = false;
    const p = PADDOCKS.find(pp => pp.id === 'F__MultiHole');
    state.exclusions.push({ id: 'ex_holed', points: [[-30.892,116.001],[-30.892,116.004],[-30.889,116.004],[-30.889,116.001]], area_ha: 5, paddockIds: ['F__MultiHole'] });
    saveState();
    const { treated } = computeTreatedGeometry(p);
    return { degraded: exclusionGeometryDegraded, treatedPolyCount: treated ? treated.length : -1 };
  });
  console.log('clip-with-hole check:', JSON.stringify(clipWithHoleCheck));
  if (clipWithHoleCheck.degraded) throw new Error('Exclusion geometry degraded on a multi-block paddock with a single-block hole — the mis-attachment bug is still present');
  if (clipWithHoleCheck.treatedPolyCount < 1) throw new Error('Expected at least one treated polygon back, got ' + clipWithHoleCheck.treatedPolyCount);

  // --- Test 2: degraded-mode warning banner actually appears when the
  // clipping library is unavailable (simulating the likely real-world cause:
  // an external CDN script that failed to load) instead of failing silently. ---
  await page.evaluate(() => {
    state.exclusions = [{ id: 'ex_1', points: [[-30.89,116.205],[-30.89,116.215],[-30.885,116.215],[-30.885,116.205]], area_ha: 5, paddockIds: ['F__Simple'] }];
    selectedCrop='W';
    editPolyLayers['F__Simple'].fire('click',{latlng:L.latLng(...PADDOCKS.find(p=>p.id==='F__Simple').centerLatLng)});
  });
  await page.waitForTimeout(200);
  const bannerBefore = await page.evaluate(() => document.getElementById('exclWarningBar').style.display);
  console.log('warning banner before degradation:', bannerBefore);
  if (bannerBefore !== 'none' && bannerBefore !== '') throw new Error('Warning banner should be hidden while clipping works fine, got: ' + bannerBefore);

  const bannerAfter = await page.evaluate(() => {
    const saved = window.polygonClipping;
    window.polygonClipping = undefined;
    renderEditMap();
    const display = document.getElementById('exclWarningBar').style.display;
    const degraded = exclusionGeometryDegraded;
    window.polygonClipping = saved; // restore
    renderEditMap();
    return { display, degraded };
  });
  console.log('warning banner while library missing:', JSON.stringify(bannerAfter));
  if (bannerAfter.display !== 'block') throw new Error('Expected the exclusion-geometry warning banner to appear when polygonClipping is unavailable, got: ' + bannerAfter.display);
  if (!bannerAfter.degraded) throw new Error('Expected exclusionGeometryDegraded to be true while the library is unavailable');

  const bannerRestored = await page.evaluate(() => document.getElementById('exclWarningBar').style.display);
  console.log('warning banner after library restored:', bannerRestored);
  if (bannerRestored !== 'none') throw new Error('Expected the warning banner to clear once the library is available again, got: ' + bannerRestored);

  // --- Test 3: crop-letter label re-anchors away from an exclusion that
  // covers the paddock's natural centre, instead of floating over blank
  // (excluded) ground. ---
  await page.evaluate(() => {
    state.treatment = {}; state.exclusions = [];
    saveState();
  });
  await page.waitForTimeout(200);
  const reanchorCheck = await page.evaluate(() => {
    const p = PADDOCKS.find(pp => pp.id === 'F__Simple');
    selectedCrop = 'W';
    editPolyLayers['F__Simple'].fire('click', { latlng: L.latLng(...p.centerLatLng) });
    // Exclusion deliberately centred exactly on the paddock's own bbox centre.
    const [clat, clon] = p.centerLatLng;
    exclusionDraft = [[clat-0.003,clon-0.003],[clat-0.003,clon+0.003],[clat+0.003,clon+0.003],[clat+0.003,clon-0.003]];
    finishExclusion();
    const anchor = effectiveLabelCenter(p);
    const excl = state.exclusions[0];
    const ring = excl.points.map(([lat,lng])=>[lng,lat]); ring.push(ring[0]);
    const anchorInsideExclusion = pointInRingLL(anchor[1], anchor[0], ring);
    return { naive: p.centerLatLng, anchor, anchorInsideExclusion };
  });
  console.log('label re-anchor check:', JSON.stringify(reanchorCheck));
  if (reanchorCheck.anchorInsideExclusion) throw new Error('effectiveLabelCenter still returned a point inside the excluded area: ' + JSON.stringify(reanchorCheck));
  const moved = Math.abs(reanchorCheck.anchor[0]-reanchorCheck.naive[0]) > 1e-6 || Math.abs(reanchorCheck.anchor[1]-reanchorCheck.naive[1]) > 1e-6;
  if (!moved) throw new Error('Expected the label anchor to move away from the naive centroid once the centroid fell inside the exclusion');

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-7 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

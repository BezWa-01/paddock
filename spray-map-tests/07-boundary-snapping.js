const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');


/* Round 9 — boundary snapping for excluded areas, and the exact per-paddock
   hectare maths that snapping makes possible.

   Test geometry:
   - "Wiggle"   a paddock whose north fence has three intermediate vertices,
                so fenceline tracing has something real to follow and the
                shorter-way-round choice can be checked against a path that
                has FEWER vertices but is geometrically longer.
   - "Bush"     a small standalone block, for one-click whole-block exclusion.
   - "West"/"East" two paddocks sharing a fence, for the straddle case where
                the old even-split approximation was wrong. */
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

  await page.evaluate(() => {
    const wiggle = [
      [116.000,-30.900],[116.020,-30.900],[116.020,-30.880],
      [116.015,-30.881],[116.010,-30.879],[116.005,-30.881],
      [116.000,-30.880],[116.000,-30.900],
    ];
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([
      { id:'F__Wiggle', name:'Wiggle', farm:'F', area_ha:400, exterior:[wiggle], interior:[] },
      { id:'F__Bush',   name:'Bush',   farm:'F', area_ha:25,  exterior:rect(116.030,-30.900,116.035,-30.895), interior:[] },
      { id:'F__West',   name:'West',   farm:'F', area_ha:100, exterior:rect(116.040,-30.900,116.050,-30.890), interior:[] },
      { id:'F__East',   name:'East',   farm:'F', area_ha:100, exterior:rect(116.050,-30.900,116.060,-30.890), interior:[] },
    ]);
  });
  await page.waitForTimeout(400);

  // ---- Test 1: a click NEAR a fence corner lands exactly ON the corner. ----
  const vertexSnap = await page.evaluate(() => {
    rebuildSnapIndex();
    const corner = [-30.880, 116.020];                 // Wiggle's NE corner
    // Offset the click by 6 screen pixels so it is inside the 14px tolerance
    // but nowhere near the corner in map coordinates.
    const pt = editMap.latLngToLayerPoint(L.latLng(corner[0], corner[1]));
    const near = editMap.layerPointToLatLng(L.point(pt.x + 6, pt.y - 5));
    const res = snapLatLng(near, SNAP_TOL_PX);
    return {
      kind: res.snap && res.snap.kind,
      exact: res.lat === corner[0] && res.lng === corner[1],
      movedFromRaw: res.lat !== near.lat || res.lng !== near.lng,
      rawOffsetDeg: Math.abs(near.lat - corner[0]) + Math.abs(near.lng - corner[1]),
    };
  });
  console.log('vertex snap:', JSON.stringify(vertexSnap));
  if (vertexSnap.kind !== 'vertex') throw new Error('Expected a vertex snap near a fence corner, got: ' + vertexSnap.kind);
  if (!vertexSnap.exact) throw new Error('A vertex snap must land exactly on the boundary vertex, not near it');
  if (!vertexSnap.movedFromRaw || !(vertexSnap.rawOffsetDeg > 0)) throw new Error('Test is not actually offsetting the click — it would pass trivially');

  // ---- Test 2: a click near a fence LINE (away from any corner) lands on
  // the line itself, not on the nearest corner. ----
  const edgeSnap = await page.evaluate(() => {
    // Midpoint of Wiggle's long south fence (lat -30.900, lon 116.000..116.020)
    const onEdge = [-30.900, 116.010];
    const pt = editMap.latLngToLayerPoint(L.latLng(onEdge[0], onEdge[1]));
    const near = editMap.layerPointToLatLng(L.point(pt.x, pt.y + 7));  // 7px below the fence
    const res = snapLatLng(near, SNAP_TOL_PX);
    return {
      kind: res.snap && res.snap.kind,
      latOnFence: Math.abs(res.lat - (-30.900)) < 1e-9,
      lngUnchanged: Math.abs(res.lng - near.lng) < 1e-9,
      movedFromRaw: Math.abs(res.lat - near.lat) > 1e-12,
    };
  });
  console.log('edge snap:', JSON.stringify(edgeSnap));
  if (edgeSnap.kind !== 'edge') throw new Error('Expected an edge snap on a straight fence away from corners, got: ' + edgeSnap.kind);
  if (!edgeSnap.latOnFence) throw new Error('An edge snap must land exactly on the fence line');
  if (!edgeSnap.movedFromRaw) throw new Error('Edge snap did not move the click onto the fence');

  // ---- Test 3: snapping can be turned off, and Alt suspends it. ----
  const snapOff = await page.evaluate(() => {
    const corner = [-30.880, 116.020];
    const pt = editMap.latLngToLayerPoint(L.latLng(corner[0], corner[1]));
    const near = editMap.layerPointToLatLng(L.point(pt.x + 6, pt.y - 5));
    snapEnabled = false;
    const off = snapLatLng(near, SNAP_TOL_PX);
    snapEnabled = true;
    altHeld = true;
    const alt = snapLatLng(near, SNAP_TOL_PX);
    altHeld = false;
    const on = snapLatLng(near, SNAP_TOL_PX);
    return {
      offRaw: off.snap === null && off.lat === near.lat,
      altRaw: alt.snap === null && alt.lat === near.lat,
      onSnapped: on.snap !== null,
    };
  });
  console.log('snap toggle/alt:', JSON.stringify(snapOff));
  if (!snapOff.offRaw) throw new Error('Unticking Snap must leave the click exactly where it was placed');
  if (!snapOff.altRaw) throw new Error('Holding Alt must suspend snapping');
  if (!snapOff.onSnapped) throw new Error('Snapping did not resume after Alt was released');

  // ---- Test 4: fenceline tracing follows the actual boundary between two
  // snapped clicks, and takes the geometrically shorter way round even when
  // that way has MORE vertices. ----
  const trace = await page.evaluate(() => {
    armedExclusion = true; exclusionDraft = []; exclusionSnapMarks = []; traceEnabled = true; snapEnabled = true;
    rebuildSnapIndex();
    addExclusionPoint(L.latLng(-30.880, 116.020));   // NE corner
    addExclusionPoint(L.latLng(-30.880, 116.000));   // NW corner
    const pts = exclusionDraft.slice();
    const has = (lat,lng) => pts.some(p => Math.abs(p[0]-lat) < 1e-9 && Math.abs(p[1]-lng) < 1e-9);
    return {
      count: pts.length,
      hasWiggleVertices: has(-30.881,116.015) && has(-30.879,116.010) && has(-30.881,116.005),
      wentTheLongWay: has(-30.900,116.020) || has(-30.900,116.000),
      pts,
    };
  });
  console.log('fenceline trace:', JSON.stringify({count:trace.count, hasWiggleVertices:trace.hasWiggleVertices, wentTheLongWay:trace.wentTheLongWay}));
  if (!trace.hasWiggleVertices) throw new Error('Tracing did not follow the three intermediate fence vertices: ' + JSON.stringify(trace.pts));
  if (trace.wentTheLongWay) throw new Error('Tracing took the long way round the paddock — it must pick the geometrically shorter path, not the one with fewer vertices');
  if (trace.count !== 5) throw new Error('Expected 2 clicked points + 3 traced fence vertices = 5, got ' + trace.count);

  // ---- Test 5: one Undo reverses one CLICK, including everything the trace
  // pulled in with it. ----
  const undo = await page.evaluate(() => {
    const before = exclusionDraft.length;
    undoExclusionPoint();
    const after = exclusionDraft.length;
    return { before, after };
  });
  console.log('undo point:', JSON.stringify(undo));
  if (undo.before !== 5 || undo.after !== 1) throw new Error('Undo should remove the clicked point and its traced fence vertices as one unit, got ' + JSON.stringify(undo));

  // ---- Test 6: tracing OFF gives a straight line between the same clicks. ----
  const noTrace = await page.evaluate(() => {
    armedExclusion = true; exclusionDraft = []; exclusionSnapMarks = []; traceEnabled = false;
    addExclusionPoint(L.latLng(-30.880, 116.020));
    addExclusionPoint(L.latLng(-30.880, 116.000));
    const n = exclusionDraft.length;
    traceEnabled = true;
    cancelExclusion();
    return n;
  });
  console.log('points with tracing off:', noTrace);
  if (noTrace !== 2) throw new Error('With Follow fenceline off, two clicks must give exactly two points, got ' + noTrace);

  // ---- Test 7: a lasso drawn sloppily PAST the fence is trimmed to the
  // fence — zero excluded area outside the paddock. ----
  const clip = await page.evaluate(() => {
    state.exclusions = []; state.treatment = {};
    selectedCrop = 'W';
    editPolyLayers['F__Wiggle'].fire('click', { latlng: L.latLng(-30.890, 116.010) });
    armedExclusion = true;
    // Deliberately overshoots the south and both side fences.
    exclusionDraft = [[-30.910,115.990],[-30.910,116.005],[-30.895,116.005],[-30.895,115.990]];
    exclusionSnapMarks = [null,null,null,null];
    const drawnHa = (function(){
      const ring = exclusionDraft.map(([lat,lng])=>[lng,lat]); ring.push(ring[0]);
      return Math.abs(geodesicArea(ring))/10000;
    })();
    finishExclusion();
    const ex = state.exclusions[0];
    const p = PADDOCKS.find(pp => pp.id === 'F__Wiggle');
    const paddock = paddockMultiPolygonLonLat(p);
    const zone = exclusionMultiPolygon(ex);
    // Any part of the zone lying OUTSIDE the paddock is a clipping failure.
    let outsideHa = -1;
    try { outsideHa = multiPolygonAreaHa(polygonClipping.difference(zone, paddock)); } catch(e) { outsideHa = -1; }
    return {
      drawnHa, zoneHa: ex.area_ha, outsideHa,
      paddockIds: ex.paddockIds,
      areaByPaddock: ex.areaByPaddock,
      exact: exclusionIsExact(ex),
    };
  });
  console.log('clip to fence:', JSON.stringify(clip));
  if (!(clip.outsideHa >= 0 && clip.outsideHa < 1e-6)) throw new Error('Excluded area still spills outside the paddock boundary: ' + clip.outsideHa + ' ha');
  if (!(clip.zoneHa < clip.drawnHa - 1)) throw new Error('The zone was not actually trimmed — drawn ' + clip.drawnHa + ' ha, stored ' + clip.zoneHa + ' ha');
  if (!clip.exact || !clip.areaByPaddock) throw new Error('A snapped zone must record exact per-paddock hectares');

  // ---- Test 8: the crop hatch hole matches the SNAPPED zone exactly (the
  // round-6 zero-overlap proof, re-run against clipped geometry). ----
  const holeCheck = await page.evaluate(() => {
    const p = PADDOCKS.find(pp => pp.id === 'F__Wiggle');
    const { treated } = computeTreatedGeometry(p);
    const zone = exclusionMultiPolygon(state.exclusions[0]);
    let overlap = -1;
    try { overlap = multiPolygonAreaHa(polygonClipping.intersection(treated, zone)); } catch(e) { overlap = -1; }
    return { overlap, degraded: exclusionGeometryDegraded };
  });
  console.log('hatch/zone overlap:', JSON.stringify(holeCheck));
  if (!(holeCheck.overlap >= 0 && holeCheck.overlap < 1e-9)) throw new Error('Treated hatch still covers excluded ground: ' + holeCheck.overlap + ' ha');
  if (holeCheck.degraded) throw new Error('Exclusion geometry reported as degraded');

  // ---- Test 9: a loose outline thrown AROUND a whole block becomes that
  // block exactly — Mike's "snap the exclusion to the polygon" case. ----
  const wholeBlock = await page.evaluate(() => {
    state.exclusions = [];
    selectedCrop = 'W';
    editPolyLayers['F__Bush'].fire('click', { latlng: L.latLng(-30.8975, 116.0325) });
    armedExclusion = true;
    // A sloppy outline entirely OUTSIDE the Bush block, not touching it.
    exclusionDraft = [[-30.902,116.028],[-30.902,116.037],[-30.893,116.037],[-30.893,116.028]];
    exclusionSnapMarks = [null,null,null,null];
    finishExclusion();
    const ex = state.exclusions[0];
    const p = PADDOCKS.find(pp => pp.id === 'F__Bush');
    const block = paddockMultiPolygonLonLat(p);
    const zone = exclusionMultiPolygon(ex);
    let symDiff = -1;
    try {
      const a = polygonClipping.difference(zone, block);
      const b = polygonClipping.difference(block, zone);
      symDiff = multiPolygonAreaHa(a) + multiPolygonAreaHa(b);
    } catch(e) { symDiff = -1; }
    return { symDiff, zoneHa: ex.area_ha, blockHa: multiPolygonAreaHa(block), ids: ex.paddockIds };
  });
  console.log('whole-block snap:', JSON.stringify(wholeBlock));
  if (!(wholeBlock.symDiff >= 0 && wholeBlock.symDiff < 1e-9)) {
    throw new Error('A lasso around a whole block must become that block EXACTLY — symmetric difference was ' + wholeBlock.symDiff + ' ha');
  }
  if (Math.abs(wholeBlock.zoneHa - wholeBlock.blockHa) > 0.01) throw new Error('Snapped zone hectares should equal the block hectares');

  // ---- Test 10: one-click whole-block exclusion mode. ----
  const clickBlock = await page.evaluate(() => {
    state.exclusions = [];
    excludePaddockBlockAt(L.latLng(-30.8975, 116.0325));
    const ex = state.exclusions[0];
    const p = PADDOCKS.find(pp => pp.id === 'F__Bush');
    const block = paddockMultiPolygonLonLat(p);
    let symDiff = -1;
    try {
      symDiff = multiPolygonAreaHa(polygonClipping.difference(exclusionMultiPolygon(ex), block))
              + multiPolygonAreaHa(polygonClipping.difference(block, exclusionMultiPolygon(ex)));
    } catch(e) { symDiff = -1; }
    const effAfter = effectiveArea(p);
    return { symDiff, ids: ex.paddockIds, ha: ex.area_ha, effAfter, blockHa: multiPolygonAreaHa(block) };
  });
  console.log('one-click block exclusion:', JSON.stringify(clickBlock));
  if (!(clickBlock.symDiff >= 0 && clickBlock.symDiff < 1e-9)) throw new Error('One-click block exclusion must use the block geometry exactly');
  if (clickBlock.ids[0] !== 'F__Bush') throw new Error('Wrong paddock attributed: ' + JSON.stringify(clickBlock.ids));
  if (clickBlock.effAfter > 0.02) throw new Error('Excluding a whole block should leave ~0 effective hectares, got ' + clickBlock.effAfter);

  // ---- Test 10b: a paddock excluded in its entirety loses its crop letter.
  // Round 7 taught the letter to dodge an exclusion; with nothing left to
  // dodge to it fell back to the paddock centre and sat over blank ground.
  // One-click block exclusion makes that easy to hit. ----
  const fullyExcluded = await page.evaluate(() => {
    smartCircleLabels(editMap, editPolyLayers, editCircleGroup, 30);
    const bush = PADDOCKS.find(p => p.id === 'F__Bush');
    const bushLetterVisible = editCircleGroup.getLayers().some(l => {
      const ll = l.getLatLng ? l.getLatLng() : null;
      return ll && ll.lat < -30.894 && ll.lat > -30.901 && ll.lng > 116.029 && ll.lng < 116.036;
    });
    return {
      isFully: paddockFullyExcluded(bush),
      stillTreatedInState: !!state.treatment['F__Bush'],
      bushLetterVisible,
      effective: effectiveArea(bush),
    };
  });
  console.log('fully-excluded paddock:', JSON.stringify(fullyExcluded));
  if (!fullyExcluded.isFully) throw new Error('Expected the Bush block to be fully excluded at this point');
  if (!fullyExcluded.stillTreatedInState) throw new Error('Test setup wrong — the paddock should still carry a crop assignment');
  if (fullyExcluded.bushLetterVisible) throw new Error('A fully excluded paddock must not show a crop letter over blank ground');
  if (fullyExcluded.effective > 0.02) throw new Error('A fully excluded paddock should contribute no treated hectares');

  // ---- Test 11: a zone straddling two paddocks splits by ACTUAL overlap,
  // not evenly — the specific inaccuracy this round removes. ----
  const straddle = await page.evaluate(() => {
    state.exclusions = [];
    selectedCrop = 'W';
    editPolyLayers['F__West'].fire('click', { latlng: L.latLng(-30.895, 116.045) });
    editPolyLayers['F__East'].fire('click', { latlng: L.latLng(-30.895, 116.055) });
    armedExclusion = true;
    // Crosses the shared fence at lon 116.050 with 80% of its width in West.
    exclusionDraft = [[-30.897,116.042],[-30.897,116.052],[-30.893,116.052],[-30.893,116.042]];
    exclusionSnapMarks = [null,null,null,null];
    finishExclusion();
    const ex = state.exclusions[0];
    return {
      ids: ex.paddockIds.slice().sort(),
      west: ex.areaByPaddock['F__West'],
      east: ex.areaByPaddock['F__East'],
      total: ex.area_ha,
      westEff: effectiveArea(PADDOCKS.find(p=>p.id==='F__West')),
      eastEff: effectiveArea(PADDOCKS.find(p=>p.id==='F__East')),
    };
  });
  console.log('straddle split:', JSON.stringify(straddle));
  if (straddle.ids.join('|') !== 'F__East|F__West') throw new Error('Expected the zone to be attributed to both paddocks');
  const ratio = straddle.west / straddle.east;
  if (!(ratio > 3.2 && ratio < 4.8)) throw new Error('Expected roughly a 4:1 West:East split by real overlap (the old code would have said 1:1), got ratio ' + ratio.toFixed(2));
  if (Math.abs((straddle.west + straddle.east) - straddle.total) > 0.05) throw new Error('Per-paddock areas should sum to the zone total');

  // ---- Test 12: zones saved by an older version (points only, no geom and
  // no areaByPaddock) still render, still cut a hole, and keep their old
  // even-split hectares rather than breaking or silently changing. ----
  const legacy = await page.evaluate(() => {
    state.exclusions = [{
      id: 'ex_legacy',
      points: [[-30.897,116.003],[-30.897,116.007],[-30.894,116.007],[-30.894,116.003]],
      area_ha: 12,
      paddockIds: ['F__Wiggle'],
    }];
    saveState();
    renderEditMap();
    const p = PADDOCKS.find(pp => pp.id === 'F__Wiggle');
    const { treated } = computeTreatedGeometry(p);
    const zone = exclusionMultiPolygon(state.exclusions[0]);
    let overlap = -1;
    try { overlap = multiPolygonAreaHa(polygonClipping.intersection(treated, zone)); } catch(e) { overlap = -1; }
    return {
      overlap,
      exact: exclusionIsExact(state.exclusions[0]),
      subtracted: exclusionAreaForPaddock('F__Wiggle'),
      degraded: exclusionGeometryDegraded,
      clickTargets: exclusionGroup.getLayers().length,
    };
  });
  console.log('legacy zone:', JSON.stringify(legacy));
  if (!(legacy.overlap >= 0 && legacy.overlap < 1e-9)) throw new Error('A pre-round-9 saved zone no longer cuts its hole: ' + legacy.overlap);
  if (legacy.exact) throw new Error('A legacy zone must not claim to have exact areas');
  if (Math.abs(legacy.subtracted - 12) > 0.001) throw new Error('A legacy zone must keep its saved hectares (even split), got ' + legacy.subtracted);
  if (!legacy.clickTargets) throw new Error('A legacy zone must still be click-to-delete');

  // ---- Test 13: snapping only offers boundaries you can actually see. ----
  const scoping = await page.evaluate(() => {
    const before = snapIndex.length;
    const farms = [...checkedFarms];
    checkedFarms.clear();
    rebuildSnapIndex();
    const after = snapIndex.length;
    farms.forEach(f => checkedFarms.add(f));
    rebuildSnapIndex();
    return { before, after, restored: snapIndex.length };
  });
  console.log('snap index scoping:', JSON.stringify(scoping));
  if (scoping.before < 4) throw new Error('Expected a snap ring per visible paddock block');
  if (scoping.after !== 0) throw new Error('Snapping must not offer boundaries for unticked farms');
  if (scoping.restored !== scoping.before) throw new Error('Snap index did not rebuild after re-ticking');

  // ---- Test 14: clipping can split one drawn lasso into separate pieces
  // (here a band crossing Bush, then open ground, then West) and the KML
  // export must carry both pieces — not a single polygon spanning the gap.
  // Adjacent paddocks are a different case: a zone crossing their shared
  // fence correctly stays one polygon, which Test 11 already covers. ----
  const kml = await page.evaluate(() => {
    state.exclusions = [];
    armedExclusion = true;
    // lon 116.032→116.045 crosses Bush (…116.035), then a gap with no
    // paddock at all (116.035→116.040), then West (116.040…).
    exclusionDraft = [[-30.897,116.032],[-30.897,116.045],[-30.896,116.045],[-30.896,116.032]];
    exclusionSnapMarks = [null,null,null,null];
    finishExclusion();
    const ex = state.exclusions[0];
    const text = buildKML();
    const idx = text.indexOf('Excluded area');
    const chunk = text.slice(idx, idx + 4000);
    return {
      pieces: exclusionMultiPolygon(ex).length,
      ids: ex.paddockIds.slice().sort(),
      hasExcluded: idx > -1,
      isMulti: chunk.includes('<MultiGeometry>'),
      polyCount: (chunk.match(/<Polygon>/g) || []).length,
      mentionsGapLon: chunk.includes('116.037'),
    };
  });
  console.log('KML export of a split zone:', JSON.stringify(kml));
  if (!kml.hasExcluded) throw new Error('Excluded zone missing from the KML');
  if (kml.pieces !== 2) throw new Error('Clipping should have split this zone into 2 pieces, got ' + kml.pieces);
  if (kml.ids.join('|') !== 'F__Bush|F__West') throw new Error('Wrong paddocks attributed: ' + JSON.stringify(kml.ids));
  if (!kml.isMulti || kml.polyCount < 2) throw new Error('A zone split by clipping must export as both pieces, got ' + JSON.stringify(kml));
  if (kml.mentionsGapLon) throw new Error('The exported zone still covers the open ground between the two paddocks');

  // ---- Test 15: UI plumbing — the new controls exist and the GIS panel
  // collapses. ----
  const ui = await page.evaluate(() => {
    const panel = document.getElementById('gisPanel');
    const wasHidden = panel.classList.contains('hidden');
    setGisPanel(true);
    const openNow = !panel.classList.contains('hidden');
    setGisPanel(false);
    return {
      wasHidden, openNow,
      closedAgain: panel.classList.contains('hidden'),
      hasSnapChk: !!document.getElementById('snapChk'),
      hasTraceChk: !!document.getElementById('traceChk'),
      hasUndo: !!document.querySelector('#exclusionControls .lc-undo'),
      hasBlockBtn: !!document.getElementById('exclPaddockBtn'),
      summary: document.getElementById('gisToggleSummary').textContent,
    };
  });
  console.log('UI check:', JSON.stringify(ui));
  if (!ui.wasHidden) throw new Error('GIS layer panel should start collapsed');
  if (!ui.openNow || !ui.closedAgain) throw new Error('GIS layer panel does not toggle');
  if (!ui.hasSnapChk || !ui.hasTraceChk || !ui.hasUndo || !ui.hasBlockBtn) throw new Error('Missing new exclusion controls: ' + JSON.stringify(ui));

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-9 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

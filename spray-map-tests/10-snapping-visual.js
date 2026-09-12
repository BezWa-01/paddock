const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

/* Drives the real UI with real mouse events — arming the tool by clicking the
   button, moving the pointer, clicking on the map — rather than calling the
   drawing functions directly, so this exercises the same path Mike will. */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERR:', e.message));
  await page.route('**://*.tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.goto(appUrl());
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    // A paddock with a visibly crooked north-west fence, so a straight-line
    // drawing would obviously leave slivers and tracing obviously wouldn't.
    const crooked = [
      [116.000,-30.900],[116.020,-30.900],[116.020,-30.880],
      [116.015,-30.8815],[116.0115,-30.8788],[116.008,-30.8818],[116.004,-30.8792],
      [116.000,-30.880],[116.000,-30.900],
    ];
    startApp([{ id:'F__Crooked', name:'Crooked', farm:'F', area_ha:420, exterior:[crooked], interior:[] }]);
    document.getElementById('showNamesChk').checked = false;
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    selectedCrop = 'W';
    editPolyLayers['F__Crooked'].fire('click', { latlng: L.latLng(-30.890, 116.010) });
  });
  await page.waitForTimeout(600);

  const toXY = async (lat, lng) => page.evaluate(([la, ln]) => {
    const p = editMap.latLngToContainerPoint(L.latLng(la, ln));
    const r = document.getElementById('editMap').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lat, lng]);

  // Arm the tool through the actual button.
  await page.click('#exclBtn');
  await page.waitForTimeout(150);
  const cursor = await page.evaluate(() => getComputedStyle(document.getElementById('editMap')).cursor);
  console.log('cursor while armed:', cursor);
  if (cursor !== 'crosshair') throw new Error('Expected a crosshair cursor while the exclude tool is armed, got ' + cursor);

  // Hover a few pixels off a fence corner — the snap indicator should appear
  // ON the corner.
  const ne = await toXY(-30.880, 116.020);
  await page.mouse.move(ne.x + 7, ne.y + 6);
  await page.waitForTimeout(250);
  const indicator = await page.evaluate(() => {
    if (!snapIndicatorLayer) return null;
    const ll = snapIndicatorLayer.getLatLng();
    return { lat: ll.lat, lng: ll.lng, onCorner: Math.abs(ll.lat + 30.880) < 1e-9 && Math.abs(ll.lng - 116.020) < 1e-9 };
  });
  console.log('snap indicator while hovering near the NE corner:', JSON.stringify(indicator));
  if (!indicator || !indicator.onCorner) throw new Error('Snap indicator did not appear on the fence corner: ' + JSON.stringify(indicator));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_snap_indicator.png'), clip: { x: ne.x - 220, y: ne.y - 120, width: 440, height: 260 } });

  // Click the corner, then hover toward the far corner — the rubber band
  // should already be following the crooked fence before committing.
  await page.mouse.click(ne.x + 7, ne.y + 6);
  await page.waitForTimeout(150);
  const nw = await toXY(-30.880, 116.000);
  await page.mouse.move(nw.x - 6, nw.y + 5);
  await page.waitForTimeout(250);
  const band = await page.evaluate(() => hoverPreviewLayer ? hoverPreviewLayer.getLatLngs().length : 0);
  console.log('rubber-band vertices while hovering the far corner:', band);
  if (band < 5) throw new Error('The live preview should already show the traced fenceline, got ' + band + ' vertices');
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_rubber_band.png') });

  // Commit the traced edge, then close the shape well INSIDE the paddock.
  await page.mouse.click(nw.x - 6, nw.y + 5);
  await page.waitForTimeout(150);
  const p3 = await toXY(-30.8865, 116.002);
  await page.mouse.click(p3.x, p3.y);
  const p4 = await toXY(-30.8865, 116.018);
  await page.mouse.click(p4.x, p4.y);
  await page.waitForTimeout(150);

  const drafted = await page.evaluate(() => ({ points: exclusionDraft.length, status: document.querySelector('#exclusionControls .lc-status').textContent }));
  console.log('draft before finishing:', JSON.stringify(drafted));

  // Finish with the keyboard shortcut rather than the button.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  const result = await page.evaluate(() => {
    const ex = state.exclusions[0];
    const p = PADDOCKS.find(pp => pp.id === 'F__Crooked');
    const paddock = paddockMultiPolygonLonLat(p);
    const zone = exclusionMultiPolygon(ex);
    const { treated } = computeTreatedGeometry(p);
    let outside = -1, overlap = -1;
    try { outside = multiPolygonAreaHa(polygonClipping.difference(zone, paddock)); } catch(e) {}
    try { overlap = multiPolygonAreaHa(polygonClipping.intersection(treated, zone)); } catch(e) {}
    // Does the excluded zone's northern edge actually sit on the crooked
    // fence? Every traced fence vertex should be a vertex of the zone.
    const ring = zone[0][0];
    const fence = [[116.015,-30.8815],[116.0115,-30.8788],[116.008,-30.8818],[116.004,-30.8792]];
    const onZone = fence.filter(([lon,lat]) => ring.some(c => Math.abs(c[0]-lon) < 1e-9 && Math.abs(c[1]-lat) < 1e-9)).length;
    return { ha: ex.area_ha, outside, overlap, tracedVerticesKept: onZone, exact: exclusionIsExact(ex), hint: document.getElementById('exclHint').textContent };
  });
  console.log('finished zone:', JSON.stringify(result));
  if (!(result.outside >= 0 && result.outside < 1e-6)) throw new Error('Zone spills outside the paddock: ' + result.outside);
  if (!(result.overlap >= 0 && result.overlap < 1e-9)) throw new Error('Hatch still covers excluded ground: ' + result.overlap);
  if (result.tracedVerticesKept !== 4) throw new Error('The traced fence vertices did not survive into the final zone (' + result.tracedVerticesKept + '/4) — the excluded edge is not following the fenceline');

  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_result_full.png') });
  const box = await page.evaluate(() => {
    const b = editPolyLayers['F__Crooked'].getBounds();
    const nw2 = editMap.latLngToContainerPoint(b.getNorthWest());
    const se2 = editMap.latLngToContainerPoint(b.getSouthEast());
    const r = document.getElementById('editMap').getBoundingClientRect();
    return { x: r.left + nw2.x - 40, y: r.top + nw2.y - 40, width: (se2.x - nw2.x) + 80, height: (se2.y - nw2.y) + 80 };
  });
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'shot_result_zoom.png'), clip: box });

  console.log('OK — screenshots written');
  await browser.close();
})().catch(e => { console.error('VISUAL CHECK FAILED:', e); process.exit(1); });

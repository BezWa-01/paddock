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
  await page.route('**://server.arcgisonline.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  const setup = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      { id:'Glenyara__Borehill', name:'A Really Quite Long Paddock Name Here', farm:'Glenyara', area_ha:106.337, exterior:rect(116.00,-30.90,116.01,-30.89), interior:[] },
      { id:'Jindabyne__Home_1', name:'Home 1', farm:'Jindabyne', area_ha:51.0, exterior:rect(116.20,-30.80,116.21,-30.79), interior:[] },
    ];
    startApp(paddocks);
  });
  await page.waitForTimeout(400);

  // Treat Borehill so it gets a circle label, and make sure name labels are on.
  await page.evaluate(() => {
    selectedCrop='W';
    const poly=editPolyLayers['Glenyara__Borehill'];
    poly.fire('click',{latlng:L.latLng(...PADDOCKS.find(p=>p.id==='Glenyara__Borehill').centerLatLng)});
    document.getElementById('showNamesChk').checked=true;
    renderEditMap();
  });
  await page.waitForTimeout(500);

  // --- Test 1: paddock name label must not overlap the crop circle label ---
  const overlapCheck = await page.evaluate(() => {
    function rectOf(el){ const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }
    function intersects(a,b){ return a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top; }
    const circle=document.querySelector('.cl-circle');
    const nameLbl=document.querySelector('.smart-label');
    if(!circle||!nameLbl) return {found:false};
    return {found:true, overlap:intersects(rectOf(circle), rectOf(nameLbl))};
  });
  console.log('label overlap check:', JSON.stringify(overlapCheck));
  if (!overlapCheck.found) throw new Error('Expected both a circle label and a name label to be present');
  if (overlapCheck.overlap) throw new Error('Name label still overlaps the crop circle label');

  // --- Test 2: excluded area is a REAL geometric hole in the crop hatch — no
  // red fill, no dashed border, no opaque white mask, nothing drawn on top.
  // It must look exactly like an untreated paddock, per Mike's explicit spec
  // ("we keep going around this point without fixing the issue").
  const exclResult = await page.evaluate(() => {
    exclusionDraft = [[-30.891,116.000],[-30.891,116.010],[-30.890,116.010],[-30.890,116.000]];
    finishExclusion();
    return state.exclusions.length;
  });
  await page.waitForTimeout(300);
  console.log('exclusions after draw:', exclResult);

  // 2a. Prove it geometrically: the treated multipolygon must have ZERO overlap
  // with the exclusion polygon (a true boolean difference), not just a shape
  // drawn on top that happens to look right.
  const geomCheck = await page.evaluate(() => {
    const p = PADDOCKS.find(pp => pp.id === 'Glenyara__Borehill');
    const excls = exclusionsForPaddock(p.id);
    const { treated } = computeTreatedGeometry(p);
    function ringArea(ring) {
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) a += ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1];
      return Math.abs(a / 2);
    }
    function multiPolyArea(mp) {
      let total = 0;
      (mp || []).forEach(rings => rings.forEach((ring, idx) => { total += (idx === 0 ? 1 : -1) * ringArea(ring); }));
      return total;
    }
    let overlapArea = -1;
    try {
      const exclPolys = excls.map(ex => [exclusionRingLonLat(ex)]);
      const inter = polygonClipping.intersection(treated, ...exclPolys);
      overlapArea = multiPolyArea(inter);
    } catch (e) { overlapArea = -1; }
    return { exclCount: excls.length, overlapArea, treatedRings: treated.length };
  });
  console.log('exclusion geometry check:', JSON.stringify(geomCheck));
  if (geomCheck.exclCount !== 1) throw new Error('Expected the paddock to have exactly 1 exclusion, got ' + geomCheck.exclCount);
  if (geomCheck.overlapArea < 0) throw new Error('Geometry check threw — polygon-clipping did not run: ' + JSON.stringify(geomCheck));
  if (geomCheck.overlapArea > 1e-9) throw new Error('Treated area still overlaps the exclusion — no real hole was cut: ' + JSON.stringify(geomCheck));

  // 2b. Prove it visually: no opaque white mask, no red fill/stroke, no dashed
  // border anywhere on the edit map's SVG — the only marks are the black crop
  // hatch (which simply has no fill in the excluded notch) and normal paddock
  // outlines.
  const visualCheck = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('#editMap svg path')];
    const opaqueWhite = paths.find(p => (p.getAttribute('fill')||'').toLowerCase() === '#ffffff' && parseFloat(p.getAttribute('fill-opacity')||'0') > 0.05);
    const anyRed = paths.find(p => {
      const stroke = (p.getAttribute('stroke')||'').toLowerCase();
      const fill = (p.getAttribute('fill')||'').toLowerCase();
      return stroke.includes('c0392b') || stroke.includes('e74c3c') || fill.includes('c0392b') || fill.includes('e74c3c');
    });
    const anyDashed = paths.find(p => p.getAttribute('stroke-dasharray'));
    return {
      opaqueWhite: !!opaqueWhite,
      anyRed: !!anyRed,
      anyDashed: !!anyDashed,
    };
  });
  console.log('exclusion visual check:', JSON.stringify(visualCheck));
  if (visualCheck.opaqueWhite) throw new Error('Found an opaque white mask on the exclusion — must be fully invisible');
  if (visualCheck.anyRed) throw new Error('Found red fill/stroke on the exclusion — must have no distinguishing colour');
  if (visualCheck.anyDashed) throw new Error('Found a dashed border on the exclusion — must have no border at all');
  const anyHatchRef = await page.evaluate(() => document.documentElement.innerHTML.includes('exclHatch'));
  if (anyHatchRef) throw new Error('Expected the old red exclHatch pattern to be removed entirely');

  // 2c. Clicking inside the (invisible) excluded notch still opens the delete popup.
  const clickResult = await page.evaluate(() => {
    const layers = exclusionGroup.getLayers();
    if (!layers.length) return { found: false };
    const layer = layers[0];
    layer.fire('click', { latlng: L.latLng(-30.8905, 116.005) });
    return { found: true, hasPopup: !!layer.getPopup(), popupOpen: layer.isPopupOpen ? layer.isPopupOpen() : null };
  });
  console.log('exclusion click-to-delete check:', JSON.stringify(clickResult));
  if (!clickResult.found) throw new Error('Expected an exclusion layer to exist on the edit map for click testing');
  if (!clickResult.hasPopup) throw new Error('Clicking the excluded area did not bind a delete popup');

  // --- Test 3: hazard/line counts filtered to farm selection ---
  const hazardSetup = await page.evaluate(() => {
    state.hazards.push({id:'hz_glenyara', type:'dam', lat:-30.895, lng:116.005, note:''}); // inside Glenyara
    state.hazards.push({id:'hz_jindabyne', type:'windmill', lat:-30.805, lng:116.205, note:''}); // inside Jindabyne
    saveState();
    renderEditMap();
    return true;
  });
  await page.waitForTimeout(300);
  const bothFarmsChecked = await page.$eval('#summaryBar', el => el.textContent);
  console.log('summary with both farms checked:', bothFarmsChecked);
  if (!bothFarmsChecked.includes('2 hazard marker')) throw new Error('Expected 2 hazard markers counted with both farms checked, got: ' + bothFarmsChecked);

  // Uncheck Jindabyne — only the Glenyara hazard should count now.
  const checkboxes = await page.$$('#farmChecks .farm-check input[type=checkbox]');
  const labels = await page.$$eval('#farmChecks .farm-check', els => els.map(e => e.textContent));
  console.log('farm checkbox labels:', JSON.stringify(labels));
  const jindabyneIdx = labels.findIndex(l => l.includes('Jindabyne'));
  if (jindabyneIdx === -1) throw new Error('Could not find Jindabyne checkbox');
  await checkboxes[jindabyneIdx].click();
  await page.waitForTimeout(300);
  const oneFarmChecked = await page.$eval('#summaryBar', el => el.textContent);
  console.log('summary with only Glenyara checked:', oneFarmChecked);
  if (!oneFarmChecked.includes('1 hazard marker')) throw new Error('Expected only 1 hazard marker counted once Jindabyne is unchecked, got: ' + oneFarmChecked);

  const hazardMarkersOnMap = await page.$$eval('#editMap .leaflet-marker-icon', els => els.length);
  console.log('marker icons rendered on edit map (Glenyara only):', hazardMarkersOnMap);

  // --- Test 4: "roads" high-contrast basemap replaces the rejected topo options,
  // reuses the proven OSM tile source, and is the default selected on load ---
  const roadsCheck = await page.evaluate(() => {
    const layer = makeTile('roads');
    return {
      url: layer._url,
      optionExists: !!document.querySelector('#basemapSel option[value="roads"]'),
      topoOptionGone: !document.querySelector('#basemapSel option[value="topo"]'),
      defaultSelected: document.getElementById('basemapSel').value,
      defaultEditTileType: editTileType,
      hasVividClassOnLoad: document.getElementById('editMap').classList.contains('tiles-vivid'),
    };
  });
  console.log('roads basemap check:', JSON.stringify(roadsCheck));
  if (!roadsCheck.url.includes('tile.openstreetmap.org')) throw new Error('Expected "roads" to reuse the OSM tile source, got: ' + roadsCheck.url);
  if (!roadsCheck.optionExists) throw new Error('Expected a "roads" option in the basemap dropdown');
  if (!roadsCheck.topoOptionGone) throw new Error('Expected the old "topo" option to be removed');
  if (roadsCheck.defaultSelected !== 'roads') throw new Error('Expected "roads" to be the default-selected basemap, got: ' + roadsCheck.defaultSelected);
  if (roadsCheck.defaultEditTileType !== 'roads') throw new Error('Expected editTileType to default to "roads", got: ' + roadsCheck.defaultEditTileType);
  if (!roadsCheck.hasVividClassOnLoad) throw new Error('Expected the edit map to have the tiles-vivid contrast-boost class applied on initial load');

  // Switch to plain OSM and back, confirm the vivid filter class toggles correctly.
  await page.selectOption('#basemapSel', 'osm');
  await page.waitForTimeout(200);
  const afterOsm = await page.evaluate(() => document.getElementById('editMap').classList.contains('tiles-vivid'));
  if (afterOsm) throw new Error('Expected tiles-vivid to be removed when switching to plain OSM');
  await page.selectOption('#basemapSel', 'roads');
  await page.waitForTimeout(200);
  const afterRoads = await page.evaluate(() => document.getElementById('editMap').classList.contains('tiles-vivid'));
  if (!afterRoads) throw new Error('Expected tiles-vivid to be re-applied when switching back to "roads"');
  const roadsAttrib = await page.evaluate(() => TILE_ATTRIB['roads']);
  console.log('roads attribution:', roadsAttrib);
  if (!roadsAttrib.includes('OpenStreetMap')) throw new Error('Expected OSM attribution for the roads basemap');

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-5 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

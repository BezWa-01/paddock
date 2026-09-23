const { chromium } = require('playwright');
const { appUrl, fixture, stubTiles } = require('./harness');

/* Round 18 — map text must not collide, and a road gets its name once.

   Reported from a real screenshot: a row of overlapping blue chips reading
   "Bindoon Moora Rd" six times across the top of the map, an airstrip note
   written through two paddock names, and road names sitting on the crop
   hatch. Two causes:

   1. Road names were placed per shapefile FEATURE. Main Roads WA stores one
      road as many features, so one road drew many labels, all within a few
      pixels of each other.
   2. Every label system placed its own text blind to the others. Crop
      letters, paddock names, hazard icons, the airstrip note and road names
      all competed for the same pixels with no shared occupancy.

   Both are invisible to every other suite, which asserts geometry and
   numbers. This one asserts the pixels: what is drawn, where, and that no two
   pieces of text overlap. It also pins the rule that keeps a road name off
   the spray instruction — no road label over crop hatch unless it is that
   road's only label. */

const rect = (a,b,c,d) => [[[a,b],[c,b],[c,d],[a,d],[a,b]]];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', async d => { await d.accept(); });
  await stubTiles(page);

  await page.goto(appUrl());
  await page.waitForTimeout(400);
  await page.evaluate((r) => {
    const mk = new Function('a','b','c','d','return ' + r);
    startApp([
      { id:'F__Borehill', name:'Borehill', farm:'F', area_ha:240, exterior:mk(116.00,-30.90,116.02,-30.88), interior:[] },
      { id:'F__West40',   name:'West 40',  farm:'F', area_ha:160, exterior:mk(116.025,-30.90,116.04,-30.885), interior:[] },
    ]);
    document.getElementById('showNamesChk').checked = true;
  }, rect.toString().replace(/^\(a,b,c,d\) => /,''));
  await page.waitForTimeout(700);

  // Treat both paddocks by click — the real path, no manual re-render.
  await page.evaluate(async () => {
    selectedCrop = 'W';
    let p = PADDOCKS.find(x => x.id === 'F__Borehill');
    editPolyLayers[p.id].fire('click', { latlng: L.latLng(...p.centerLatLng) });
    selectedCrop = 'C';
    p = PADDOCKS.find(x => x.id === 'F__West40');
    editPolyLayers[p.id].fire('click', { latlng: L.latLng(...p.centerLatLng) });
    await new Promise(r => setTimeout(r, 700));
  });

  /* Load roads through the real file input. The fixture holds THREE features,
     two of which are inside the buffer and share nothing; to reproduce the
     reported defect the test then splits one road into six features with the
     same name — exactly what Main Roads WA does — and re-renders. */
  await page.setInputFiles('#roadInput', fixture('Road_Network_test.zip'));
  await page.waitForTimeout(2500);
  const loaded = await page.evaluate(() => ({ n: roadFeatures.length, names: roadFeatures.map(f => f.name) }));
  console.log('roads loaded:', JSON.stringify(loaded));
  if (!loaded.n) throw new Error('Road fixture did not load');

  const split = await page.evaluate(async () => {
    // Re-file one road as six separate features under the same name, each
    // carrying the road's full run — the shape a statewide network export
    // produces, and the shape that drew six overlapping chips in one place.
    const f = roadFeatures.find(x => x.name);
    const name = f.name;
    const pieces = [];
    for (let i = 0; i < 6; i++) pieces.push({ name, rings: [f.rings[0].map(p => p.slice())] });
    roadFeatures = pieces.concat(roadFeatures.filter(x => x.name !== name));
    renderEditMap();
    await new Promise(r => setTimeout(r, 900));
    return { features: roadFeatures.length, sameName: roadFeatures.filter(x => x.name === name).length, name };
  });
  console.log('after splitting one road into six features:', JSON.stringify(split));
  if (split.sameName !== 6) throw new Error('Test setup failed to create six same-named features');

  // --- 1. One road, one name (at most the repeat cap), not one per feature ---
  /* Counted by TEXT, not by CSS class, so this assertion is meaningful
     against the pre-round-18 build too — where road names were boxed divs
     with no class of their own. */
  const labels = await page.evaluate(() => {
    const names = [...new Set(roadFeatures.filter(f => f.name).map(f => f.name))];
    const out = [];
    document.querySelectorAll('#editMap .leaflet-marker-icon').forEach(el => {
      const t = (el.textContent || '').trim();
      if (!names.includes(t)) return;
      const r = el.getBoundingClientRect();
      out.push({ text: t, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    });
    return { labels: out, cap: (typeof ROAD_LABEL_MAX_PER_ROAD !== 'undefined' ? ROAD_LABEL_MAX_PER_ROAD : 2),
             stats: (typeof roadLabelStats !== 'undefined' ? roadLabelStats : null) };
  });
  const counts = {};
  labels.labels.forEach(l => { counts[l.text] = (counts[l.text] || 0) + 1; });
  console.log('road labels drawn:', JSON.stringify(counts), 'stats:', JSON.stringify(labels.stats));
  if (!labels.labels.length) throw new Error('No road labels were drawn at all');
  const overCap = Object.entries(counts).filter(([, n]) => n > labels.cap);
  if (overCap.length) throw new Error('A road is labelled more times than the repeat cap — labels are being placed per shapefile feature again: ' + JSON.stringify(overCap));

  // --- 2. No two labels on the map may overlap, of any kind ---
  const allText = await page.evaluate(() => {
    const out = [];
    const names = [...new Set(roadFeatures.filter(f => f.name).map(f => f.name))];
    document.querySelectorAll('#editMap .leaflet-marker-icon, #editMap .cl-circle, #editMap .smart-label').forEach(el => {
      const t = (el.textContent || '').trim();
      if (!t) return;
      // A Leaflet marker wraps its own inner div, so count the inner one only
      // — otherwise every label "overlaps" itself.
      if (el.querySelector('.cl-circle, .map-halo')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      // Only text, and only text this tool places: skip the × marks and the
      // rotated arrow glyphs, which are symbols rather than labels.
      if (t === '\u00d7' || t === '\u27a4') return;
      out.push({ kind: (el.className || '').toString().replace('map-halo ','').trim() || (names.includes(t) ? 'road' : 'other'),
                 text: t.slice(0,22), left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    });
    return out;
  });
  const hits = [];
  for (let i = 0; i < allText.length; i++) for (let j = i+1; j < allText.length; j++) {
    const a = allText[i], b = allText[j];
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) hits.push([a.kind+':'+a.text, b.kind+':'+b.text]);
  }
  console.log('text items on map:', allText.length, 'overlapping pairs:', JSON.stringify(hits));
  if (hits.length) throw new Error('Map text overlaps: ' + JSON.stringify(hits));

  // --- 3. A road label may sit on crop hatch only if it is that road's only
  //        label. The hatch is the spray instruction; a repeat label is not
  //        worth obscuring it. ---
  const onHatch = await page.evaluate(() => {
    const box = document.getElementById('editMap').getBoundingClientRect();
    const byText = {};
    document.querySelectorAll('#editMap .road-label').forEach(el => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width/2 - box.left, cy = r.top + r.height/2 - box.top;
      const t = el.textContent.trim();
      (byText[t] = byText[t] || []).push(overTreatedGround(editMap, cx, cy));
    });
    return byText;
  });
  console.log('road labels over crop hatch:', JSON.stringify(onHatch));
  for (const [text, flags] of Object.entries(onHatch)) {
    const over = flags.filter(Boolean).length;
    if (flags.length > 1 && over > 0) throw new Error(`"${text}" has ${flags.length} labels and ${over} of them sit on crop hatch — a repeat label must never cover the spray instruction`);
  }

  // --- 4. Roads are drawn as a road: dark casing under a warm fill, not the
  //        flat blue line that was indistinguishable from water and from the
  //        dashed power lines beside it. ---
  const strokes = await page.evaluate(() => {
    const set = {};
    document.querySelectorAll('#editMap path').forEach(p => {
      const c = (p.getAttribute('stroke') || '').toLowerCase();
      if (c) set[c] = (set[c] || 0) + 1;
    });
    return set;
  });
  console.log('path stroke colours on the edit map:', JSON.stringify(strokes));
  if (!strokes['#ffb531']) throw new Error('No warm road fill drawn: ' + JSON.stringify(strokes));
  if (!strokes['#6b4400']) throw new Error('No road casing drawn: ' + JSON.stringify(strokes));
  if (strokes['#0066d3']) throw new Error('Roads are back to the flat blue line');

  // --- 5. Esri's own rotated road names must come off once Mike's
  //        authoritative road layer is loaded. They cannot be moved, they
  //        duplicate his names, and on a vertical road they render as a
  //        column of tick marks. ---
  const overlay = await page.evaluate(() => {
    const urls = (l) => l._url ? [l._url] : l.getLayers().map(x => x._url);
    return {
      roadLayerLoaded: roadLayerLoaded,
      withRoads: urls(makeTile('bw')),
    };
  });
  console.log('basemap with his road layer loaded:', JSON.stringify(overlay));
  if (!overlay.roadLayerLoaded) throw new Error('roadLayerLoaded did not become true after loading roads');
  if (overlay.withRoads.some(u => /World_Transportation/.test(u))) {
    throw new Error("Esri's transportation overlay is still drawn while his own road layer is loaded — its rotated raster road names are unmovable clutter under the labels this tool places");
  }

  // And it must come back when his layer is cleared, or a farm with no road
  // file gets a basemap with no roads at all.
  const cleared = await page.evaluate(async () => {
    document.getElementById('clearRoadBtn').click();
    await new Promise(r => setTimeout(r, 600));
    const urls = (l) => l._url ? [l._url] : l.getLayers().map(x => x._url);
    return { roadLayerLoaded: roadLayerLoaded, urls: urls(makeTile('bw')), labels: document.querySelectorAll('#editMap .road-label').length };
  });
  console.log('after clearing his road layer:', JSON.stringify(cleared));
  if (cleared.roadLayerLoaded) throw new Error('roadLayerLoaded stayed true after Clear');
  if (!cleared.urls.some(u => /World_Transportation/.test(u))) throw new Error('The raster road overlay did not come back after clearing his own road layer');
  if (cleared.labels) throw new Error('Road labels survived Clear');

  if (pageErrors.length) throw new Error('Page errors: ' + JSON.stringify(pageErrors));
  await browser.close();
  console.log('ALL MAP LABEL PLACEMENT TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e.message || e); process.exit(1); });

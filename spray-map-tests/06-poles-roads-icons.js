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
  let lastDialogMessage = null;
  page.on('dialog', async (dialog) => { lastDialogMessage = dialog.message(); await dialog.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  // Test paddock covers lon 116.00-116.02, lat -30.90 to -30.88 (matches the
  // fixture pole/road coordinates built alongside this test).
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([{ id:'F__P1', name:'Test Paddock', farm:'F', area_ha:44.0, exterior:rect(116.00,-30.90,116.02,-30.88), interior:[] }]);
  });
  await page.waitForTimeout(300);

  // ============ POWER POLES ============

  // --- Test 1: a CSV with NO lat/lon columns (Mike's real PowerPoles.csv
  // shape) must be rejected with a clear, actionable message, not silently
  // do nothing. ---
  lastDialogMessage = null;
  await page.setInputFiles('#poleInput', fixture('poles_no_coords.csv'));
  await page.waitForTimeout(300);
  const noCoordsAlert = lastDialogMessage;
  console.log('no-coords CSV alert:', noCoordsAlert);
  if (!noCoordsAlert || !/latitude|longitude|coordinates/i.test(noCoordsAlert)) throw new Error('Expected a clear "no coordinates" error for an attribute-only CSV, got: ' + noCoordsAlert);
  const poleCountAfterBadCsv = await page.evaluate(() => polePoints.length);
  if (poleCountAfterBadCsv !== 0) throw new Error('Expected zero poles loaded from a coordinate-less CSV, got ' + poleCountAfterBadCsv);

  // --- Test 2: a CSV WITH lat/lon columns loads and clips to the farm buffer. ---
  await page.setInputFiles('#poleInput', fixture('poles_with_coords.csv'));
  await page.waitForTimeout(300);
  const poleCsvResult = await page.evaluate(() => ({ count: polePoints.length, meta: poleMeta }));
  console.log('poles from CSV with coords:', JSON.stringify(poleCsvResult));
  if (poleCsvResult.count !== 3) throw new Error('Expected 3 of 4 poles to fall within the buffer (one fixture point is far away), got ' + poleCsvResult.count);

  // --- Test 3: a Point shapefile .zip also loads correctly (same buffer clip). ---
  await page.evaluate(() => { polePoints=[]; poleMeta=null; poleRawBuffer=null; poleRawText=null; poleFileKind=null; });
  await page.setInputFiles('#poleInput', fixture('PowerPoles_test.zip'));
  await page.waitForTimeout(400);
  const poleZipResult = await page.evaluate(() => ({ count: polePoints.length, meta: poleMeta }));
  console.log('poles from Point shapefile zip:', JSON.stringify(poleZipResult));
  if (poleZipResult.count !== 3) throw new Error('Expected 3 of 4 poles to fall within the buffer from the Point shapefile, got ' + poleZipResult.count);

  // --- Test 4: poles render on the edit map with the custom pole icon markup. ---
  const poleMarkerCheck = await page.evaluate(() => {
    const markers = [...document.querySelectorAll('#editMap .leaflet-marker-icon')];
    return markers.some(m => m.innerHTML.includes('powerpole') === false && m.querySelector && m.innerHTML.includes('svg'));
  });
  const poleIconPresent = await page.evaluate(() => document.querySelector('#editMap')?.innerHTML.includes('#5b3a1a') || false);
  console.log('pole icon rendered on map:', poleIconPresent);
  if (!poleIconPresent) throw new Error('Expected the custom pole icon (brown pole colour #5b3a1a) to render on the edit map');

  // ============ ROADS & CROSSROADS ============

  await page.setInputFiles('#roadInput', fixture('Road_Network_test.zip'));
  await page.waitForTimeout(400);
  const roadResult = await page.evaluate(() => ({
    count: roadFeatures.length,
    names: roadFeatures.map(f => f.name),
    meta: roadMeta,
  }));
  console.log('roads loaded:', JSON.stringify(roadResult));
  if (roadResult.count !== 2) throw new Error('Expected 2 of 3 road features to fall within the buffer (one fixture road is far away), got ' + roadResult.count);
  if (!roadResult.names.includes('Bindoon-Moora Road') || !roadResult.names.includes('Yarawindah Road')) {
    throw new Error('Expected road names to be read from the .dbf attribute table, got: ' + JSON.stringify(roadResult.names));
  }

  // --- Test 5: crossroad detection finds where the two named roads cross. ---
  const crossroads = await page.evaluate(() => computeRoadCrossroads(roadFeatures));
  console.log('crossroads detected:', JSON.stringify(crossroads));
  if (crossroads.length !== 1) throw new Error('Expected exactly 1 crossroad between the two crossing test roads, got ' + crossroads.length);
  const namesAtCrossroad = crossroads[0].names.slice().sort();
  if (namesAtCrossroad.join('|') !== 'Bindoon-Moora Road|Yarawindah Road') throw new Error('Crossroad did not carry both road names: ' + JSON.stringify(namesAtCrossroad));

  // --- Test 6: road name labels render on the edit map. ---
  const roadLabelCheck = await page.evaluate(() => document.querySelector('#editMap').innerHTML.includes('Bindoon-Moora Road'));
  if (!roadLabelCheck) throw new Error('Expected the road name label to render on the edit map');

  // ============ KML/KMZ: custom icons, poles, roads, crossroads, airstrip marker ============

  // Add a hazard, and an airstrip line, so the KML export has something to
  // carry custom icons and a direction marker for.
  await page.evaluate(() => {
    state.hazards.push({ id: 'hz1', type: 'windmill', lat: -30.895, lng: 116.01, note: '' });
    state.lines.push({ id: 'ln1', type: 'airstrip', points: [[-30.895, 116.015], [-30.885, 116.015]], meta: { label: 'N-S, 15m x 800m' } });
    saveState();
  });
  await page.waitForTimeout(200);

  const icons = await page.evaluate(() => buildKmlIconCache());
  console.log('icon cache keys:', Object.keys(icons), 'windmill icon present:', !!icons.windmill, 'powerpole icon present:', !!icons.powerpole);
  if (!icons.windmill || !icons.windmill.startsWith('data:image/png')) throw new Error('Expected a rasterised PNG data URI for the windmill icon');
  if (!icons.powerpole) throw new Error('Expected a rasterised PNG data URI for the power pole icon');
  if (!icons.airstrip_arrow) throw new Error('Expected a rasterised PNG data URI for the airstrip arrow icon');

  const kmlInline = await page.evaluate(async () => { const ic = await buildKmlIconCache(); return buildKML(ic, false); });
  console.log('inline KML length:', kmlInline.length);
  if (!kmlInline.includes('data:image/png;base64,')) throw new Error('Expected inline (non-KMZ) KML to embed icons as data URIs');
  if (!kmlInline.includes('Power Pole')) throw new Error('Expected power pole placemarks in the KML');
  if (!kmlInline.includes('Bindoon-Moora Road') || !kmlInline.includes('Yarawindah Road')) throw new Error('Expected named road placemarks in the KML');
  if (!kmlInline.includes('Crossroad')) throw new Error('Expected a crossroad placemark in the KML');
  if (!kmlInline.includes('<heading>')) throw new Error('Expected a heading-rotated airstrip direction marker in the KML');
  if (!kmlInline.includes('N-S, 15m x 800m')) throw new Error('Expected the airstrip direction/width/length note to appear as a visible placemark name');
  const style_hazard_windmill_count = (kmlInline.match(/style_hazard_windmill/g) || []).length;
  if (style_hazard_windmill_count < 2) throw new Error('Expected a per-type hazard style (style_hazard_windmill) referenced by both the Style block and the placemark');

  const kmzCheck = await page.evaluate(async () => {
    const ic = await buildKmlIconCache();
    const kml = buildKML(ic, true);
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    const iconsFolder = zip.folder('icons');
    KML_ICON_TYPES.forEach(type => { if (ic[type]) iconsFolder.file(type + '.png', dataUriToUint8Array(ic[type])); });
    const fileNames = Object.keys(zip.files);
    return { fileNames, kmlHasRelativeHref: kml.includes('icons/windmill.png'), kmlHasDataUri: kml.includes('data:image') };
  });
  console.log('KMZ bundling check:', JSON.stringify(kmzCheck));
  if (!kmzCheck.fileNames.some(f => f === 'icons/windmill.png')) throw new Error('Expected icons/windmill.png bundled inside the KMZ, got: ' + JSON.stringify(kmzCheck.fileNames));
  if (!kmzCheck.kmlHasRelativeHref) throw new Error('Expected the KMZ-mode KML to reference icons by relative path, not a data URI');
  if (kmzCheck.kmlHasDataUri) throw new Error('KMZ-mode KML should not also embed data URIs once icons are bundled as files');

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-8 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

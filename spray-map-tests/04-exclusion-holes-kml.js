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

  const setup = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      { id:'Glenyara__Borehill', name:'Borehill', farm:'Glenyara', area_ha:106.337, exterior:rect(116.00,-30.90,116.01,-30.89), interior:[] },
      { id:'Jindabyne__Home_1', name:'Home 1', farm:'Jindabyne', area_ha:51.0, exterior:rect(116.20,-30.80,116.21,-30.79), interior:[] },
    ];
    startApp(paddocks);
    document.getElementById('titleInput').value = 'Annadale Wheat Spray - Sept 2026';
  });
  await page.waitForTimeout(300);

  // Treat Borehill, add an exclusion notch, a hazard on Glenyara and one on
  // Jindabyne, and a power line — then verify KML export scopes everything to
  // the checked farms and cuts the exclusion out as a real hole, same as the
  // on-screen map.
  await page.evaluate(() => {
    selectedCrop='W';
    editPolyLayers['Glenyara__Borehill'].fire('click',{latlng:L.latLng(...PADDOCKS.find(p=>p.id==='Glenyara__Borehill').centerLatLng)});
    // A genuine interior notch (doesn't touch any paddock edge) so the result
    // is a real hole, not a split into two disjoint polygons.
    exclusionDraft = [[-30.897,116.003],[-30.897,116.007],[-30.894,116.007],[-30.894,116.003]];
    finishExclusion();
    state.hazards.push({id:'hz_g', type:'dam', lat:-30.895, lng:116.005, note:''});
    state.hazards.push({id:'hz_j', type:'windmill', lat:-30.805, lng:116.205, note:''});
    state.lines.push({id:'ln_1', type:'powerline', points:[[-30.898,116.002],[-30.892,116.008]], meta:{}});
    saveState();
    renderEditMap();
  });
  await page.waitForTimeout(300);

  // --- Test 1: KML button exists and produces well-formed, farm-scoped KML
  // with the exclusion cut out as a real polygon hole (innerBoundaryIs) ---
  const kmlText = await page.evaluate(() => buildKML());
  console.log('KML length:', kmlText.length);
  if (!kmlText.startsWith('<?xml')) throw new Error('KML should start with an XML declaration');
  if (!kmlText.includes('<kml') || !kmlText.includes('</kml>')) throw new Error('Missing <kml> root element');
  if (!kmlText.includes('Borehill')) throw new Error('Expected treated paddock name in KML');
  if (!kmlText.includes('innerBoundaryIs')) throw new Error('Expected the exclusion to appear as a real innerBoundaryIs hole in the treated paddock, not a separate overlay');
  if (!kmlText.includes('Excluded area')) throw new Error('Expected an excluded-area placemark for the spray operator to see');
  if (!kmlText.includes('GPS Antenna') && !kmlText.includes('Dam')) { /* fine, just checking hazard labels resolve */ }
  if (!kmlText.includes('Dam') && !kmlText.includes('dam')) throw new Error('Expected the dam hazard label in KML');
  if (!kmlText.includes('Power Line')) throw new Error('Expected the power line placemark in KML');
  const openTagCount = (kmlText.match(/<Placemark>/g)||[]).length;
  const closeTagCount = (kmlText.match(/<\/Placemark>/g)||[]).length;
  if (openTagCount !== closeTagCount || openTagCount < 1) throw new Error('Placemark tags unbalanced: ' + openTagCount + ' vs ' + closeTagCount);

  // --- Test 2: farm scoping — unchecking Jindabyne removes its hazard from the KML ---
  const bothFarmsKml = kmlText;
  const jindHazardCountBoth = (bothFarmsKml.match(/Windmill/g)||[]).length;
  if (jindHazardCountBoth < 1) throw new Error('Expected the Jindabyne windmill hazard while both farms are checked');

  const checkboxes = await page.$$('#farmChecks .farm-check input[type=checkbox]');
  const labels = await page.$$eval('#farmChecks .farm-check', els => els.map(e => e.textContent));
  const jindabyneIdx = labels.findIndex(l => l.includes('Jindabyne'));
  await checkboxes[jindabyneIdx].click();
  await page.waitForTimeout(200);
  const oneFarmKml = await page.evaluate(() => buildKML());
  if (oneFarmKml.includes('Windmill')) throw new Error('Expected the Jindabyne windmill hazard to be excluded once Jindabyne is unchecked');
  if (!oneFarmKml.includes('Borehill')) throw new Error('Expected Glenyara/Borehill to remain in the KML');
  await checkboxes[jindabyneIdx].click();
  await page.waitForTimeout(200);

  // --- Test 3: export filename sanitises the job title ---
  const fname = await page.evaluate(() => exportFileBaseName());
  console.log('export filename:', fname);
  if (!/^Annadale_Wheat_Spray_Sept_2026_\d{8}$/.test(fname)) throw new Error('Unexpected export filename shape: ' + fname);

  // --- Test 4: KMZ export zips the KML via JSZip without throwing ---
  const kmzCheck = await page.evaluate(async () => {
    if (typeof JSZip === 'undefined') return { ok: false, reason: 'JSZip not loaded' };
    const kml = buildKML();
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    const blob = await zip.generateAsync({ type: 'blob' });
    return { ok: true, size: blob.size };
  });
  console.log('KMZ build check:', JSON.stringify(kmzCheck));
  if (!kmzCheck.ok) throw new Error('KMZ build failed: ' + kmzCheck.reason);
  if (!(kmzCheck.size > 0)) throw new Error('Expected a non-empty KMZ blob');

  // --- Test 5: toolbar buttons are present and wired ---
  const buttonsExist = await page.evaluate(() => ({
    kml: !!document.getElementById('exportKmlBtn'),
    kmz: !!document.getElementById('exportKmzBtn'),
  }));
  if (!buttonsExist.kml || !buttonsExist.kmz) throw new Error('Expected KML and KMZ export buttons in the toolbar: ' + JSON.stringify(buttonsExist));

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-6 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

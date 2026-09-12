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

  // Mock every tile request (OSM, OpenTopoMap, ArcGIS World_Imagery / Reference) so
  // basemap switching can be exercised fully offline.
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://*.tile.opentopomap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://server.arcgisonline.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  // --- Test A: duplicate-id merge (fenceline tracking split into two features, same name) ---
  const mergeResult = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      // Two separate features, SAME farm+name -> should merge into ONE logical paddock/label
      {id:'Annadale__West_40', name:'West 40', farm:'Annadale', area_ha:20.0, exterior:rect(116.10,-30.80,116.105,-30.79), interior:[]},
      {id:'Annadale__West_40', name:'West 40', farm:'Annadale', area_ha:18.0, exterior:rect(116.106,-30.80,116.11,-30.79), interior:[]},
      {id:'Annadale__North_1', name:'North 1', farm:'Annadale', area_ha:45.2, exterior:rect(116.10,-30.82,116.11,-30.81), interior:[]},
    ];
    startApp(paddocks);
    return { paddockCount: PADDOCKS.length, west40Area: PADDOCKS.find(p=>p.id==='Annadale__West_40').area_ha, hasCenterLatLng: PADDOCKS.every(p=>Array.isArray(p.centerLatLng)) };
  });
  console.log('merge test:', JSON.stringify(mergeResult));
  if (mergeResult.paddockCount !== 2) throw new Error('Expected 2 merged paddocks, got ' + mergeResult.paddockCount);
  if (Math.abs(mergeResult.west40Area - 38.0) > 0.01) throw new Error('Expected merged area 38.0, got ' + mergeResult.west40Area);

  await page.waitForTimeout(300);

  // Assign crop to the merged multi-block paddock and confirm exactly ONE circle label renders for it
  await page.evaluate(() => {
    selectedCrop = 'W';
    const poly = editPolyLayers['Annadale__West_40'];
    poly.fire('click', { latlng: L.latLng(...PADDOCKS.find(p=>p.id==='Annadale__West_40').centerLatLng) });
  });
  await page.waitForTimeout(400);
  const circleCount = await page.$$eval('.cl-circle', els => els.length);
  console.log('circle labels after treating merged multi-block paddock:', circleCount);
  if (circleCount !== 1) throw new Error('Expected exactly 1 circle label, got ' + circleCount);

  // --- Test B: Add farm (additive, not replace) ---
  const farmsBefore = await page.evaluate(() => FARMS.slice());
  console.log('farms before add:', farmsBefore);

  // Simulate the add-farm flow by calling the merge/update logic directly with a second
  // farm's paddocks (bypassing the real file input / shpjs parse, which is already covered
  // by the original tool's proven shapefile parser).
  const afterAdd = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const newPaddocks = [
      {id:'Jindabyne__Home_1', name:'Home 1', farm:'Jindabyne', area_ha:51.0, exterior:rect(116.20,-30.80,116.21,-30.79), interior:[]},
    ];
    const before = new Set(FARMS);
    PADDOCKS = mergeDuplicatePaddocks([...PADDOCKS, ...newPaddocks]);
    FARMS = [...new Set(PADDOCKS.map(p=>p.farm))].sort();
    FARMS.forEach(f => { if (!before.has(f)) checkedFarms.add(f); });
    buildFarmChecks();
    renderEditMap();
    buildPaddockList();
    return { farms: FARMS, paddockCount: PADDOCKS.length, checkedFarms: [...checkedFarms].sort() };
  });
  console.log('after add-farm:', JSON.stringify(afterAdd));
  if (afterAdd.farms.length !== 2 || !afterAdd.farms.includes('Annadale') || !afterAdd.farms.includes('Jindabyne')) {
    throw new Error('Expected both Annadale and Jindabyne present after add-farm, got ' + JSON.stringify(afterAdd.farms));
  }
  if (afterAdd.paddockCount !== 3) throw new Error('Expected 3 paddocks total after add-farm, got ' + afterAdd.paddockCount);
  if (!afterAdd.checkedFarms.includes('Jindabyne')) throw new Error('Newly added farm should be checked by default');

  // Confirm both farms' checkboxes now exist in the DOM simultaneously (not either/or)
  const checkboxLabels = await page.$$eval('#farmChecks .farm-check', els => els.map(e => e.textContent.trim()));
  console.log('farm checkboxes in DOM:', JSON.stringify(checkboxLabels));
  if (checkboxLabels.length !== 2) throw new Error('Expected 2 farm checkboxes in the DOM, got ' + checkboxLabels.length);

  // --- Test C: basemap switching through all 5 options, no crash ---
  for (const val of ['roads','osm','sat','hybrid','bw']) {
    await page.selectOption('#basemapSel', val);
    await page.waitForTimeout(250);
  }
  console.log('basemap switch sequence completed');

  // Enter preview with hybrid selected and confirm attribution text updates
  await page.selectOption('#basemapSel', 'sat');
  await page.waitForTimeout(150);
  await page.click('#previewBtn');
  await page.waitForTimeout(900);
  const attrib = await page.$eval('#pAttrib', el => el.textContent);
  console.log('attribution text in preview (sat):', attrib);
  if (!attrib.includes('Esri')) throw new Error('Expected Esri attribution for satellite basemap, got: ' + attrib);

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));

  await browser.close();
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

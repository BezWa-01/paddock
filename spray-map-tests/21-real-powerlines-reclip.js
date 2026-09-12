const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

const REAL_SHP = dataFile('DistributionOverheadPowerlinesWP_031.shp', 'the Western Power overhead powerline shapefile (~26MB)');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', async (dialog) => { console.log('DIALOG:', dialog.type(), '-', dialog.message().slice(0,150)); await dialog.accept(); });
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://*.tile.opentopomap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://server.arcgisonline.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  // Two farms; Glenyara/Borehill-style setup: a paddock with a bush-block-sized
  // northern strip we'll exclude, plus a paddock with a duplicate boundary
  // (double-entry) to exercise the boundary-part delete feature.
  const setup = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      { id:'Glenyara__Borehill', name:'Borehill', farm:'Glenyara', area_ha:106.337, exterior:rect(116.00,-30.90,116.01,-30.89), interior:[] },
      // duplicate-boundary paddock: same id/name/farm submitted twice (simulates the round-2 merge-by-id case with an erroneous extra ring)
      { id:'Glenyara__Dup1', name:'Dup Paddock', farm:'Glenyara', area_ha:20.0, exterior:rect(116.10,-30.90,116.12,-30.89), interior:[] },
      { id:'Glenyara__Dup1', name:'Dup Paddock', farm:'Glenyara', area_ha:5.0, exterior:rect(116.121,-30.90,116.125,-30.89), interior:[] },
      { id:'Jindabyne__Home_1', name:'Home 1', farm:'Jindabyne', area_ha:51.0, exterior:rect(116.20,-30.80,116.21,-30.79), interior:[] },
    ];
    startApp(paddocks);
    return { paddockCount: PADDOCKS.length, dupExtRings: PADDOCKS.find(p=>p.id==='Glenyara__Dup1').exterior.length };
  });
  console.log('setup:', JSON.stringify(setup));
  if (setup.paddockCount !== 3) throw new Error('Expected 3 logical paddocks (2 merged into 1), got ' + setup.paddockCount);
  if (setup.dupExtRings !== 2) throw new Error('Expected the duplicate paddock to retain 2 exterior rings pre-fix, got ' + setup.dupExtRings);
  await page.waitForTimeout(400);

  // Treat Borehill with Wheat.
  await page.evaluate(() => {
    selectedCrop='W';
    const poly=editPolyLayers['Glenyara__Borehill'];
    poly.fire('click',{latlng:L.latLng(...PADDOCKS.find(p=>p.id==='Glenyara__Borehill').centerLatLng)});
  });
  await page.waitForTimeout(200);

  // --- Test: exclusion ("lasso") zone inside Borehill, area subtracted from totals ---
  const beforeExcl = await page.evaluate(() => {
    const bar=document.getElementById('summaryBar').textContent;
    return { treatedTag: bar };
  });
  console.log('summary before exclusion:', beforeExcl.treatedTag);

  const exclResult = await page.evaluate(() => {
    // Northern strip of Borehill (rect spans 116.00-116.01 lon, -30.90..-30.89 lat) -
    // draw an exclusion right along the northern edge, closest to "Yarawindah Road".
    exclusionDraft = [
      [-30.891,116.000],[-30.891,116.010],[-30.890,116.010],[-30.890,116.000]
    ];
    finishExclusion();
    return {
      exclusions: state.exclusions.map(e=>({id:e.id, area_ha:e.area_ha, paddockIds:e.paddockIds})),
      effArea: effectiveArea(PADDOCKS.find(p=>p.id==='Glenyara__Borehill')),
      grossArea: PADDOCKS.find(p=>p.id==='Glenyara__Borehill').area_ha,
    };
  });
  console.log('exclusion result:', JSON.stringify(exclResult));
  if (exclResult.exclusions.length !== 1) throw new Error('Expected exactly 1 exclusion recorded, got ' + exclResult.exclusions.length);
  if (!exclResult.exclusions[0].paddockIds.includes('Glenyara__Borehill')) throw new Error('Expected exclusion to be associated with Borehill paddock');
  if (Math.abs(exclResult.exclusions[0].area_ha - 10.634) > 0.05) throw new Error('Expected exclusion area ~10.63ha, got ' + exclResult.exclusions[0].area_ha);
  if (exclResult.effArea >= exclResult.grossArea) throw new Error('Expected effective area to be reduced below gross area after exclusion, got eff=' + exclResult.effArea + ' gross=' + exclResult.grossArea);
  if (Math.abs(exclResult.effArea - (exclResult.grossArea - 10.634)) > 0.05) throw new Error('Expected effective area = gross - exclusion, got eff=' + exclResult.effArea + ' gross=' + exclResult.grossArea);

  await page.waitForTimeout(300);
  const summaryAfterExcl = await page.$eval('#summaryBar', el => el.textContent);
  console.log('summary after exclusion:', summaryAfterExcl);
  if (!summaryAfterExcl.includes('EXCLUDED')) throw new Error('Expected an EXCLUDED tag in the summary bar after drawing an exclusion');

  const exclPolyCount = await page.$$eval('#editMap svg path', els => els.length);
  console.log('svg path count on edit map (incl. exclusion polygon):', exclPolyCount);

  // Legend should mention the excluded area once in preview.
  await page.click('#previewBtn');
  await page.waitForTimeout(700);
  const legendHtml = await page.$eval('#pLegend', el => el.innerHTML);
  if (!legendHtml.includes('Not treated')) throw new Error('Expected excluded-area legend line in preview');
  console.log('legend mentions excluded area: true');
  await page.click('#backBtn');
  await page.waitForTimeout(200);

  // Delete the exclusion and confirm totals are restored.
  const afterDelete = await page.evaluate(() => {
    const id = state.exclusions[0].id;
    window.__deleteExclusion(id);
    return { exclusions: state.exclusions.length, effArea: effectiveArea(PADDOCKS.find(p=>p.id==='Glenyara__Borehill')) };
  });
  console.log('after deleting exclusion:', JSON.stringify(afterDelete));
  if (afterDelete.exclusions !== 0) throw new Error('Expected 0 exclusions after delete');
  if (Math.abs(afterDelete.effArea - 106.337) > 0.01) throw new Error('Expected effective area restored to 106.337 after deleting exclusion, got ' + afterDelete.effArea);

  // --- Test: boundary-part delete on the duplicate-boundary paddock ---
  await page.evaluate(() => { document.getElementById('paddockListBtn').click(); });
  await page.waitForTimeout(200);
  const warnText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#paddockListBody div')];
    const warn = rows.find(r => r.textContent.includes('boundary parts'));
    return warn ? warn.textContent : null;
  });
  console.log('boundary-parts warning text:', warnText);
  if (!warnText || !warnText.includes('2 boundary parts')) throw new Error('Expected a "2 boundary parts" warning for the duplicate paddock, got: ' + warnText);

  // deleteBoundaryPart recomputes area_ha from the *actual remaining ring
  // geometry* (not the old additive area_ha total) — correct behaviour, since
  // the whole point is to fix a boundary that was wrong in the first place.
  // Ring 0 here geodesically covers ~212.67ha, ring 1 (the erroneous extra
  // entry we're deleting) ~42.53ha, summing to the ~255ha the paddock
  // wrongly carried with both rings present.
  const boundaryDeleteResult = await page.evaluate(() => {
    const before = PADDOCKS.find(p=>p.id==='Glenyara__Dup1');
    const ringsBefore = before.exterior.length;
    deleteBoundaryPart('Glenyara__Dup1', 1);
    const p = PADDOCKS.find(pp=>pp.id==='Glenyara__Dup1');
    return { ringsBefore, ringsAfter: p.exterior.length, areaAfter: p.area_ha };
  });
  console.log('boundary part delete result:', JSON.stringify(boundaryDeleteResult));
  if (boundaryDeleteResult.ringsBefore !== 2) throw new Error('Expected 2 exterior rings before delete, got ' + boundaryDeleteResult.ringsBefore);
  if (boundaryDeleteResult.ringsAfter !== 1) throw new Error('Expected 1 exterior ring remaining after deleting a boundary part, got ' + boundaryDeleteResult.ringsAfter);
  if (Math.abs(boundaryDeleteResult.areaAfter - 212.67) > 0.5) throw new Error('Expected recomputed area ~212.67ha (ring 0 only) after deleting the erroneous ring, got ' + boundaryDeleteResult.areaAfter);

  // --- Test: delete individual paddock ---
  const beforePaddockDelete = await page.evaluate(() => PADDOCKS.length);
  await page.evaluate(() => deletePaddock('Jindabyne__Home_1'));
  await page.waitForTimeout(200);
  const afterPaddockDelete = await page.evaluate(() => ({ count: PADDOCKS.length, farms: FARMS, stillHasRow: !!document.getElementById('plrow_Jindabyne__Home_1') }));
  console.log('after paddock delete:', JSON.stringify(afterPaddockDelete));
  if (afterPaddockDelete.count !== beforePaddockDelete - 1) throw new Error('Expected paddock count to drop by 1');
  if (afterPaddockDelete.farms.includes('Jindabyne')) throw new Error('Expected Jindabyne farm to disappear once its only paddock was deleted');
  if (afterPaddockDelete.stillHasRow) throw new Error('Expected the deleted paddock\'s row to be gone from the paddock list panel');

  // --- Test: delete individual farm (Glenyara, its remaining 2 paddocks) ---
  const beforeFarmDelete = await page.evaluate(() => PADDOCKS.length);
  await page.evaluate(() => deleteFarm('Glenyara'));
  await page.waitForTimeout(200);
  const afterFarmDelete = await page.evaluate(() => ({ count: PADDOCKS.length, farms: FARMS }));
  console.log('after farm delete:', JSON.stringify(afterFarmDelete));
  if (afterFarmDelete.count !== 0) throw new Error('Expected all paddocks gone after deleting the only remaining farm, got ' + afterFarmDelete.count);
  if (afterFarmDelete.farms.length !== 0) throw new Error('Expected FARMS to be empty, got ' + JSON.stringify(afterFarmDelete.farms));

  // --- Test: gisStatusMessage cap wording ---
  const capMsg = await page.evaluate(() => gisStatusMessage({matched:2000,totalRecords:5000},2,'test.shp'));
  console.log('cap message:', capMsg);
  if (!capMsg.includes('hidden above 1500')) throw new Error('Expected mark-cap wording in status message for a large matched count');

  // --- Test: auto re-clip on farm-selection change (no re-upload) using the REAL shapefile ---
  const reclipSetup = await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      { id:'Annadale__North_1', name:'North 1', farm:'Annadale', area_ha:45.2, exterior:rect(116.02,-30.87,116.05,-30.85), interior:[] },
      { id:'Annadale__South_1', name:'South 1', farm:'Annadale', area_ha:38.4, exterior:rect(116.03,-30.90,116.06,-30.88), interior:[] },
    ];
    startApp(paddocks);
  });
  await page.waitForTimeout(300);
  await page.setInputFiles('#powerlineInput', REAL_SHP);
  await page.waitForTimeout(1500);
  const metaBefore = await page.evaluate(() => gisPowerlineMeta);
  console.log('meta before farm toggle:', JSON.stringify(metaBefore));
  if (!metaBefore || metaBefore.matched < 1) throw new Error('Expected the real shapefile to match at least one line before testing reclip');

  // Uncheck a farm via the actual checkbox (not JS) to exercise the real UI path, then re-check it.
  const cb = await page.$('#farmChecks .farm-check input[type=checkbox]');
  await cb.click();
  await page.waitForTimeout(600); // reclipPowerlines() is async
  const metaAfterUncheck = await page.evaluate(() => gisPowerlineMeta);
  console.log('meta after unchecking a farm (auto-reclip, no re-upload):', JSON.stringify(metaAfterUncheck));
  if (!metaAfterUncheck) throw new Error('Expected gisPowerlineMeta to still be populated after auto-reclip');
  await cb.click();
  await page.waitForTimeout(600);
  const metaAfterRecheck = await page.evaluate(() => gisPowerlineMeta);
  console.log('meta after re-checking farm:', JSON.stringify(metaAfterRecheck));

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));
  if (pageErrors.length) throw new Error('Page errors occurred: ' + JSON.stringify(pageErrors));

  await browser.close();
  console.log('ALL ROUND-4 TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

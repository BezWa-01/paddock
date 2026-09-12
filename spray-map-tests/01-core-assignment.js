const { chromium } = require('playwright');
const { appUrl, fixture, dataFile, haveCommand, FAKE_TILE } = require('./harness');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const filePath = appUrl();
  await page.route('**/*.{png,jpg}', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080200000090771530000000a49444154789c6360000002000100' , 'hex') }));
  await page.goto(filePath);
  await page.waitForTimeout(500);

  // Inject synthetic paddock data (2 farms, 5 paddocks) and start the app directly,
  // bypassing the shapefile zip parsing (already proven to work in the source tool).
  const result = await page.evaluate(() => {
    function rect(lon0, lat0, lon1, lat1) {
      return [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
    }
    const paddocks = [
      { id: 'Annadale__North_1', name: 'North 1', farm: 'Annadale', area_ha: 45.2, exterior: rect(116.10,-30.80,116.11,-30.79), interior: [] },
      { id: 'Annadale__North_2', name: 'North 2', farm: 'Annadale', area_ha: 62.8, exterior: rect(116.11,-30.80,116.12,-30.79), interior: [] },
      { id: 'Annadale__South_1', name: 'South 1', farm: 'Annadale', area_ha: 38.4, exterior: rect(116.10,-30.82,116.11,-30.81), interior: [] },
      { id: 'Jindabyne__Home_1', name: 'Home 1', farm: 'Jindabyne', area_ha: 51.0, exterior: rect(116.20,-30.80,116.21,-30.79), interior: [] },
      { id: 'Jindabyne__Home_2', name: 'Home 2', farm: 'Jindabyne', area_ha: 29.6, exterior: rect(116.21,-30.80,116.22,-30.79), interior: [] },
    ];
    startApp(paddocks);
    return { farms: FARMS, paddockCount: PADDOCKS.length };
  });
  console.log('startApp result:', JSON.stringify(result));

  await page.waitForTimeout(400);

  // --- Test 1: assign a crop to a paddock via the paddock-list panel (avoids needing exact pixel picking) ---
  await page.click('#paddockListBtn');
  await page.waitForTimeout(150);
  const rowSelect = await page.$('#plrow_Annadale__North_1 select');
  if (!rowSelect) throw new Error('Paddock list row not found for Annadale__North_1');
  await rowSelect.selectOption('W');
  await page.waitForTimeout(150);

  const afterTreatment = await page.evaluate(() => window.__test_state ? null : null);
  const treatmentCheck = await page.evaluate(() => {
    // state is not exposed globally by name 'state' outside module scope? it's declared with `let` at top-level script -> becomes a global (non-strict, var-like for let at top level of classic script is NOT on window).
    // Use a debug hook instead.
    return typeof state !== 'undefined' ? state.treatment : 'NO_ACCESS';
  });
  console.log('treatment after list assign:', JSON.stringify(treatmentCheck));

  // --- Test 2: click a second crop chip then click directly on the map for another paddock ---
  await page.click('#paddockListBtn'); // close panel
  // Select Canola chip
  const chips = await page.$$('#palette .chip');
  let canolaChip = null;
  for (const c of chips) {
    const txt = await c.textContent();
    if (txt.includes('Canola')) { canolaChip = c; break; }
  }
  if (!canolaChip) throw new Error('Canola chip not found');
  await canolaChip.click();
  const selectedCropVal = await page.evaluate(() => selectedCrop);
  console.log('selectedCrop after chip click:', selectedCropVal);

  // Compute the exact on-screen pixel for a specific paddock's centre (Jindabyne__Home_1)
  // so the click lands on that polygon, rather than guessing the map's viewport centre
  // (which can fall in the gap between two separated farm clusters after fitBounds).
  const mapBox = await page.$eval('#editMap', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const targetPx = await page.evaluate(() => {
    const poly = editPolyLayers['Jindabyne__Home_1'];
    const c = poly.getBounds().getCenter();
    const p = editMap.latLngToContainerPoint(c);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(mapBox.x + targetPx.x, mapBox.y + targetPx.y);
  await page.waitForTimeout(200);

  const treatmentCheck2 = await page.evaluate(() => state.treatment);
  console.log('treatment after map click:', JSON.stringify(treatmentCheck2));

  // helper: re-query a hazard/line button fresh each time (buildHazardBar() replaces the DOM)
  async function findHazardBtn(labelSubstr) {
    const btns = await page.$$('#hazardBtns .hz-btn');
    for (const b of btns) {
      const txt = await b.textContent();
      if (txt.includes(labelSubstr)) return b;
    }
    return null;
  }

  // --- Test 3: hazard placement ---
  let windmillBtn = await findHazardBtn('Windmill');
  if (!windmillBtn) throw new Error('Windmill hazard button not found');
  await windmillBtn.click();
  const armedCheck = await page.evaluate(() => armedHazard);
  console.log('armedHazard after windmill click:', armedCheck);
  await page.mouse.click(mapBox.x + 300, mapBox.y + 300);
  await page.waitForTimeout(200);
  const hazardsCheck = await page.evaluate(() => state.hazards.map(h => h.type));
  console.log('hazards after placement:', JSON.stringify(hazardsCheck));

  // De-arm hazard mode (re-query button since buildHazardBar() rebuilt the DOM)
  windmillBtn = await findHazardBtn('Windmill');
  await windmillBtn.click();

  // --- Test 4: power line drawing (2 points then finish) ---
  const plBtn = await findHazardBtn('Power Line');
  if (!plBtn) throw new Error('Power line button not found');
  await plBtn.click();
  await page.mouse.click(mapBox.x + 60, mapBox.y + 60);
  await page.waitForTimeout(100);
  await page.mouse.click(mapBox.x + 200, mapBox.y + 160);
  await page.waitForTimeout(100);
  const lcVisible = await page.isVisible('#lineControls');
  console.log('line controls visible after 2 points:', lcVisible);
  await page.click('#lineControls .lc-finish');
  await page.waitForTimeout(200);
  const linesCheck = await page.evaluate(() => state.lines.map(l => l.type));
  console.log('lines after finish:', JSON.stringify(linesCheck));

  // --- Test 5: comments ---
  await page.fill('#commentsInput', 'Test note for contractor');
  await page.waitForTimeout(100);
  const commentsCheck = await page.evaluate(() => state.comments);
  console.log('comments saved:', JSON.stringify(commentsCheck));

  // --- Test 6: enter preview mode, check no crash, check legend populated ---
  await page.click('#previewBtn');
  await page.waitForTimeout(900);
  const legendHtml = await page.$eval('#pLegend', el => el.innerHTML.length);
  const pTotalsText = await page.$eval('#pTotals', el => el.textContent);
  const pCommentsText = await page.$eval('#pComments', el => el.textContent);
  console.log('legend html length:', legendHtml);
  console.log('pTotals text:', pTotalsText);
  console.log('pComments text:', pCommentsText);

  // Check preview map actually rendered some SVG paths (polygons)
  const svgPathCount = await page.$$eval('#previewMap svg path', els => els.length);
  console.log('preview map svg path count:', svgPathCount);

  // back to edit
  await page.click('#backBtn');
  await page.waitForTimeout(300);

  console.log('--- CONSOLE ERRORS ---');
  console.log(JSON.stringify(consoleErrors, null, 2));
  console.log('--- PAGE ERRORS ---');
  console.log(JSON.stringify(pageErrors, null, 2));

  await browser.close();
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

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
  await page.route('**://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://*.tile.opentopomap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));
  await page.route('**://server.arcgisonline.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE }));

  page.on('dialog', async (dialog) => {
    console.log('DIALOG:', dialog.type(), '-', dialog.message().slice(0, 200));
    await dialog.accept();
  });

  await page.goto(appUrl());
  await page.waitForTimeout(400);

  // Set up a synthetic Annadale/Jindabyne paddock set positioned in the REAL
  // area the actual shapefile covers (near Koojan, ~116.05E -30.85S), so the
  // real power-line data has something realistic to clip against.
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    const paddocks=[
      { id:'Annadale__North_1', name:'North 1', farm:'Annadale', area_ha:45.2, exterior:rect(116.02,-30.87,116.05,-30.85), interior:[] },
      { id:'Annadale__South_1', name:'South 1', farm:'Annadale', area_ha:38.4, exterior:rect(116.03,-30.90,116.06,-30.88), interior:[] },
    ];
    startApp(paddocks);
  });
  await page.waitForTimeout(400);

  // Set a 2km buffer (default) and load the REAL power-line .shp via the file input.
  await page.setInputFiles('#powerlineInput', REAL_SHP);
  await page.waitForTimeout(1500); // real 26MB parse — generous margin

  const status = await page.$eval('#gisPlStatus', el => el.textContent);
  console.log('GIS status text:', status);

  const meta = await page.evaluate(() => gisPowerlineMeta);
  console.log('gisPowerlineMeta:', JSON.stringify(meta));
  if (!meta || meta.matched < 1) throw new Error('Expected at least one matched power line record from the real file, got: ' + JSON.stringify(meta));
  if (meta.totalRecords < 100000) throw new Error('Expected totalRecords to reflect the full ~206k-record file, got ' + meta.totalRecords);

  const linesLoaded = await page.evaluate(() => gisPowerlines.length);
  console.log('gisPowerlines (rings) loaded:', linesLoaded);

  // Confirm it actually rendered on the edit map (base dashed lines + × marks)
  await page.waitForTimeout(300);
  const polylineCount = await page.$$eval('#editMap svg path', els => els.length);
  const markCount = await page.$$eval('.pl-mark', els => els.length);
  console.log('edit map svg path count (paddocks + powerlines):', polylineCount);
  console.log('pl-mark (×) count on edit map:', markCount);
  if (markCount < 1) throw new Error('Expected at least one × mark rendered for the loaded power lines');

  // Toggle "Show" off and confirm it disappears
  await page.click('#showGisPlChk');
  await page.waitForTimeout(300);
  const markCountAfterHide = await page.$$eval('.pl-mark', els => els.length);
  console.log('pl-mark count after unchecking Show:', markCountAfterHide);
  if (markCountAfterHide !== 0) throw new Error('Expected 0 × marks after hiding the GIS power line layer');

  // Toggle back on, then enter preview and confirm it renders there too + legend shows Power Line
  await page.click('#showGisPlChk');
  await page.waitForTimeout(200);
  await page.click('#previewBtn');
  await page.waitForTimeout(1000);
  const previewMarkCount = await page.$$eval('.pl-mark', els => els.length);
  console.log('pl-mark count in preview:', previewMarkCount);
  const legendHtml = await page.$eval('#pLegend', el => el.innerHTML);
  const legendHasPowerLine = legendHtml.includes('Power Line');
  console.log('legend mentions Power Line:', legendHasPowerLine);
  if (!legendHasPowerLine) throw new Error('Expected "Power Line" in the printed legend when GIS lines are shown');

  // Test Clear button
  await page.click('#backBtn');
  await page.waitForTimeout(200);
  await page.click('#clearPowerlineBtn');
  await page.waitForTimeout(200);
  const afterClear = await page.evaluate(() => gisPowerlines.length);
  console.log('gisPowerlines after Clear:', afterClear);
  if (afterClear !== 0) throw new Error('Expected gisPowerlines to be empty after Clear');

  console.log('--- CONSOLE ERRORS ---', JSON.stringify(consoleErrors));
  console.log('--- PAGE ERRORS ---', JSON.stringify(pageErrors));

  await browser.close();
})().catch(e => { console.error('SMOKETEST FAILED:', e); process.exit(1); });

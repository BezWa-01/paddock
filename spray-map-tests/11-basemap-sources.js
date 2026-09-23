const { chromium } = require('playwright');
const { appUrl, FAKE_TILE } = require('./harness');

/* Round 17 — where the basemap tiles come from.

   Mike opened the map and got OpenStreetMap's "blocked" tile across the whole
   backdrop. Cause: rounds 1-16 pointed the default basemap straight at
   tile.openstreetmap.org. That service is run by volunteers for OSM's own
   site and small-scale use; its usage policy requires a valid Referer from a
   web app (a file:// copy sends none at all) and asks apps like this one to
   use another provider. OSM enforced it.

   Nothing in the app could have caught that, because every suite stubs the
   tile hosts — a stub answers a banned host just as happily as an allowed
   one. So this suite asserts the thing the stubs hid: which hosts the app
   ASKS for. If a future round reaches for OSM tiles again, this fails before
   Mike ever opens the file.

   It also pins the two properties that made the failure confusing rather than
   obvious: the tile credit must be on the map (Esri's terms require it, and a
   visible credit is how you can tell at a glance which service you are on),
   and a custom tile URL must never silently fall back to a different map. */

const BANNED = /openstreetmap\.org|opentopomap\.org|cartocdn\.com/i;
const ALLOWED_HOST = 'server.arcgisonline.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // Record every tile request, then answer it locally. Recording is the point;
  // fulfilling keeps the suite off real tile servers.
  const asked = [];
  await page.route('**', route => {
    const u = route.request().url();
    if (u.startsWith('file:')) return route.continue();
    asked.push(u);
    return route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE });
  });

  await page.goto(appUrl());
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    function rect(a,b,c,d){ return [[[a,b],[c,b],[c,d],[a,d],[a,b]]]; }
    startApp([{ id:'F__Big', name:'Big', farm:'F', area_ha:400, exterior:rect(116.00,-30.90,116.02,-30.88), interior:[] }]);
  });
  await page.waitForTimeout(900);

  const banned = () => asked.filter(u => BANNED.test(u));
  const since = (n) => asked.slice(n);
  /* Tile requests from the PREVIOUS basemap keep arriving for a moment after
     a switch. Without settling first, those land in the next option's window
     and the assertion blames the wrong basemap. */
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      const n = asked.length;
      await page.waitForTimeout(250);
      if (asked.length === n) return;
    }
  };

  // 1. The default basemap, as it loads, must not touch a banned host and must
  //    actually fetch tiles from the provider we chose.
  console.log('requests after load:', asked.length, 'first:', asked[0]);
  if (banned().length) throw new Error('The default basemap requested a banned tile host: ' + JSON.stringify(banned().slice(0, 3)));
  if (!asked.some(u => u.includes(ALLOWED_HOST))) throw new Error('The default basemap fetched no tiles from ' + ALLOWED_HOST + '. Requests seen: ' + JSON.stringify(asked.slice(0, 5)));

  // 2. Every option in the basemap menu — not a hand-written list, the actual
  //    options, so a new one added later is covered automatically.
  const options = await page.$$eval('#basemapSel option', els => els.map(e => e.value));
  console.log('basemap options:', JSON.stringify(options));
  if (options.length < 4) throw new Error('Expected the full basemap menu, got ' + JSON.stringify(options));

  const keyed = await page.evaluate(() => Object.keys(KEYED_PROVIDERS));
  console.log('keyed providers:', JSON.stringify(keyed));
  await settle();
  for (const val of options) {
    const mark = asked.length;
    await page.selectOption('#basemapSel', val);
    await settle();
    await page.waitForTimeout(500);
    const fresh = since(mark);
    const bad = fresh.filter(u => BANNED.test(u));
    const esri = fresh.filter(u => u.includes(ALLOWED_HOST)).length;
    console.log(`  ${val.padEnd(16)} requests=${fresh.length} esri=${esri} banned=${bad.length}`);
    if (bad.length) throw new Error(`Basemap "${val}" requested a banned tile host: ` + JSON.stringify(bad.slice(0, 3)));
    /* Two kinds of option must fetch NOTHING rather than quietly substituting
       a different map: an unset custom URL, and a keyed provider with no key
       yet. Substituting would leave the operator reading ground he did not
       choose, which is worse than a blank backdrop with a notice on it. */
    if (val === 'blank') {
      // A deliberate no-backdrop choice: nothing to fetch, and nothing to
      // credit either.
      if (fresh.length) throw new Error('The blank basemap fetched tiles: ' + JSON.stringify(fresh.slice(0, 3)));
      continue;
    }
    if (val === 'custom' || keyed.includes(val)) {
      if (fresh.length) throw new Error(`Basemap "${val}" has nothing configured yet but fetched tiles anyway: ` + JSON.stringify(fresh.slice(0, 3)));
      continue;
    }
    if (!esri) throw new Error(`Basemap "${val}" fetched no tiles from ${ALLOWED_HOST}`);
  }

  /* A keyed provider, once its key is in, must be the ONLY host contacted and
     must actually carry the key. */
  const provider = keyed[0];
  await page.selectOption('#basemapSel', provider);
  await settle();
  let kmark = asked.length;
  await page.evaluate(() => {
    const el = document.getElementById('tileKeyInput');
    el.value = 'TESTKEY123';
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(800);
  const keyedReqs = since(kmark);
  const host = await page.evaluate((p) => new URL(KEYED_PROVIDERS[p].url.replace(/\{[a-z]+\}/g, '1')).host, provider);
  console.log(`${provider} with a key:`, keyedReqs.length, 'requests, first:', keyedReqs[0] || '');
  if (!keyedReqs.length) throw new Error(`${provider} fetched nothing after a key was entered`);
  if (!keyedReqs.every(u => u.includes(host))) throw new Error(`${provider} contacted a host other than ${host}: ` + JSON.stringify(keyedReqs.filter(u => !u.includes(host)).slice(0, 3)));
  if (!keyedReqs.every(u => u.includes('TESTKEY123'))) throw new Error(`${provider} requested tiles without the key attached: ` + keyedReqs[0]);
  // And the key field must be visible for a keyed provider and hidden otherwise.
  const fields = await page.evaluate(() => ({ keyShown: document.getElementById('tileKeyInput').style.display !== 'none',
                                              urlShown: document.getElementById('customTileUrl').style.display !== 'none' }));
  if (!fields.keyShown) throw new Error('The key field is hidden while a keyed provider is selected');
  await page.selectOption('#basemapSel', 'bw');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => document.getElementById('tileKeyInput').style.display);
  if (hidden !== 'none') throw new Error('The key field is still showing on a provider that needs no key');

  // 3. A custom URL: a malformed one must stay blank, a well-formed one must be
  //    the ONLY host contacted.
  await page.selectOption('#basemapSel', 'custom');
  await settle();
  let mark = asked.length;
  await page.evaluate(() => {
    const el = document.getElementById('customTileUrl');
    el.value = 'https://tiles.example.com/no-placeholders.png';
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(500);
  if (since(mark).length) throw new Error('A custom tile URL with no {z}/{x}/{y} placeholders still fetched tiles: ' + JSON.stringify(since(mark).slice(0, 3)));

  mark = asked.length;
  await page.evaluate(() => {
    const el = document.getElementById('customTileUrl');
    el.value = 'https://tiles.example.com/{z}/{x}/{y}.png';
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(700);
  const custom = since(mark);
  console.log('custom URL requests:', custom.length, custom[0] || '');
  if (!custom.length || !custom.every(u => u.includes('tiles.example.com'))) {
    throw new Error('A valid custom tile URL did not become the only tile source: ' + JSON.stringify(custom.slice(0, 3)));
  }

  // 4. The tile credit must be on the map, on screen AND in print. Esri's terms
  //    require it, and it is how you can see at a glance which service is live.
  await page.selectOption('#basemapSel', 'roads');
  await page.waitForTimeout(500);
  const editAttrib = await page.evaluate(() => {
    const el = document.querySelector('#editMap .leaflet-control-attribution');
    return el ? { text: el.textContent.trim(), display: getComputedStyle(el).display } : null;
  });
  console.log('edit map attribution:', JSON.stringify(editAttrib));
  if (!editAttrib || !/Esri/i.test(editAttrib.text)) throw new Error('The edit map shows no tile credit: ' + JSON.stringify(editAttrib));

  /* In the print preview the credit lives in the sheet's own footer line
     (#pAttrib), not in a Leaflet box floating over the map — a second credit
     sitting on the printed plan is clutter, not compliance. It must name the
     service that is actually being used, and it must survive print media. */
  await page.click('#previewBtn');
  await page.waitForTimeout(1500);
  const pvAttrib = await page.evaluate(() => {
    const el = document.getElementById('pAttrib');
    const box = document.querySelector('#previewMap .leaflet-control-attribution');
    return {
      footer: el ? el.textContent.trim() : null,
      footerDisplay: el ? getComputedStyle(el).display : null,
      floatingBox: !!box,
    };
  });
  console.log('preview attribution:', JSON.stringify(pvAttrib));
  if (!pvAttrib.footer || !/Esri/i.test(pvAttrib.footer)) throw new Error('The printed sheet carries no tile credit: ' + JSON.stringify(pvAttrib));
  if (pvAttrib.floatingBox) throw new Error('A Leaflet credit box is floating over the printed map as well as the footer credit');

  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(400);
  const printAttrib = await page.evaluate(() => {
    const el = document.getElementById('pAttrib');
    return el ? { display: getComputedStyle(el).display, fontSize: getComputedStyle(el).fontSize, text: el.textContent.trim() } : null;
  });
  console.log('footer attribution (PRINT media):', JSON.stringify(printAttrib));
  if (!printAttrib || printAttrib.display === 'none') throw new Error('The tile credit is hidden in print — Esri require it to stay with the map');
  if (!/Esri/i.test(printAttrib.text)) throw new Error('The printed credit does not name the tile service: ' + printAttrib.text);
  await page.emulateMedia({ media: null });

  // 5. Nothing above may have been achieved by throwing.
  if (pageErrors.length) throw new Error('Page errors: ' + JSON.stringify(pageErrors));
  if (banned().length) throw new Error('A banned tile host was requested at some point: ' + JSON.stringify(banned().slice(0, 5)));
  console.log(`total tile requests seen: ${asked.length}, banned hosts: 0`);

  await browser.close();
  console.log('ALL BASEMAP SOURCE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e.message || e); process.exit(1); });

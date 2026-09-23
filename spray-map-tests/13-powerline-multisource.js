const { chromium } = require('playwright');
const { appUrl, fixture, stubTiles } = require('./harness');

/* Round 19 — more than one power line file, and HV transmission is its own
   hazard.

   Reported: an unmarked HV transmission line was not being mapped. Western
   Power publish the distribution network and the transmission network as
   SEPARATE statewide shapefiles, and the importer could hold only one file —
   loading the second silently replaced the first, so whichever network was
   loaded last was the only one on the sheet. A transmission line missing from
   an aerial spray plan is the most consequential thing this tool can get
   wrong: transmission structures are 20-50 m tall against 8-12 m for
   distribution, and a strike is not survivable.

   So this suite asserts the two things that failure needed: the importer
   holds several files at once, each clipped on its own, and the two networks
   are told apart everywhere they reach the operator — on the map, in the
   printed legend, and in the KML the spray plane actually loads. */

const DIST = 'DistributionOverheadPowerlines_test.zip'; // 4 features: 2 inside a 2km buffer, 1 at ~10km, 1 hundreds of km away
const HV   = 'TransmissionLinesWP_HV_test.zip';         // 3 features: 1 inside a 2km buffer, 1 at ~10km, 1 hundreds of km away

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [], dialogs = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  await stubTiles(page);

  await page.goto(appUrl());
  await page.waitForTimeout(400);
  await page.setInputFiles('#fileInput', fixture('Koojan_Test_Boundaries.zip'));
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => typeof PADDOCKS !== 'undefined' && PADDOCKS.length > 0)) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);

  /* --- 1. Load the two files the way Mike hit the bug: one, then the other.
         The count of segments actually on the map is the assertion, because
         that is what the old build got wrong and it is readable on either
         build — the old one held a single file, so loading the transmission
         network threw the distribution network away. --- */
  await page.setInputFiles('#powerlineInput', [fixture(DIST)]);
  await page.waitForTimeout(2500);
  const afterFirst = await page.evaluate(() => gisPowerlines.length);
  await page.setInputFiles('#powerlineInput', [fixture(HV)]);
  await page.waitForTimeout(2500);
  const afterSecond = await page.evaluate(() => gisPowerlines.length);
  console.log('segments after the 1st file:', afterFirst, 'after the 2nd:', afterSecond);
  if (afterFirst !== 2) throw new Error('The distribution fixture should clip to 2 segments, got ' + afterFirst);
  if (afterSecond !== 3) throw new Error('Loading the second power line file left ' + afterSecond + ' segments, not 3 — the second file replaced the first instead of being added, which is exactly how an unmarked HV transmission line never reaches the map');
  if (await page.evaluate(() => !document.getElementById('powerlineInput').multiple)) {
    throw new Error('The power line file input still takes one file at a time');
  }

  // Both files must also load in ONE selection.
  await page.evaluate(() => { document.getElementById('clearPowerlineBtn').click(); });
  await page.waitForTimeout(600);
  await page.setInputFiles('#powerlineInput', [fixture(DIST), fixture(HV)]);
  await page.waitForTimeout(3000);
  const loaded = await page.evaluate(() => ({
    sources: gisPlSources.map(s => ({ name: s.name, cls: s.cls, matched: s.matched, total: s.total })),
    counts: powerlineClassCounts(),
    segments: gisPowerlineSegments.length,
    flat: gisPowerlines.length,
  }));
  console.log('after loading both files:', JSON.stringify(loaded));
  if (loaded.sources.length !== 2) throw new Error('Expected both power line files to be held at once, got ' + loaded.sources.length + ' — the second file is still replacing the first, which is how an HV transmission line goes missing');
  const hvSrc = loaded.sources.find(s => /Transmission/i.test(s.name));
  const dSrc  = loaded.sources.find(s => /Distribution/i.test(s.name));
  if (!hvSrc || hvSrc.cls !== 'transmission') throw new Error('The transmission file was not recognised as HV: ' + JSON.stringify(hvSrc));
  if (!dSrc || dSrc.cls !== 'distribution') throw new Error('The distribution file was not recognised as distribution: ' + JSON.stringify(dSrc));

  // --- 2. Each file is clipped on its own against the shared buffer. Both
  //        fixtures carry a feature ~10km out and another hundreds of km
  //        away, which must be rejected per file, not pooled. ---
  if (dSrc.matched !== 2 || dSrc.total !== 4) throw new Error('Distribution file clipped wrong: ' + JSON.stringify(dSrc));
  if (hvSrc.matched !== 1 || hvSrc.total !== 3) throw new Error('HV file clipped wrong: ' + JSON.stringify(hvSrc));
  if (loaded.counts.distribution !== 2 || loaded.counts.transmission !== 1) throw new Error('Segment classes wrong: ' + JSON.stringify(loaded.counts));
  if (loaded.flat !== 3) throw new Error('The flat segment list the summary and export read is out of step: ' + loaded.flat);

  // --- 3. On the map the two networks must be visibly different, not the
  //        same line drawn twice. ---
  await page.evaluate(() => {
    selectedCrop = 'W';
    const p = PADDOCKS[0];
    editPolyLayers[p.id].fire('click', { latlng: L.latLng(...p.centerLatLng) });
  });
  await page.waitForTimeout(1200);
  const drawn = await page.evaluate(() => {
    const out = { weights: {}, casings: 0, marks: {} };
    gisPowerlineGroup.eachLayer(l => {
      if (l.getLatLngs) {
        const o = l.options;
        const key = (o.color || '') + '@' + o.weight + (o.dashArray ? ('/' + o.dashArray) : '');
        out.weights[key] = (out.weights[key] || 0) + 1;
        if (o.color === '#b9b9b9') out.casings++;
      } else if (l.options && l.options.icon) {
        const c = l.options.icon.options.className;
        out.marks[c] = (out.marks[c] || 0) + 1;
      }
    });
    return out;
  });
  console.log('power line layers drawn:', JSON.stringify(drawn));
  const weightKeys = Object.keys(drawn.weights).filter(k => k.startsWith('#000'));
  if (weightKeys.length < 2) throw new Error('Both networks are drawn with the same line style — the operator cannot tell a transmission conductor from a distribution span: ' + JSON.stringify(drawn.weights));
  if (!drawn.casings) throw new Error('The HV transmission line has no casing behind it, so it does not read as heavier');
  if (!drawn.marks['pl-mark'] || !drawn.marks['pl-mark-hv']) throw new Error('Both networks use the same × mark class: ' + JSON.stringify(drawn.marks));

  // --- 4. The printed legend must name them separately. That sheet is what
  //        the operator flies with. ---
  await page.click('#previewBtn');
  await page.waitForTimeout(2000);
  const legend = await page.evaluate(() => document.getElementById('pLegend').textContent);
  console.log('printed legend:', legend);
  if (!/Power Line/.test(legend)) throw new Error('No power line entry in the printed legend: ' + legend);
  if (!/HV Transmission Line/.test(legend)) throw new Error('The printed legend does not distinguish the HV transmission line: ' + legend);
  await page.click('#backBtn');
  await page.waitForTimeout(800);

  // --- 5. The KML the spray plane loads must carry the distinction too. ---
  const kml = await page.evaluate(async () => {
    const icons = await buildKmlIconCache();
    const text = buildKML(icons, false);
    return {
      hv: (text.match(/HV Transmission Line \(GIS\)/g) || []).length,
      dist: (text.match(/>Power Line \(GIS\)</g) || []).length,
      hvStyle: text.includes('style_hvline'),
      warns: /Do not overfly/.test(text),
    };
  });
  console.log('KML:', JSON.stringify(kml));
  if (kml.hv !== 1) throw new Error('Expected 1 HV transmission placemark in the KML, got ' + kml.hv);
  if (kml.dist !== 2) throw new Error('Expected 2 distribution placemarks in the KML, got ' + kml.dist);
  if (!kml.hvStyle) throw new Error('The HV transmission line shares the distribution line style in the KML');
  if (!kml.warns) throw new Error('The HV placemark carries no height warning for the operator');

  // --- 6. The class is a guess from the filename, so it must be correctable,
  //        and everything downstream must follow the correction. ---
  const corrected = await page.evaluate(async () => {
    const hvRow = document.querySelector('#plSourceList .gis-src[data-src-name*="Transmission"]');
    const sel = hvRow.querySelector('select');
    sel.value = 'distribution';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return { counts: powerlineClassCounts(), cls: gisPlSources.find(s => /Transmission/i.test(s.name)).cls };
  });
  console.log('after correcting the HV file to distribution:', JSON.stringify(corrected));
  if (corrected.cls !== 'distribution' || corrected.counts.transmission !== 0) throw new Error('The voltage class cannot be corrected: ' + JSON.stringify(corrected));
  await page.evaluate(async () => {
    const hvRow = document.querySelector('#plSourceList .gis-src[data-src-name*="Transmission"]');
    const sel = hvRow.querySelector('select');
    sel.value = 'transmission';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
  });

  // --- 7. Per-file show/hide, and delete one without touching the other. ---
  const hidden = await page.evaluate(async () => {
    const distRow = document.querySelector('#plSourceList .gis-src[data-src-name*="Distribution"]');
    distRow.querySelector('input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 800));
    return { counts: powerlineClassCounts(), sources: gisPlSources.length };
  });
  console.log('with the distribution file hidden:', JSON.stringify(hidden));
  if (hidden.counts.distribution !== 0 || hidden.counts.transmission !== 1) throw new Error('Hiding one file did not leave the other showing: ' + JSON.stringify(hidden));
  if (hidden.sources !== 2) throw new Error('Hiding a file removed it instead');
  await page.evaluate(async () => {
    document.querySelector('#plSourceList .gis-src[data-src-name*="Distribution"]').querySelector('input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 800));
  });

  const deleted = await page.evaluate(async () => {
    document.querySelector('#plSourceList .gis-src[data-src-name*="Distribution"]').querySelector('.del').click();
    await new Promise(r => setTimeout(r, 900));
    return { sources: gisPlSources.map(s => s.name), counts: powerlineClassCounts() };
  });
  console.log('after deleting the distribution file:', JSON.stringify(deleted));
  if (deleted.sources.length !== 1 || !/Transmission/i.test(deleted.sources[0])) throw new Error('Deleting one file did not leave the other: ' + JSON.stringify(deleted));
  if (deleted.counts.transmission !== 1) throw new Error('The surviving file stopped drawing after the other was deleted');

  // --- 8. Re-loading a file already in the list replaces that entry rather
  //        than drawing it on top of itself. ---
  await page.setInputFiles('#powerlineInput', [fixture(HV)]);
  await page.waitForTimeout(2500);
  const reloaded = await page.evaluate(() => ({ sources: gisPlSources.length, counts: powerlineClassCounts() }));
  console.log('after re-loading the same file:', JSON.stringify(reloaded));
  if (reloaded.sources !== 1) throw new Error('Re-loading the same file duplicated it: ' + JSON.stringify(reloaded));
  if (reloaded.counts.transmission !== 1) throw new Error('Re-loading the same file drew it twice: ' + JSON.stringify(reloaded));

  // --- 9. A buffer change must re-clip EVERY file, not just the first. ---
  await page.setInputFiles('#powerlineInput', [fixture(DIST)]);
  await page.waitForTimeout(2500);
  const widened = await page.evaluate(async () => {
    const before = gisPlSources.map(s => s.matched);
    const el = document.getElementById('plBuffer');
    el.value = '20';
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 2500));
    return { before, after: gisPlSources.map(s => s.matched), names: gisPlSources.map(s => s.name) };
  });
  console.log('buffer 2km -> 20km:', JSON.stringify(widened));
  if (widened.after.length !== 2) throw new Error('A buffer change dropped a file');
  /* Each fixture has a feature about 10km out, so a 20km buffer must pick up
     exactly one more from EVERY file. If only the first file were re-clipped,
     the other's count would not move — which is the bug this guards. */
  if (widened.after.some((n, i) => n !== widened.before[i] + 1)) throw new Error('Widening the buffer did not re-clip every file — each should gain exactly one feature: ' + JSON.stringify(widened));

  const realDialogs = dialogs.filter(d => !/Load paddock boundaries first/.test(d));
  if (realDialogs.length) throw new Error('Unexpected alerts: ' + JSON.stringify(realDialogs));
  if (pageErrors.length) throw new Error('Page errors: ' + JSON.stringify(pageErrors));
  await browser.close();
  console.log('ALL POWER LINE MULTI-SOURCE TESTS PASSED');
})().catch(e => { console.error('SMOKETEST FAILED:', e.message || e); process.exit(1); });

# Aerial Spraying Plan Map — test suites

Regression tests for `../aerial-spraying-plan-map.html`.

The map file is a single self-contained HTML document with no build step. These
suites drive it in a real browser and assert the things that must stay true.
They exist because most of the defects found in this tool were **invisible** —
crop hatch printed over no-spray ground, a "snapped" point sitting 2 m off the
fence, export icons silently missing on Safari. None of those look wrong on
screen, so only an assertion catches them.

## Run them

```bash
cd spray-map-tests
npm install
npx playwright install chromium webkit
npm test                 # all suites
npm test 07              # just one, by number
```

Expected on a fresh clone: **13 passed, 5 skipped, 0 failed.** The skips are the
20-series (see below).

## What each suite protects

| Suite | The invariant |
|---|---|
| `01-core-assignment` | Crop assignment by map click and by paddock list; hazards; power lines; comments; print legend and totals |
| `02-merge-addfarm-basemaps` | One label per multi-block paddock with correct summed area; "Add farm" is additive, not replacing; every basemap switches without error |
| `03-labels-hazard-scoping` | Paddock-name labels never overlap the crop circle — including after a click-only crop assignment, which used to redraw the circle and leave the name underneath it; the default basemap and its contrast filter; hazard counts and rendering scope to the ticked farms |
| `04-exclusion-holes-kml` | An exclusion is a real geometric hole (`innerBoundaryIs`), not an overlay; KML/KMZ export is well-formed and farm-scoped |
| `05-multiblock-degraded-labels` | A hole attaches only to the block containing it; the degraded-clipping banner appears when the clipper is unavailable; the crop letter never sits on excluded ground |
| `06-poles-roads-icons` | A coordinate-less CSV is rejected with an actionable message; poles/roads clip to the farm buffer; road names read from the `.dbf`; crossroads detected; KML icons rasterise; KMZ bundles icon files |
| `07-boundary-snapping` | A vertex snap lands **exactly** on the fence corner; an edge snap exactly on the fence line; Alt and the toggle both suspend snapping; fenceline tracing follows the boundary and takes the geometrically shorter path; a lasso trimmed to the fence has zero area outside it; a loose outline around a block becomes that block exactly; per-paddock hectares split by real overlap, not evenly; pre-existing saved zones keep their old numbers |
| `08-print-excluded-area` | **No hatch-filled path may cover the excluded area** — on screen, in preview, and under print media. Asserted with the browser's own `isPointInFill`, so it understands holes. Fails even if the hatch is merely *present* and hidden by opacity, because a print pipeline can drop opacity. Then renders a real PDF and counts dark pixels in the hole |
| `09-offline-mobile` | Runs WebKit (iOS Safari's engine) on iPad and iPhone profiles with **every network request aborted**: all libraries present, a real shapefile zip loads, the workflow runs, KML builds with icons. Asserts no CDN request is ever attempted |
| `10-snapping-visual` | Drives the real UI with real mouse events: crosshair cursor, snap indicator lands on the corner, the rubber band traces the fence, traced vertices survive into the committed zone |
| `11-basemap-sources` | **Which hosts the map asks for tiles from.** Every other suite stubs the tile servers, and a stub answers a banned host as happily as an allowed one — which is how the app shipped for sixteen rounds pointing at `tile.openstreetmap.org` in breach of its usage policy, until OSM served its "blocked" tile across the whole backdrop. Asserts no basemap requests OSM, OpenTopoMap or Carto; every menu option fetches from the provider actually chosen; a custom tile URL is used only when it is well-formed, and never falls back to a different map; the tile credit is on the map and survives print |
| `12-map-label-placement` | **The pixels, not the geometry.** One road gets its name at most twice, never once per shapefile feature — Main Roads WA stores a road as many features, which drew six overlapping chips in one place. No two pieces of map text may overlap, of any kind: crop letters, paddock names, hazard icons, the airstrip note, road and crossroad names all share one occupancy list. A repeat road label may never sit on crop hatch. Roads draw as a road (dark casing under a warm fill), not the old flat blue line. And Esri's own rotated raster road names come off the basemap while his authoritative road layer is loaded — they cannot be moved, and on a vertical road they render as a column of tick marks |
| `13-powerline-multisource` | **Several power line files at once, and HV transmission as its own hazard.** Western Power publish distribution and transmission as separate statewide shapefiles; the importer held one, so loading the second silently discarded the first and an unmarked HV transmission line never reached the sheet. Asserts the second file adds rather than replaces (checked by segments drawn, so it is readable on the old build too), each file clips independently against the shared buffer, a buffer change re-clips *every* file, the voltage class is inferred from the filename and correctable, the two networks draw differently, the printed legend names them separately, and the KML carries an HV style plus a height warning. Also per-file show/hide, per-file delete, and re-loading the same file replacing its entry |

### The 20-series (skipped by default)

These run against real statewide GIS extracts, which are too large for a
repository and are the farm's own licensed data. They **skip** when absent —
that is normal and not a failure.

| Suite | Needs in `data/` |
|---|---|
| `20-real-powerlines`, `21-real-powerlines-reclip` | `DistributionOverheadPowerlinesWP_031.shp` — Western Power / Landgate overhead network (~26 MB) |
| `22-real-roads` | `Road_Network.zip` — Main Roads WA network (~36 MB) |
| `23-real-poles` | `Poles.zip` — Western Power distribution poles (~17 MB) |
| `24-gis-source-cache` | both of the above — proves the IndexedDB source cache survives a reload and re-clips without re-uploading |

`data/` is git-ignored. Drop the files in and re-run to exercise them.

## Rules for changing this tool

1. **Change the HTML, then run `npm test`.** If a suite fails, the assertion is
   almost certainly right and the change is wrong — these encode defects that
   already reached a real printer, a real iPad and a real spray operator.
2. **Never delete an assertion to make a change pass.** Every one is a bug that
   happened. If an assertion is genuinely obsolete, say why in the commit.
3. **New behaviour gets a new assertion**, and it should fail before the fix and
   pass after. A test that passes either way proves nothing.
4. There is **no build step and no test copy of the app**. The suites load
   `../aerial-spraying-plan-map.html` directly, so they cannot pass against a
   stale artefact.

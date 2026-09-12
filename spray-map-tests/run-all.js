#!/usr/bin/env node
/* Runs every suite and prints one summary.

   Exit 1 if anything FAILED. A suite that SKIPs (because a large private GIS
   source isn't present) is not a failure — CI on a fresh clone is expected to
   skip the 20-series and still be green. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const only = process.argv[2];               // e.g. `npm test -- 07` to run one
const suites = fs.readdirSync(__dirname)
  .filter(f => /^\d\d-.*\.js$/.test(f))
  .filter(f => !only || f.startsWith(only))
  .sort();

if (!suites.length) { console.error('No suites matched ' + (only || '')); process.exit(1); }

const results = [];
for (const suite of suites) {
  process.stdout.write(suite.padEnd(34));
  const started = Date.now();
  let out = '', status = 'PASS';
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, suite)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000,
    });
    if (/^SKIP:/m.test(out)) status = 'SKIP';
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    status = 'FAIL';
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(status + '  (' + secs + 's)');
  if (status === 'SKIP') {
    console.log('    ' + (out.match(/^SKIP: .*/m) || [''])[0]);
  }
  if (status === 'FAIL') {
    console.log(out.trim().split('\n').slice(-12).map(l => '    ' + l).join('\n'));
  }
  results.push({ suite, status });
}

const count = s => results.filter(r => r.status === s).length;
console.log('\n' + '-'.repeat(52));
console.log(`${count('PASS')} passed, ${count('SKIP')} skipped, ${count('FAIL')} failed`);
if (count('FAIL')) {
  console.log('FAILED: ' + results.filter(r => r.status === 'FAIL').map(r => r.suite).join(', '));
  process.exit(1);
}
console.log('OK');

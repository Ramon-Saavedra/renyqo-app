// CI-only discovery/execution proof. No database access or test setup changes.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { relative } = require('node:path');

function assertPartition(all, shards) {
  assert.ok(all.length > 0, 'Full E2E discovery must not be empty');
  assert.equal(new Set(all).size, all.length, 'Duplicate full-suite discovery');
  assert.equal(shards.length, 2, 'Exactly two E2E shards are required');
  for (const shard of shards) {
    assert.ok(shard.length > 0, 'An E2E shard must not be empty');
  }
  const combined = shards.flat();
  assert.equal(
    new Set(combined).size,
    combined.length,
    'Overlapping E2E shards',
  );
  assert.deepEqual(
    [...combined].sort(),
    [...all].sort(),
    'Incomplete partition',
  );
}

function discover(shard) {
  const args = [
    '--experimental-vm-modules',
    '--require',
    './test/pg-client-query-overlap-warnings.cjs',
    './node_modules/jest/bin/jest.js',
    '--config',
    './test/jest-e2e.json',
    '--runInBand',
    '--passWithNoTests=false',
    '--listTests',
    '--json',
  ];
  if (shard) args.push(`--shard=${shard}/2`);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Jest discovery failed: ${result.stderr}`);
  const files = JSON.parse(result.stdout);
  assert.ok(
    Array.isArray(files) && files.every((file) => typeof file === 'string'),
  );
  return files;
}

function summarizeResults(expected, result, shard) {
  assert.ok(expected.length > 0, 'Expected shard must not be empty');
  const actual = result.testResults.map((suite) => suite.name);
  assert.equal(new Set(actual).size, actual.length, 'Duplicate executed suite');
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    'Executed suite mismatch',
  );
  assert.equal(result.numTotalTestSuites, expected.length);
  assert.equal(
    result.numPassedTestSuites,
    expected.length,
    'Not every suite passed',
  );
  assert.equal(result.numPendingTestSuites, 0, 'A suite was skipped');
  assert.equal(result.numPendingTests, 0, 'A test was skipped');
  assert.equal(result.numTodoTests, 0, 'A test was left TODO');
  assert.ok(result.numTotalTests > 0, 'No E2E tests executed');
  assert.equal(
    result.numPassedTests,
    result.numTotalTests,
    'Not every test passed',
  );
  assert.equal(result.success, true, 'Jest reported failure');
  const seconds = ((Date.now() - result.startTime) / 1000).toFixed(1);
  const lines = [
    `E2E shard ${shard}/2: ${expected.length} suites, ${result.numTotalTests} tests passed; ${seconds}s elapsed.`,
    '',
    '| Slowest suite | Seconds |',
    '| --- | ---: |',
  ];
  const slowest = [...result.testResults]
    .sort((a, b) => b.endTime - b.startTime - (a.endTime - a.startTime))
    .slice(0, 5);
  for (const suite of slowest) {
    lines.push(
      `| ${relative(process.cwd(), suite.name).replaceAll('\\', '/')} | ${((suite.endTime - suite.startTime) / 1000).toFixed(1)} |`,
    );
  }
  return lines.join('\n') + '\n';
}

function main() {
  const [mode, manifestPath, shard, resultsPath] = process.argv.slice(2);
  assert.ok(manifestPath, 'A temporary discovery manifest path is required');
  if (mode === 'discover') {
    const all = discover();
    const shards = [discover(1), discover(2)];
    assertPartition(all, shards);
    writeFileSync(manifestPath, JSON.stringify({ all, shards }));
    console.log(
      `Verified ${all.length} E2E suites exactly once: ${shards.map((files) => files.length).join(' + ')}.`,
    );
  } else {
    assert.equal(mode, 'report', 'Expected discover or report');
    assert.ok(shard === '1' || shard === '2', 'Invalid shard index');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assertPartition(manifest.all, manifest.shards);
    const result = JSON.parse(readFileSync(resultsPath, 'utf8'));
    const summary = summarizeResults(
      manifest.shards[Number(shard) - 1],
      result,
      shard,
    );
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  }
}

module.exports = { assertPartition, summarizeResults };
if (require.main === module) main();

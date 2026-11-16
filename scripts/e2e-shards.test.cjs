const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
const { assertPartition, summarizeResults } = require('./e2e-shards.cjs');

nodeTest(
  'accepts a complete, disjoint partition without mutating discovery order',
  () => {
    const all = ['b', 'a'];
    const shards = [['a'], ['b']];
    assertPartition(all, shards);
    assert.deepEqual(all, ['b', 'a']);
    assert.deepEqual(shards, [['a'], ['b']]);
  },
);

for (const [name, all, shards] of [
  ['empty discovery', [], [[], []]],
  ['empty shard', ['a'], [['a'], []]],
  ['missing suite', ['a', 'b', 'c'], [['a'], ['b']]],
  ['foreign suite', ['a', 'b'], [['a'], ['c']]],
  ['overlap', ['a', 'b'], [['a'], ['a', 'b']]],
  ['duplicate discovery', ['a', 'a'], [['a'], ['b']]],
  ['wrong shard count', ['a'], [['a']]],
]) {
  nodeTest(`rejects ${name}`, () => {
    assert.throws(() => assertPartition(all, shards));
  });
}

function successfulResult() {
  return {
    success: true,
    startTime: Date.now() - 2000,
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numPendingTestSuites: 0,
    numTotalTests: 3,
    numPassedTests: 3,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      { name: 'a', startTime: 1000, endTime: 1100 },
      { name: 'b', startTime: 1000, endTime: 1200 },
    ],
  };
}

nodeTest(
  'reports successful execution with elapsed time and slowest suites',
  () => {
    const summary = summarizeResults(['b', 'a'], successfulResult(), 1);
    assert.match(summary, /shard 1\/2: 2 suites, 3 tests passed/);
    assert.match(summary, /\d+\.\d+s elapsed/);
    assert.ok(summary.indexOf('| b |') < summary.indexOf('| a |'));
  },
);

for (const [name, change] of [
  ['missing suite', { testResults: [{ name: 'a' }] }],
  ['duplicate suite', { testResults: [{ name: 'a' }, { name: 'a' }] }],
  ['foreign suite', { testResults: [{ name: 'a' }, { name: 'c' }] }],
  ['skipped suite', { numPendingTestSuites: 1 }],
  ['skipped test', { numPendingTests: 1 }],
  ['TODO test', { numTodoTests: 1 }],
  ['no tests', { numTotalTests: 0, numPassedTests: 0 }],
  ['failed suite', { numPassedTestSuites: 1 }],
  ['failed test', { numPassedTests: 2 }],
  ['failed run', { success: false }],
]) {
  nodeTest(`rejects execution with ${name}`, () => {
    assert.throws(() =>
      summarizeResults(['a', 'b'], { ...successfulResult(), ...change }, 1),
    );
  });
}

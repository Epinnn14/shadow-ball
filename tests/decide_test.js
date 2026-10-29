// Tests for demo/decide.js (pure decision logic). Run: node tests/decide_test.js
const assert = require('assert');
const D = require('../demo/decide.js');

const squad = [
  { id: 'a', name: 'Starter CB', group: 'DF', pos: ['LCB'], foot: 'L', keys: ['passing'] },
  { id: 'b', name: 'Quick CB', group: 'DF', pos: ['RCB', 'LCB'], foot: 'R', keys: ['pace', 'recovery runs', 'aerial'] },
  { id: 'c', name: 'Slow CB', group: 'DF', pos: ['CB'], foot: 'R', keys: ['passing', 'composure'] },
  { id: 'd', name: 'Winger', group: 'FW', pos: ['LW'], foot: 'L', keys: ['pace', 'dribbling'] },
  { id: 'g', name: 'Keeper', group: 'GK', pos: ['GK'], foot: 'R', keys: ['shot-stopping'] },
];
const xi = { LCB: 'a' };

// a tired left centre-back: the quick centre-back first, the winger never above a defender
const needs = D.needsFor('LCB', 'duel');
assert.deepStrictEqual(needs.slice(0, 3), ['pace', 'recovery runs', '1v1 defending']);
const recs = D.recommend(squad, xi, 'LCB', needs);
assert.strictEqual(recs[0].id, 'b');
assert.ok(!recs.some((r) => r.id === 'a'), 'players already in the XI are not recommended');
assert.ok(!recs.some((r) => r.id === 'g'), 'keepers only replace keepers');
assert.ok(recs.findIndex((r) => r.id === 'd') > recs.findIndex((r) => r.id === 'c'));

// family: LCB and RCB are the same job
assert.strictEqual(D.family('LCB'), D.family('RCB'));
assert.strictEqual(D.canPlay(squad[2], 'LCB'), 0.85);

// Plan B ranks a substitution for a red-flag player above an attacking idea
const plan = D.planB({ tired: [{ role: 'LCB', risk: 66 }], subs: { LCB: recs }, atkLane: 'right', atkFree: 20 });
assert.strictEqual(plan[0].kind, 'sub');
assert.strictEqual(plan[plan.length - 1].kind, 'attack');
// a shape change that does not help in the simulation is not proposed
const worse = { metric: 'x', before: 0.33, after: 0.34 }, better = { metric: 'x', before: 0.33, after: 0.25 };
assert.ok(!D.planB({ backFive: { side: 'left', effect: worse }, dangerA: 3 }).some((o) => o.kind === 'shape'));
assert.ok(D.planB({ backFive: { side: 'left', effect: better }, dangerA: 3 }).some((o) => o.kind === 'shape'));
console.log('decide.js: all tests passed');

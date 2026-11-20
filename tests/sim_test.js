// Tests for demo/sim.js (match simulator). Run: node tests/sim_test.js
const assert = require('assert');
global.window = {};
require('../demo/data.js'); require('../demo/threat.js');
const SIM = require('../demo/sim.js');
const D = window.SB_DATA, TH = window.SB_THREAT;
const base = { surface: TH.surface, cell: TH.cell, slots: D.slots };
const match = (seed, H, A) => { const m = SIM.create(Object.assign({ seed, H, A }, base)); m.runHalf(); const ht = JSON.parse(JSON.stringify(m.S.stats)); m.runHalf(); return { S: m.S, ht }; };
const sym = { formation: '4-3-3', style: 'possession' };

// the same seed gives the same match; a different seed a different one
const a = match(7, sym, sym), b = match(7, sym, sym), c = match(8, sym, sym);
assert.deepStrictEqual(a.S.stats, b.S.stats);
assert.notDeepStrictEqual(a.S.stats, c.S.stats);

// two halves of 45 minutes, half time logged once, the second half picks up where the first ended
assert.ok(a.S.ended && a.S.clock >= 5400 && a.S.clock < 5420, 'clock ' + a.S.clock);
assert.strictEqual(a.S.events.filter((e) => e.kind === 'ht').length, 1);
assert.strictEqual(a.S.events.filter((e) => e.kind === 'ft').length, 1);
assert.ok(a.S.stats.H.passes >= a.ht.H.passes);

// a symmetric match over 12 seeds looks like football: per team per match
const avg = { shots: 0, xg: 0, goals: 0, passes: 0, completed: 0 }, N = 12;
for (let s = 1; s <= N; s++) { const S = match(s, sym, sym).S; for (const t of ['H', 'A']) for (const k in avg) avg[k] += S.stats[t][k] / (2 * N); }
assert.ok(avg.shots > 5 && avg.shots < 20, 'shots ' + avg.shots);
assert.ok(avg.xg > 0.6 && avg.xg < 2.5, 'xg ' + avg.xg);
assert.ok(avg.passes > 300 && avg.passes < 800, 'passes ' + avg.passes);
const acc = avg.completed / avg.passes; assert.ok(acc > 0.7 && acc < 0.92, 'accuracy ' + acc);
// goals are drawn from the shots' xG
assert.ok(Math.abs(avg.goals - avg.xg) < 0.6, `goals ${avg.goals} vs xg ${avg.xg}`);

// a change of set-up at half time keeps 11 players a side and the match runs on
const m = SIM.create(Object.assign({ seed: 3, H: sym, A: sym }, base)); m.runHalf();
m.setTeam('H', { formation: '3-5-2', style: 'counter' }); m.S.paused = false; m.runHalf();
assert.strictEqual(m.S.players.filter((p) => p.team === 'H').length, 11);
assert.ok(m.S.ended && m.S.teams.H.formation === '3-5-2');

// the search tries every set-up with the same seeds and sorts by xG difference
let calls = 0;
const res = SIM.search(Object.assign({ runs: 2, formations: ['4-3-3', '4-4-2'], styles: ['possession', 'press'], H: sym, A: sym }, base), () => { calls += 1; });
assert.strictEqual(res.length, 4); assert.strictEqual(calls, 4);
for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].xgd >= res[i].xgd);
assert.ok(res.every((r) => r.se >= 0 && Number.isFinite(r.xgd)));
console.log('sim ok', JSON.stringify(Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, +v.toFixed(2)]))));

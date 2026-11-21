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
// a substitution at half time is logged and the new player starts fresh
const sub = SIM.create(Object.assign({ seed: 5, H: { formation: '4-3-3', style: 'press', names: { ST: 'Nine' } }, A: sym }, base)); sub.runHalf();
sub.setTeam('H', { formation: '4-3-3', style: 'press', names: { ST: 'Fresh' } });
const subEv = sub.S.events.filter((e) => e.kind === 'sub');
assert.strictEqual(subEv.length, 1); assert.strictEqual(subEv[0].who, 'Fresh'); assert.strictEqual(subEv[0].off, 'Nine');
assert.strictEqual(sub.S.stats.H.subs, 1);
assert.ok(sub.S.players.find((p) => p.name === 'Fresh').on >= 2700);
// changing formation or style with the same players is not a substitution
sub.setTeam('H', { formation: '4-4-2', style: 'counter', names: { ST: 'Fresh' } }); assert.strictEqual(sub.S.stats.H.subs, 1);

// finishing changes goals, not the chances: same seed, same xG
const fin = (f) => { const m = SIM.create(Object.assign({ seed: 9, H: Object.assign({}, sym, { finishing: { ST: f, LW: f, RW: f } }), A: sym }, base)); m.runHalf(); m.runHalf(); return m.S.stats.H; };
const lo = fin(0.85), hi = fin(1.15); assert.ok(Math.abs(lo.xg - hi.xg) < 1e-9 && lo.shots === hi.shots);

// the search can play either side, from the second half, with weights
const resA = SIM.search(Object.assign({ runs: 2, side: 'A', half2: true, weights: { f: 1.3, a: 0.7 }, formations: ['4-3-3', '4-4-2'], styles: ['low'], H: sym, A: sym }, base));
assert.strictEqual(resA.length, 2); assert.ok(resA[0].score >= resA[1].score);
console.log('sim ok', JSON.stringify(Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, +v.toFixed(2)]))));

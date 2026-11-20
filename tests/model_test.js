// Tests for demo/model.js (playground model). Run: node tests/model_test.js
const assert = require('assert');
const M = require('../demo/model.js');

// a toy threat surface: worth more the closer to the right goal (attacking right)
const surf = []; for (let i = 0; i < 21; i++) { const col = []; for (let j = 0; j < 14; j++) col.push((i + 1) / 21 * (j > 3 && j < 10 ? 1 : 0.5)); surf.push(col); }
const m = M.create({ L: 105, W: 68, surface: surf, cell: 5 });

// one attacker alone near goal owns almost all the space; a defender between him and the goal takes it away
const ball = { x: 80, y: 34 };
const alone = m.evaluate([{ team: 'H', x: 80, y: 34, role: 'ST' }, { team: 'A', x: 10, y: 34, role: 'CB' }], ball, 'H');
const marked = m.evaluate([{ team: 'H', x: 80, y: 34, role: 'ST' }, { team: 'A', x: 92, y: 34, role: 'CB' }], ball, 'H');
assert.ok(alone.spaceOwned > 0.8, 'alone: ' + alone.spaceOwned);
assert.ok(marked.spaceOwned < alone.spaceOwned - 0.1, 'marked: ' + marked.spaceOwned);
assert.ok(alone.restDefence !== undefined && marked.spaceDenied === undefined);

// a faster player controls more than a slower one in the same spot
const slow = m.evaluate([{ team: 'H', x: 60, y: 34, pace: 0.85 }, { team: 'A', x: 70, y: 34 }], null, 'H').spaceOwned;
const fast = m.evaluate([{ team: 'H', x: 60, y: 34, pace: 1.15 }, { team: 'A', x: 70, y: 34 }], null, 'H').spaceOwned;
assert.ok(fast > slow, `pace: ${fast} vs ${slow}`);

// the simulation only moves H outfield players, never more than 5 m, and never makes things worse
const ps = [{ team: 'H', x: 5, y: 34, role: 'GK' }, { team: 'H', x: 50, y: 20, role: 'LCM' }, { team: 'H', x: 50, y: 48, role: 'RCM' },
            { team: 'A', x: 75, y: 30, role: 'LCB' }, { team: 'A', x: 75, y: 40, role: 'RCB' }];
const sim = m.simulate(ps, { x: 50, y: 20 }, 'H');
assert.ok(sim.after >= sim.before);
for (const mv of sim.moves) { assert.ok(ps[mv.k].team === 'H' && ps[mv.k].role !== 'GK'); assert.ok(Math.hypot(mv.sx - mv.x, mv.sy - mv.y) <= 5.01); }
assert.ok(!sim.moves.some((mv) => mv.role === 'LCM'), 'the ball carrier stays');

// formation placement: H's back line at `line`, mirrored for A, the GK deepest
const slots = [{ label: 'GK', x: 0.5, y: 0.05 }, { label: 'LB', x: 0.1, y: 0.2 }, { label: 'ST', x: 0.5, y: 0.86 }];
const h = M.place(slots, 'H', { line: 30, len: 40 }), a = M.place(slots, 'A', { line: 30, len: 40 });
assert.strictEqual(h[1].x, 30); assert.strictEqual(h[2].x, 70); assert.ok(h[0].x < h[1].x);
assert.strictEqual(a[1].x, 105 - 30); assert.ok(h[1].y < 34 && a[1].y > 34, "each team's left back is on its own left");
console.log('model_test ok');

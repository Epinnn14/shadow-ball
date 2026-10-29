/* Shadow Ball decision layer: what the bench should do, from what the analytics see.
   Pure functions (no DOM) so they can be tested with node: node tests/decide_test.js

   - needsFor(situation)   -> traits the team needs right now for a role
   - recommend(...)        -> bench players ranked for a role (position fit, traits, foot)
   - planB(ctx)            -> ranked tactical options, each with the measured effect the app
                              simulated (control zones before / after) */
(function (root) {
  'use strict';

  // The vocabulary keywords are matched against (coaches can type others; those only match exactly)
  const TRAITS = ['pace', 'recovery runs', 'aerial', '1v1 defending', 'positioning', 'composure', 'passing',
    'press resistance', 'ball winning', 'pressing', 'work rate', 'holding', 'overlap', 'crossing', 'dribbling',
    'creativity', 'runs in behind', 'finishing', 'link-up', 'versatility', 'left foot', 'shot-stopping',
    'distribution', 'sweeper', 'leadership'];

  const GROUP = {
    GK: 'GK',
    LB: 'DEF', LCB: 'DEF', CB: 'DEF', RCB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
    CDM: 'MID', LCDM: 'MID', RCDM: 'MID', CM: 'MID', LCM: 'MID', RCM: 'MID', LM: 'MID', RM: 'MID',
    CAM: 'MID', LAM: 'MID', RAM: 'MID',
    LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
  };
  // what each role needs by default (a substitute for a tired player keeps the role's job)
  const ROLE_NEEDS = {
    GK: ['shot-stopping', 'distribution'],
    CB: ['positioning', 'aerial', 'pace'], LB: ['pace', 'recovery runs', 'overlap'], RB: ['pace', 'recovery runs', 'overlap'],
    WB: ['pace', 'overlap', 'crossing'], CDM: ['positioning', 'ball winning', 'passing'], CM: ['passing', 'press resistance', 'work rate'],
    WM: ['work rate', 'crossing', 'pace'], CAM: ['creativity', 'press resistance', 'finishing'],
    W: ['dribbling', 'pace', 'runs in behind'], ST: ['finishing', 'runs in behind', 'pressing'],
  };
  const family = (role) => {
    const r = role.replace(/^[LR](?=CB|CM|CDM|AM)/, '');
    if (r === 'GK') return 'GK';
    if (['CB'].includes(r)) return 'CB';
    if (role === 'LB' || role === 'RB') return role;
    if (role === 'LWB' || role === 'RWB') return 'WB';
    if (r === 'CDM') return 'CDM';
    if (r === 'CM') return 'CM';
    if (role === 'LM' || role === 'RM') return 'WM';
    if (r === 'CAM' || r === 'AM' || role === 'LAM' || role === 'RAM') return 'CAM';
    if (role === 'LW' || role === 'RW') return 'W';
    return 'ST';
  };
  const side = (role) => (role[0] === 'L' ? 'L' : role[0] === 'R' ? 'R' : 'C');

  function needsFor(role, why) {
    const base = ROLE_NEEDS[family(role)] || [];
    const extra = { fatigue: [], duel: ['pace', 'recovery runs', '1v1 defending'], line: ['pace', 'recovery runs'],
                    channel: ['1v1 defending', 'recovery runs', 'work rate'], chance: ['dribbling', 'pace', 'runs in behind'] }[why] || [];
    return [...new Set([...extra, ...base])].slice(0, 4);
  }

  function canPlay(p, role) {
    const pos = p.pos || [];
    if (pos.includes(role)) return 1;
    if (pos.some((r) => family(r) === family(role))) return 0.85;          // same job, other side (LCB for RCB)
    if (pos.some((r) => GROUP[r] === GROUP[role])) return 0.5;
    const g = { GK: 'GK', DF: 'DEF', MF: 'MID', FW: 'ATT' }[p.group];
    return g === GROUP[role] ? 0.45 : 0.1;
  }

  /* Bench players for `role`, best first: 55% position fit, 35% traits wanted, 10% foot. */
  function recommend(squad, xiIds, role, needs) {
    const inXI = new Set(Object.values(xiIds || {}));
    const isGK = role === 'GK';
    return squad.filter((p) => !inXI.has(p.id) && (p.group === 'GK') === isGK).map((p) => {
      const fit = canPlay(p, role);
      const keys = (p.keys || []).map((k) => k.toLowerCase());
      const hit = needs.filter((n) => keys.some((k) => k === n || k.includes(n) || n.includes(k)));
      const trait = Math.min(1, hit.length / Math.min(3, needs.length || 1));
      const s = side(role), foot = p.foot === 'L' ? (s === 'L' ? 1 : 0.4) : p.foot === 'R' ? (s === 'R' ? 1 : s === 'C' ? 0.7 : 0.4) : 0.5;
      const score = Math.round(100 * (0.55 * fit + 0.35 * trait + 0.1 * foot));
      const why = [];
      if (fit === 1) why.push(`plays ${role}`); else if (fit >= 0.85) why.push(`plays ${(p.pos || []).find((r) => family(r) === family(role))}`);
      else if (fit >= 0.45) why.push('same line');
      if (hit.length) why.push(hit.join(', '));
      if (p.foot === 'L' && s === 'L') why.push('left foot');
      return { id: p.id, name: p.name, num: p.num, score, fit, hit, why };
    }).sort((a, b) => b.score - a.score);
  }

  /* Plan B: ranked options. ctx fields (all optional):
       tired [{role, risk}], badDuel {def, att, behind}, oppLane 'left'|'middle'|'right' + oppShare,
       dangerA, regainNow, regainH1, drop {by, effect}, backFive {side, effect}, atkLane, atkFree,
       subs {role -> recommend() result}
     effect = {metric, before, after} measured by the app. */
  function planB(ctx) {
    const out = [];
    const pct = (v) => Math.round(v * 100) + '%';
    const t = (ctx.tired || [])[0];
    if (t && ctx.subs && ctx.subs[t.role] && ctx.subs[t.role][0]) {
      const c = ctx.subs[t.role][0];
      out.push({ kind: 'sub', score: 80 + t.risk / 5, title: `Bring on ${c.name} for ${t.label || t.role}`,
        why: `${t.role} fatigue risk ${t.risk}; ${c.name}: ${c.why.join(' · ') || 'fresh legs'} (match ${c.score})`, role: t.role, player: c.id });
    }
    if (ctx.badDuel && ctx.subs && ctx.subs[ctx.badDuel.def] && ctx.subs[ctx.badDuel.def][0] && (!t || t.role !== ctx.badDuel.def)) {
      const c = ctx.subs[ctx.badDuel.def][0];
      out.push({ kind: 'sub', score: 70 + ctx.badDuel.behind * 20, title: `Fix the ${ctx.badDuel.def} duel: ${c.name}`,
        why: `opponent ${ctx.badDuel.att} goal-side ${pct(ctx.badDuel.behind)} of the time; ${c.name}: ${c.why.join(' · ')}`, role: ctx.badDuel.def, player: c.id });
    }
    // a shape change is only proposed when the simulation says it helps (2+ points less control for them)
    const helps = (e) => e && e.after <= e.before - 0.02;
    if (ctx.drop && helps(ctx.drop.effect)) {
      const e = ctx.drop.effect;
      out.push({ kind: 'line', score: 68, title: `Drop the line ${ctx.drop.by} m`, effect: e,
        why: `their control in our third ${pct(e.before)} → ${pct(e.after)} in the last 30 s, less running back for tired centre-backs` });
    }
    if (ctx.backFive && helps(ctx.backFive.effect) && (ctx.dangerA >= 2 || (ctx.oppShare || 0) >= 0.5)) {
      const e = ctx.backFive.effect;
      const title = ctx.backFive.side === 'middle' ? 'Drop a midfielder between the centre-backs when defending'
        : `Back five on the ${ctx.backFive.side} when defending`;
      out.push({ kind: 'shape', score: 66 + (ctx.dangerA || 0), title, effect: e,
        why: `${ctx.oppLane ? `they come through our ${ctx.oppLane}` : `${ctx.dangerA} dangerous counters`}; their control in our third ${pct(e.before)} → ${pct(e.after)}` });
    }
    if (ctx.regainH1 != null && ctx.regainNow != null && ctx.regainNow < ctx.regainH1 - 0.03) {
      out.push({ kind: 'press', score: 55, title: 'Back to the first-half counter-press',
        why: `regains within 5 s ${pct(ctx.regainNow)} now vs ${pct(ctx.regainH1)} in the first half: two players on the ball at once after losing it` });
    }
    if (ctx.atkLane) {
      out.push({ kind: 'attack', score: 45, title: `Overload the ${ctx.atkLane}`,
        why: `${Math.round(ctx.atkFree || 0)} m of free space there in the last 30 s; full-back joins the winger` });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  const api = { TRAITS, GROUP, ROLE_NEEDS, family, needsFor, canPlay, recommend, planB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SB_DECIDE = api;
})(typeof window !== 'undefined' ? window : globalThis);

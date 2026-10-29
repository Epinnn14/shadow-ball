/* Static data for the kick-off setup: formations to pick from and a default squad the coach edits.
   No photos are bundled: player photos are copyrighted, so the coach adds them on the laptop and
   they stay on that laptop (exports/demo/lineup.json, never committed). */
(function () {
  'use strict';
  const B4 = ['LB', 'LCB', 'RCB', 'RB'], B3 = ['LCB', 'CB', 'RCB'], B5 = ['LWB', 'LCB', 'CB', 'RCB', 'RWB'];
  // lines from back to front, each from the team's left to right
  const FORMATIONS = {
    '4-3-3':     [B4, ['LCM', 'CM', 'RCM'], ['LW', 'ST', 'RW']],
    '4-2-3-1':   [B4, ['LCDM', 'RCDM'], ['LW', 'CAM', 'RW'], ['ST']],
    '4-2-1-3':   [B4, ['LCDM', 'RCDM'], ['CAM'], ['LW', 'ST', 'RW']],
    '4-4-2':     [B4, ['LM', 'LCM', 'RCM', 'RM'], ['CF', 'ST']],
    '4-1-4-1':   [B4, ['CDM'], ['LM', 'LCM', 'RCM', 'RM'], ['ST']],
    '4-4-1-1':   [B4, ['LM', 'LCM', 'RCM', 'RM'], ['CF'], ['ST']],
    '4-5-1':     [B4, ['LM', 'LCM', 'CM', 'RCM', 'RM'], ['ST']],
    '4-3-1-2':   [B4, ['LCM', 'CM', 'RCM'], ['CAM'], ['CF', 'ST']],
    '4-1-2-1-2': [B4, ['CDM'], ['LCM', 'RCM'], ['CAM'], ['CF', 'ST']],
    '4-2-2-2':   [B4, ['LCDM', 'RCDM'], ['LAM', 'RAM'], ['CF', 'ST']],
    '4-3-2-1':   [B4, ['LCM', 'CM', 'RCM'], ['LAM', 'RAM'], ['ST']],
    '3-5-2':     [B3, ['LWB', 'LCM', 'CM', 'RCM', 'RWB'], ['CF', 'ST']],
    '3-4-3':     [B3, ['LWB', 'LCM', 'RCM', 'RWB'], ['LW', 'ST', 'RW']],
    '3-4-2-1':   [B3, ['LWB', 'LCM', 'RCM', 'RWB'], ['LAM', 'RAM'], ['ST']],
    '3-4-1-2':   [B3, ['LWB', 'LCM', 'RCM', 'RWB'], ['CAM'], ['CF', 'ST']],
    '3-1-4-2':   [B3, ['CDM'], ['LWB', 'LCM', 'RCM', 'RWB'], ['CF', 'ST']],
    '5-3-2':     [B5, ['LCM', 'CM', 'RCM'], ['CF', 'ST']],
    '5-4-1':     [B5, ['LM', 'LCM', 'RCM', 'RM'], ['ST']],
  };

  // Slot positions in a 0..1 box: x = width from the team's left, y = depth from its own goal.
  function slots(name) {
    const lines = FORMATIONS[name];
    const out = [{ label: 'GK', x: 0.5, y: 0.05 }];
    const n = lines.length;
    lines.forEach((line, i) => {
      const y = 0.2 + (n === 1 ? 0 : i * (0.66 / (n - 1)));
      const m = line.length, spread = m === 1 ? 0 : Math.min(0.84, 0.18 * (m - 1) + (i === 0 ? 0.2 : 0.1));
      line.forEach((label, k) => {
        const x = m === 1 ? 0.5 : 0.5 - spread / 2 + k * spread / (m - 1);
        out.push({ label, x, y });
      });
    });
    return out;
  }

  // Default squad: FC Barcelona 2026/27 numbers as published by the club on 2 Sep 2026
  // (https://www.fcbarcelona.com/en/football/first-team/news/4570894/202627-first-team-jersey-numbers-confirmed).
  // Only a starting point: the coach edits names, numbers and the XI before kick-off.
  const SQUAD = [
    [1, 'Joan Garcia', 'GK'], [2, 'João Cancelo', 'DF'], [3, 'Alejandro Balde', 'DF'], [4, 'Brian Fariñas', 'MF'],
    [5, 'Pau Cubarsí', 'DF'], [6, 'Gavi', 'MF'], [7, 'Fermín López', 'MF'], [8, 'Pedri', 'MF'],
    [9, 'Gabriel Jesus', 'FW'], [10, 'Lamine Yamal', 'FW'], [11, 'Raphinha', 'FW'], [12, 'Xavi Espart', 'DF'],
    [13, 'Wojciech Szczęsny', 'GK'], [14, 'Karim Adeyemi', 'FW'], [15, 'Andreas Christensen', 'DF'],
    [16, 'Rodrigo', 'MF'], [17, 'Anthony Gordon', 'FW'], [18, 'Gerard Martín', 'DF'], [19, 'Roony Bardghji', 'FW'],
    [20, 'Dani Olmo', 'MF'], [21, 'Frenkie de Jong', 'MF'], [22, 'Marc Bernal', 'MF'], [23, 'Jules Koundé', 'DF'],
    [24, 'Eric García', 'DF'], [25, 'Dominik Livaković', 'GK'], [27, 'Jesse Bisiwu', 'FW'], [29, 'Hamza Abdelkarim', 'FW'],
  ].map(([num, name, group]) => ({ id: 'p' + num, num, name, group, photo: null }));

  // A first XI for the default 4-2-1-3 (the shape our tracking found for Barcelona in half 2)
  const DEFAULT_XI = { GK: 'p1', LB: 'p3', LCB: 'p5', RCB: 'p24', RB: 'p23', LCDM: 'p8', RCDM: 'p21',
                       CAM: 'p7', LW: 'p11', ST: 'p9', RW: 'p10' };

  window.SB_DATA = { FORMATIONS, slots, SQUAD, DEFAULT_XI };
})();

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
  // Positions, foot and the 3 keywords are a STARTING POINT for the coach, who knows his players and
  // edits them before kick-off (profile editor in the setup). Unknown details are left empty.
  // [number, name, group, positions it can play, foot, keywords]
  const SQUAD = [
    [1, 'Joan Garcia', 'GK', ['GK'], 'R', ['shot-stopping', 'sweeper', 'distribution']],
    [2, 'João Cancelo', 'DF', ['RB', 'LB', 'RWB'], 'R', ['overlap', 'crossing', 'press resistance']],
    [3, 'Alejandro Balde', 'DF', ['LB', 'LWB'], 'L', ['pace', 'overlap', 'recovery runs']],
    [4, 'Brian Fariñas', 'MF', ['CM', 'CDM'], null, ['work rate', 'passing', 'pressing']],
    [5, 'Pau Cubarsí', 'DF', ['LCB', 'RCB', 'CB'], 'R', ['passing', 'positioning', 'composure']],
    [6, 'Gavi', 'MF', ['CM', 'LCM', 'CAM'], 'R', ['pressing', 'ball winning', 'work rate']],
    [7, 'Fermín López', 'MF', ['CAM', 'CM', 'LW'], 'R', ['runs in behind', 'finishing', 'pressing']],
    [8, 'Pedri', 'MF', ['CM', 'LCM', 'CAM', 'LCDM'], 'R', ['press resistance', 'passing', 'creativity']],
    [9, 'Gabriel Jesus', 'FW', ['ST', 'CF', 'RW'], 'R', ['pressing', 'link-up', 'runs in behind']],
    [10, 'Lamine Yamal', 'FW', ['RW'], 'L', ['dribbling', 'creativity', 'left foot']],
    [11, 'Raphinha', 'FW', ['LW', 'RW'], 'L', ['pace', 'pressing', 'finishing']],
    [12, 'Xavi Espart', 'DF', [], null, ['work rate', 'positioning', 'passing']],
    [13, 'Wojciech Szczęsny', 'GK', ['GK'], 'R', ['shot-stopping', 'leadership', 'composure']],
    [14, 'Karim Adeyemi', 'FW', ['LW', 'RW', 'ST'], 'R', ['pace', 'runs in behind', 'dribbling']],
    [15, 'Andreas Christensen', 'DF', ['RCB', 'LCB', 'CB', 'CDM'], 'R', ['positioning', 'composure', 'passing']],
    [16, 'Rodrigo', 'MF', [], null, ['work rate', 'passing', 'pressing']],
    [17, 'Anthony Gordon', 'FW', ['LW'], 'R', ['pace', 'pressing', 'runs in behind']],
    [18, 'Gerard Martín', 'DF', ['LB', 'LCB'], 'L', ['left foot', 'overlap', 'versatility']],
    [19, 'Roony Bardghji', 'FW', ['RW'], 'L', ['dribbling', 'creativity', 'left foot']],
    [20, 'Dani Olmo', 'MF', ['CAM', 'LW', 'CF'], 'R', ['creativity', 'finishing', 'press resistance']],
    [21, 'Frenkie de Jong', 'MF', ['CM', 'RCDM', 'CDM'], 'R', ['press resistance', 'passing', 'composure']],
    [22, 'Marc Bernal', 'MF', ['CDM', 'RCDM'], 'R', ['holding', 'passing', 'positioning']],
    [23, 'Jules Koundé', 'DF', ['RB', 'RCB'], 'R', ['pace', 'recovery runs', '1v1 defending']],
    [24, 'Eric García', 'DF', ['RCB', 'LCB', 'RB', 'CDM'], 'R', ['passing', 'positioning', 'versatility']],
    [25, 'Dominik Livaković', 'GK', ['GK'], 'R', ['shot-stopping', 'composure', 'distribution']],
    [27, 'Jesse Bisiwu', 'FW', [], null, ['pace', 'dribbling', 'work rate']],
    [29, 'Hamza Abdelkarim', 'FW', ['ST'], null, ['finishing', 'aerial', 'runs in behind']],
  ].map(([num, name, group, pos, foot, keys]) => ({ id: 'p' + num, num, name, group, pos, foot, keys, photo: null }));

  // A first XI for the default 4-2-1-3 (the shape our tracking found for Barcelona in half 2)
  const DEFAULT_XI = { GK: 'p1', LB: 'p3', LCB: 'p5', RCB: 'p24', RB: 'p23', LCDM: 'p8', RCDM: 'p21',
                       CAM: 'p7', LW: 'p11', ST: 'p9', RW: 'p10' };

  window.SB_DATA = { FORMATIONS, slots, SQUAD, DEFAULT_XI };
})();

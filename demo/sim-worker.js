/* Runs SB_SIM.search off the main thread for the tactics board: every formation x style for your
   team against the opponent's current set-up, a few simulated 45-minute halves each. */
self.window = self;
importScripts('data.js?v=20261123a', 'threat.js?v=20261123a', 'sim.js?v=20261123a');
self.onmessage = (e) => {
  const o = e.data, TH = self.SB_THREAT;
  const res = self.SB_SIM.search(Object.assign({ surface: TH.surface, cell: TH.cell, slots: self.SB_DATA.slots }, o),
    (p) => self.postMessage({ progress: p }));
  self.postMessage({ done: res });
};

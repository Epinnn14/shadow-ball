"""Data files for the tactics playground (demo/laliga.js, demo/threat.js).

    python scripts/build_playground_data.py

- demo/laliga.js: LaLiga 2026/27 squads from data_src/laliga_2026_27.txt (names, shirt numbers and
  GK/DF/MF/FW groups as published by the clubs or Wikipedia; source and date kept per club). No
  logos, no photos. Kit colours are the clubs' usual colours as plain hex values.
- demo/threat.js: the threat surface (P(box within 10 s) per 5 m cell, attacking right) averaged
  over the three open Metrica games. Needs `python run.py --game METRICA-n offball` and `demo`
  for n = 1, 2, 3.
"""

import json
import os

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def squads():
    clubs, cur = [], None
    with open(os.path.join(REPO, "data_src", "laliga_2026_27.txt"), encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            if line.startswith("## "):
                short, name, src, asof, kit1, kit2 = line[3:].split("|")
                cur = {"id": short.lower().replace(" ", "-").replace("é", "e").replace("á", "a"), "short": short,
                       "name": name, "source": src, "as_of": asof, "kit": [kit1, kit2], "players": []}
                clubs.append(cur)
                continue
            num, group, name = line.split(";", 2)
            cur["players"].append({"num": None if num == "-" else int(num), "group": group, "name": name})
    for c in clubs:
        c["players"].sort(key=lambda p: ({"GK": 0, "DF": 1, "MF": 2, "FW": 3}[p["group"]], p["num"] if p["num"] is not None else 99))
    return clubs


def threat():
    grids, cell = [], None
    for n in (1, 2, 3):
        path = os.path.join(REPO, "exports", "metrica-{}".format(n), "demo", "clip.json")
        if not os.path.exists(path):
            raise SystemExit("missing {}: run python run.py --game METRICA-{} offball && ... demo".format(path, n))
        with open(path, encoding="utf-8") as handle:
            sh = json.load(handle)["shadow"]
        grids.append(np.array(sh["surface"], dtype=float))
        cell = sh.get("surface_cell", 5.0)
    surf = np.mean(grids, axis=0)
    return {"cell": cell, "pitch": [105.0, 68.0], "games": "Metrica Sports open sample games 1-3",
            "surface": np.round(surf, 4).tolist()}


def main():
    clubs = squads()
    with open(os.path.join(REPO, "demo", "laliga.js"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("/* LaLiga 2026/27 squads for the playground. Built by scripts/build_playground_data.py from\n"
                     "   data_src/laliga_2026_27.txt: names, numbers and GK/DF/MF/FW groups from each club's\n"
                     "   published list or its Wikipedia squad table (source + date per club). No logos or photos. */\n")
        handle.write("window.SB_LALIGA = " + json.dumps({"season": "2026/27", "clubs": clubs}, ensure_ascii=False) + ";\n")
    with open(os.path.join(REPO, "demo", "threat.js"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("/* Threat surface for the playground: P(ball reaches the box within 10 s) per 5 m cell, attacking\n"
                     "   right, averaged over the three open Metrica games. Built by scripts/build_playground_data.py. */\n")
        handle.write("window.SB_THREAT = " + json.dumps(threat()) + ";\n")
    print(len(clubs), "clubs,", sum(len(c["players"]) for c in clubs), "players")


if __name__ == "__main__":
    main()

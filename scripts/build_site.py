"""Build the public website (GitHub Pages) into docs/ from demo/ and one OPEN game's replay clip.

    python run.py --game METRICA-2 offball && python run.py --game METRICA-2 demo
    python scripts/build_site.py --game METRICA-2          # -> docs/ (commit it; Pages serves main /docs)

Pages: index.html (home), playground.html (tactics board), replay.html (the sample match; also
opens a viewer's own clip.json locally), calibrate.html (video calibration, runs in the browser).
The replay runs without the Python server (no laptop-phone sync). The competition match is never
built here: its data is licensed for the competition only. Also writes docs/body.html, the home page
without its <head>, for hosts that add their own page skeleton (a claude.ai Artifact).
"""

import argparse
import os
import re
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ("index.html", "replay.html", "playground.html", "calibrate.html")
ASSETS = ("style.css", "home.css", "playground.css", "theme.js", "i18n.js", "i18n-id.js", "data.js", "decide.js", "app.js",
          "playground.js", "home.js", "pitch.js", "model.js", "laliga.js", "threat.js", "sim.js", "sim-worker.js")
FLAG = "<script>window.SB_STATIC = true;</script>\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default="METRICA-2")
    ap.add_argument("--out", default=os.path.join(REPO, "docs"))
    args = ap.parse_args()
    game = args.game.upper()
    if not game.startswith("METRICA"):
        sys.exit("Only the open Metrica games are published; the competition match is licensed for the competition only.")
    clip = os.path.join(REPO, "exports", game.lower(), "demo", "clip.json")
    if not os.path.exists(clip):
        sys.exit("No clip for {}: run python run.py --game {} offball, then demo".format(game, game))

    os.makedirs(os.path.join(args.out, "data"), exist_ok=True)
    for name in ASSETS:
        shutil.copy(os.path.join(REPO, "demo", name), os.path.join(args.out, name))
    shutil.copy(clip, os.path.join(args.out, "data", "clip.json"))
    for n in ("1", "2", "3"):                            # the other open games, for replay.html?game=N
        other = os.path.join(REPO, "exports", "metrica-" + n, "demo", "clip.json")
        if os.path.exists(other) and "METRICA-" + n != game:
            shutil.copy(other, os.path.join(args.out, "data", "clip-{}.json".format(n)))
    for name in PAGES:
        with open(os.path.join(REPO, "demo", name), encoding="utf-8") as handle:
            html = handle.read()
        if name == "replay.html":                       # no Python server on a static host
            html = html.replace('<script src="data.js', FLAG + '<script src="data.js', 1)
        with open(os.path.join(args.out, name), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(html)
    open(os.path.join(args.out, ".nojekyll"), "w").close()   # serve files as they are

    with open(os.path.join(REPO, "demo", "index.html"), encoding="utf-8") as handle:
        home = handle.read()
    head = re.search(r"<head>(.*)</head>", home, re.S).group(1)
    keep = "".join(line + "\n" for line in head.splitlines() if line.startswith(("<title", "<link", "<script")))
    body = re.search(r"<body[^>]*>(.*)</body>", home, re.S).group(1)
    with open(os.path.join(args.out, "body.html"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(keep + '<div class="home">' + body.strip() + "</div>\n")
    print("site ->", args.out, "({:.1f} MB clip)".format(os.path.getsize(clip) / 1e6))


if __name__ == "__main__":
    main()

"""Builds demo/i18n-id.js (Indonesian) from data_src/i18n_id.py: exact phrases + regex patterns.
    python scripts/build_i18n.py"""
import json, os, runpy
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = runpy.run_path(os.path.join(REPO, "data_src", "i18n_id.py"))
with open(os.path.join(REPO, "demo", "i18n-id.js"), "w", encoding="utf-8", newline="\n") as h:
    h.write("/* Indonesian for demo/i18n.js. Built by scripts/build_i18n.py from data_src/i18n_id.py: edit that file. */\n")
    h.write("window.SB_I18N_ID = " + json.dumps({"words": src["WORDS"], "patterns": src["PATTERNS"]}, ensure_ascii=False, indent=0) + ";\n")
print(len(src["WORDS"]), "phrases,", len(src["PATTERNS"]), "patterns")

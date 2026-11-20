"""Smart Tagging: Metrica's automatic phases and set pieces, converted to video frames.

Times in the XML are seconds from frame 0 of the tactical video: frame = round(s * 25).
The tags are inferred, not ground truth: use them as evidence, never copy them as labels.
"""

import xml.etree.ElementTree as ET

from . import paths

TEAM_TO_SIDE = {"barcelona": "H", "atletic club": "A", "athletic club": "A"}


def load():
    """[{code, start, end, team, type}] with start/end as video frames (end exclusive).
    Open games have no Smart Tagging: their set pieces and goals come from Metrica's event data,
    for the demo only (see set_pieces)."""
    if paths.VIDEO:
        return []                       # a video has no tags: goals and set pieces are not known
    if paths.OPEN_DATA:
        return _open_game_tags()
    root = ET.parse(paths.asset("smart_tagging")).getroot()
    out = []
    for inst in root.iter("instance"):
        tags = {lab.findtext("group"): lab.findtext("text") for lab in inst.findall("label")}
        start_s = float(inst.findtext("start"))
        end_s = float(inst.findtext("end"))
        team = (tags.get("Team") or "").strip().lower()
        out.append({
            "code": (inst.findtext("code") or "").strip().upper(),
            "start": int(round(start_s * paths.FPS)),
            "end": int(round(end_s * paths.FPS)),
            "side": TEAM_TO_SIDE.get(team),          # 'H', 'A' or None (N/A, e.g. throw-ins)
            "type": (tags.get("Type") or "").strip(),
            "tags": tags,
        })
    return out


def set_pieces():
    """Set-piece hints for the possession labels. Open games return none: their events are tagged
    by people and also build the reference labels, so feeding them in would leak the answer."""
    if paths.OPEN_DATA or paths.VIDEO:
        return []
    return [e for e in load() if e["code"] == "SET PIECES"]


def _open_game_tags():
    from . import external
    ev = external.events(int(paths.GAME[-1]))
    out = []
    for r in ev.itertuples():
        if r.type == "SET PIECE":
            kind = next((v for k, v in external.SET_PIECE_TYPES.items() if k in r.subtype), "Free Kick")
            out.append({"code": "SET PIECES", "start": int(r.start), "end": int(r.end) + 1,
                        "side": r.side, "type": kind, "tags": {"Type": kind}})
        elif r.type == "SHOT" and "GOAL" in r.subtype and "OFF" not in r.subtype:
            out.append({"code": "GOALS", "start": int(r.start), "end": int(r.end) + 1,
                        "side": r.side, "type": "", "tags": {}})
    return out

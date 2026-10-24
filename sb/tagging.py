"""Smart Tagging: Metrica's automatic phases and set pieces, converted to video frames.

Times in the XML are seconds from frame 0 of the tactical video: frame = round(s * 25).
The tags are inferred, not ground truth: use them as evidence, never copy them as labels.
"""

import xml.etree.ElementTree as ET

from . import paths

TEAM_TO_SIDE = {"barcelona": "H", "atletic club": "A", "athletic club": "A"}


def load():
    """[{code, start, end, team, type}] with start/end as video frames (end exclusive)."""
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
    return [e for e in load() if e["code"] == "SET PIECES"]

# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Download the ESC-50 environmental sound set into data/backgrounds/esc50 (git-ignored).

ESC-50 (K. J. Piczak, 2015): 2000 five-second clips in 50 classes, 44.1 kHz mono.
Licence: CC BY-NC 3.0 (non-commercial). Used locally for false-alarm testing; never bundled.
https://github.com/karolpiczak/ESC-50
"""
import csv
import shutil
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/karolpiczak/ESC-50/archive/refs/heads/master.zip"
OUT = Path(__file__).resolve().parents[2] / "data" / "backgrounds" / "esc50"

# Classes that could plausibly be heard outdoors on a perimeter; the rest are kept but flagged.
OUTDOOR = {
    "wind", "rain", "thunderstorm", "sea_waves", "crackling_fire", "water_drops", "pouring_water",
    "crickets", "insects", "chirping_birds", "crow", "rooster", "hen", "dog", "cow", "sheep", "pig",
    "frog", "cat", "airplane", "helicopter", "train", "engine", "car_horn", "siren", "chainsaw",
    "hand_saw", "church_bells", "footsteps", "fireworks", "vacuum_cleaner",
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    zpath = OUT / "esc50.zip"
    if not zpath.exists():
        print(f"downloading {URL}")
        tmp = zpath.with_suffix(".part")
        with urllib.request.urlopen(URL) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, length=1 << 20)
        tmp.rename(zpath)
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():
            rel = name.split("/", 1)[1] if "/" in name else ""
            if not (rel.startswith("audio/") and rel.endswith(".wav")) and rel not in ("meta/esc50.csv", "LICENSE"):
                continue
            dest = OUT / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                with z.open(name) as src, open(dest, "wb") as f:
                    shutil.copyfileobj(src, f)
    rows = list(csv.DictReader(open(OUT / "meta" / "esc50.csv")))
    with open(OUT / "manifest.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["file", "category", "fold", "outdoor"])
        for r in rows:
            w.writerow([f"audio/{r['filename']}", r["category"], r["fold"], int(r["category"] in OUTDOOR)])
    (OUT / "LICENCE.txt").write_text(
        "ESC-50: Dataset for Environmental Sound Classification, K. J. Piczak, 2015.\n"
        "Licence: Creative Commons Attribution-NonCommercial 3.0 (CC BY-NC 3.0).\n"
        "Source: https://github.com/karolpiczak/ESC-50\n"
        "Local use only for false-alarm testing; do not commit or bundle.\n"
    )
    zpath.unlink()
    n_out = sum(r["category"] in OUTDOOR for r in rows)
    print(f"{len(rows)} clips in {OUT} ({n_out} in outdoor classes)")


if __name__ == "__main__":
    main()

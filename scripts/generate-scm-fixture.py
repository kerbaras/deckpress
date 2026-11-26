#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import subprocess
import sys


SOURCE_COMMIT = "0da09b729814aa5aafde024b5a6059624fa87951"
ASSETS = Path(__file__).resolve().parents[1] / "packages/core/assets/scm"
GAP_MM = 1.25
MM_PER_INCH = 25.4


def write_fixture(metadata, layouts):
    lines = ["{"]
    for key, value in metadata.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value)},")
    lines.append('  "layouts": [')
    for i, (fields, rects) in enumerate(layouts):
        lines.append("    {")
        for key, value in fields.items():
            lines.append(f"      {json.dumps(key)}: {json.dumps(value)},")
        lines.append('      "trimRects": [')
        lines.append(",\n".join(f"        {json.dumps(rect)}" for rect in rects))
        lines.append("      ]")
        lines.append("    }" + ("," if i + 1 < len(layouts) else ""))
    lines.extend(["  ]", "}"])
    (ASSETS / "trim-rects.json").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Generate trim rectangles from pinned SCM.")
    parser.add_argument("scm_checkout", type=Path)
    scm = parser.parse_args().scm_checkout.resolve()
    commit = subprocess.check_output(
        ["git", "-C", scm, "rev-parse", "HEAD"], text=True
    ).strip()
    changed = subprocess.check_output(
        [
            "git", "-C", scm, "status", "--porcelain", "--", "assets/layouts.json",
            "page_manager.py", "size_convert.py", "enums.py",
        ],
        text=True,
    )
    if commit != SOURCE_COMMIT or changed:
        parser.error(f"SCM must be an unmodified checkout of {SOURCE_COMMIT}")
    source = (ASSETS / "layouts.json").read_bytes()
    if source != (scm / "assets/layouts.json").read_bytes():
        parser.error("Vendored layouts.json differs from the pinned SCM source")

    sys.path.insert(0, str(scm))
    from enums import Orientation
    import page_manager
    from size_convert import size_to_mm

    config = json.loads(source)
    ppi = config["ppi"]
    default_reg = config["defaults"]["registration"]["default"]
    arm_mm = size_to_mm(default_reg["length"])
    exclusion_mm = arm_mm + page_manager.REG_PADDING_MM
    layouts = []
    for paper_id, cards in sorted(config["layouts"].items()):
        paper = config["paper_sizes"][paper_id]
        for card_id, variants in sorted(cards.items()):
            if "default" not in variants:
                continue
            card = config["card_sizes"][card_id]
            default = variants["default"]
            orientation = Orientation(default["orientation"])
            reg = default_reg | default.get("registration", {})
            px = page_manager.generate_layout(
                orientation=orientation,
                card_width=card["width"],
                card_height=card["height"],
                paper_width=paper["width"],
                paper_height=paper["height"],
                inset=reg["inset"],
                length=f"{exclusion_mm}mm",
                ppi=ppi,
            )
            columns, rows = len(px.x_pos), len(px.y_pos)
            layout_id = f"{paper_id}-{card_id}"
            if (columns, rows) != (default["num_cols"], default["num_rows"]):
                raise ValueError(f"{layout_id}: generated grid differs from layouts.json")

            paper_w, paper_h = map(size_to_mm, (paper["width"], paper["height"]))
            if orientation == Orientation.PORTRAIT:
                paper_w, paper_h = paper_h, paper_w
            card_w, card_h = map(size_to_mm, (card["width"], card["height"]))
            x0 = (paper_w - columns * card_w - (columns - 1) * GAP_MM) / 2
            y0 = (paper_h - rows * card_h - (rows - 1) * GAP_MM) / 2
            rects = []
            for row, y in enumerate(px.y_pos):
                for col, x in enumerate(px.x_pos):
                    pixel_rect = [x, y, px.card_width_px, px.card_height_px]
                    exact_rect = [
                        x0 + col * (card_w + GAP_MM),
                        y0 + row * (card_h + GAP_MM),
                        card_w,
                        card_h,
                    ]
                    rects.append({
                        "exactMm": [round(value, 12) for value in exact_rect],
                        "scmPx": pixel_rect,
                        "scmMm": [round(value * MM_PER_INCH / ppi, 12) for value in pixel_rect],
                    })
            layouts.append(({
                "id": layout_id,
                "paper": paper_id,
                "card": card_id,
                "orientation": orientation.value,
                "paperMm": [round(paper_w, 12), round(paper_h, 12)],
                "paperPx": [px.paper_width_px, px.paper_height_px],
                "columns": columns,
                "rows": rows,
                "insetMm": size_to_mm(reg["inset"]),
                "drawnArmMm": size_to_mm(reg["length"]),
            }, rects))

    if ppi != 300 or len(layouts) != 114:
        raise ValueError(f"Expected 114 layouts at 300 PPI, got {len(layouts)} at {ppi} PPI")
    write_fixture({
        "scmCommit": SOURCE_COMMIT,
        "ppi": ppi,
        "gapMm": GAP_MM,
        "rectFields": ["x", "y", "width", "height"],
        "gridExclusion": {
            "defaultArmMm": arm_mm,
            "paddingMm": page_manager.REG_PADDING_MM,
            "totalMm": exclusion_mm,
            "note": "SCM generate_layout uses the default arm plus padding, not drawnArmMm.",
        },
    }, layouts)


if __name__ == "__main__":
    main()

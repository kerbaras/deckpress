"""Bundle byte-identical cut files from the pinned Silhouette Card Maker checkout."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo

SCM_COMMIT = "0da09b729814aa5aafde024b5a6059624fa87951"
ASSETS = Path(__file__).resolve().parents[1] / "packages/core/assets/scm"


def bundle(checkout):
    commit = subprocess.check_output(
        ["git", "-C", checkout, "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != SCM_COMMIT:
        raise SystemExit(f"Expected SCM {SCM_COMMIT}, got {commit}")

    def upstream(path):
        return subprocess.check_output(
            ["git", "-C", checkout, "show", f"{commit}:{path}"]
        )

    layouts = upstream("assets/layouts.json")
    if layouts != (ASSETS / "layouts.json").read_bytes():
        raise SystemExit("Update the SCM geometry before bundling cut files")
    if upstream("LICENSE.md") != (ASSETS / "LICENSE.md").read_bytes():
        raise SystemExit("Update the SCM license before bundling cut files")

    files = {}
    exceptions = []
    for paper, cards in json.loads(layouts)["layouts"].items():
        for card, variants in cards.items():
            for variant, template in variants.items():
                borderless = variant == "borderless"
                stem = f"{paper}-{card}{'-borderless' if borderless else ''}-v{template['version']}"
                name = f"{stem}.studio3"
                if borderless and paper in ("a3", "arch_b"):
                    exceptions.append(stem)
                else:
                    files[name] = f"borderless/{name}" if borderless else name

    entries = {}
    with ZipFile(ASSETS / "cutting-templates.zip", "w") as archive:
        for name, path in sorted(files.items()):
            data = upstream(f"cutting_templates/{path}")
            entries[name] = {"path": path, "sha256": hashlib.sha256(data).hexdigest()}
            archive.writestr(ZipInfo(path), data)
    inventory = subprocess.check_output(
        ["git", "-C", checkout, "ls-tree", "-r", "--name-only", commit, "cutting_templates"],
        text=True,
    ).splitlines()
    manifest = {
        "commit": commit,
        "files": [path.removeprefix("cutting_templates/") for path in inventory if path.endswith(".studio3")],
        "exports": entries,
        "exceptions": sorted(exceptions),
    }
    (ASSETS / "cutting-templates.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    bundle(sys.argv[1])

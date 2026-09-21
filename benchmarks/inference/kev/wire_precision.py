"""What the /v1/systemone wire format costs, measured on an existing local run.

`kev/api.py` rounds every probability it serves to two decimals (`r2`). The
recorded hosted TypeSafe response in the gateway's adapter test carries values
at the same precision, so this looks like the contract's precision rather than
a Kev defect -- but it is precision the in-process path does not lose, and a
77-option `choice` puts most of its distribution below the rounding floor.

This replays a completed local run's full-precision rows through the same
rounding the server would apply, and rescores them with upstream's own
`metrics`. Same records, same model, same checkpoint: the only difference is
the wire format. Nothing is served and no model is loaded.

Usage:
    python benchmarks/inference/kev/wire_precision.py ~/.local/share/weave/kev/runs/kev-4b-fp32
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def r2(x: float) -> float:
    """kev.api.r2, copied so this runs without importing the server."""
    return round(float(x), 2)


def through_the_wire(row: dict) -> list[float]:
    """The distribution a client reconstructs from a served answer.

    `noul` is sent as a single rounded p(true) and the client derives the
    complement, so it quantises but cannot fail to sum. `choice` and `score`
    send every option rounded independently, and the client renormalises.
    """
    p = row["p"]
    if row["type"] == "noul":
        true_index = row["keys"].index("true")
        p_true = r2(p[true_index])
        return [p_true if i == true_index else 1 - p_true for i in range(len(p))]
    rounded = [r2(v) for v in p]
    total = sum(rounded)
    if total <= 0:
        # Every option rounded to zero; the client has nothing to renormalise.
        return [1 / len(rounded)] * len(rounded)
    return [v / total for v in rounded]


def main() -> int:
    run = Path(sys.argv[1])
    kev_home = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
    sys.path.insert(0, str(kev_home / "src"))
    from kev.benchmark import metrics

    rows = json.loads((run / "rows.json").read_text())
    wired = [{**row, "p": through_the_wire(row)} for row in rows]

    clean = [r for r in rows if r["variant"] == "clean"]
    clean_wired = [r for r in wired if r["variant"] == "clean"]

    def collapsed(rs):
        """Rows whose true label was rounded away entirely."""
        return sum(1 for r in rs if r["p"][r["label"]] == 0)

    exact, coarse = metrics(clean), metrics(clean_wired)
    changed = sum(1 for a, b in zip(clean, clean_wired)
                  if max(range(len(a["p"])), key=a["p"].__getitem__)
                  != max(range(len(b["p"])), key=b["p"].__getitem__))

    report = {
        "run": str(run),
        "clean_questions": len(clean),
        "argmax_changed_by_rounding": changed,
        "label_probability_rounded_to_zero": {
            "in_process": collapsed(clean), "over_the_wire": collapsed(clean_wired)},
        "in_process": {k: exact[k] for k in ("acc", "nll", "brier", "ece", "mean_conf")},
        "over_the_wire": {k: coarse[k] for k in ("acc", "nll", "brier", "ece", "mean_conf")},
        "by_option_count": {},
    }
    for label, lo, hi in (("2-5 options", 2, 5), ("6-20 options", 6, 20), ("21+ options", 21, 10**6)):
        bucket = [(a, b) for a, b in zip(clean, clean_wired) if lo <= len(a["keys"]) <= hi]
        if not bucket:
            continue
        report["by_option_count"][label] = {
            "questions": len(bucket),
            "acc_in_process": metrics([a for a, _ in bucket])["acc"],
            "acc_over_the_wire": metrics([b for _, b in bucket])["acc"],
            "label_zeroed_over_the_wire": collapsed([b for _, b in bucket]),
        }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

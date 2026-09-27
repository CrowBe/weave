"""Read-only paired accuracy analysis for the local Decider-2B transfer run."""

from collections import defaultdict
import json
import math
from pathlib import Path


HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "transfer-results.json").read_text())["rows"]
if len(rows) != 125 or len({row["id"] for row in rows}) != 125:
    raise ValueError("analysis requires 125 distinct paired cases")


def counts(items):
    return len(items), sum(row["correct"] for row in items), sum(row["jev_correct"] for row in items), sum(row["kev_correct"] for row in items)


def paired(reference):
    both = sum(row["correct"] and row[f"{reference}_correct"] for row in rows)
    decider_only = sum(row["correct"] and not row[f"{reference}_correct"] for row in rows)
    reference_only = sum(not row["correct"] and row[f"{reference}_correct"] for row in rows)
    neither = sum(not row["correct"] and not row[f"{reference}_correct"] for row in rows)
    n = decider_only + reference_only
    p = min(1, 2 * sum(math.comb(n, k) for k in range(min(decider_only, reference_only) + 1)) / 2**n) if n else 1
    return both, decider_only, reference_only, neither, p


print("n / Decider correct / Jev correct / Kev correct")
print("overall", counts(rows))
for reference in ("jev", "kev"):
    print(f"paired with {reference}: both, Decider only, {reference} only, neither, exact two-sided p", paired(reference))

for field in ("type", "source"):
    groups = defaultdict(list)
    for row in rows:
        groups[row[field]].append(row)
    print(f"\nby {field}")
    for key, items in sorted(groups.items()):
        print(key, counts(items))

"""Join 4B Score outputs with the paired 2B and Jev ordinal predictions."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "benchmarks/inference/decider-4b/transfer-results.json"
DECIDER_2B = ROOT / "benchmarks/inference/decider-2b/transfer-results.json"
JEV = ROOT / "benchmarks/inference/jev/transfer-results.json"
OUTPUT = ROOT / "benchmarks/inference/decider-4b/score-comparison.json"


def rows_by_id(path):
    payload = json.loads(path.read_text())
    rows = payload if isinstance(payload, list) else payload["rows"]
    indexed = {row["id"]: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError(f"duplicate IDs in {path}")
    return indexed


def main():
    current = rows_by_id(RESULTS)
    decider_2b = rows_by_id(DECIDER_2B)
    jev = rows_by_id(JEV)
    score_rows = [row for row in current.values() if row["type"] == "score"]
    if len(current) != 125 or len(decider_2b) != 125 or len(jev) != 125:
        raise ValueError("all three transfer runs must contain exactly 125 paired IDs")
    if set(current) != set(decider_2b) or set(current) != set(jev) or len(score_rows) != 10:
        raise ValueError("transfer runs must have identical IDs and ten Score cases")

    rows = []
    for row in score_rows:
        ident = row["id"]
        two_b = decider_2b[ident]
        jev_row = jev[ident]
        label = int(row["label"])
        if two_b["type"] != "score" or jev_row["type"] != "score" or int(two_b["label"]) != label or int(jev_row["label"]) != label:
            raise ValueError(f"Score metadata differs for {ident}")
        rows.append({
            "id": ident,
            "source": row["source"],
            "label": label,
            "decider_4b": {
                "expected_score": row["answer"]["score"],
                "predicted_ordinal": row["predicted"],
                "ordinal_absolute_error": abs(int(row["predicted"]) - label),
                "expected_score_absolute_error": row["score_error"],
            },
            "decider_2b": {
                "expected_score": two_b["answer"]["score"],
                "predicted_ordinal": two_b["predicted"],
                "ordinal_absolute_error": abs(int(two_b["predicted"]) - label),
                "expected_score_absolute_error": two_b["score_error"],
            },
            "jev": {
                "predicted_ordinal": jev_row["predicted"],
                "ordinal_absolute_error": abs(int(jev_row["predicted"]) - label),
            },
        })

    def metrics(model_key):
        errors = [row[model_key]["ordinal_absolute_error"] for row in rows]
        return {"n": len(errors), "ordinal_absolute_error_total": sum(errors),
                "ordinal_absolute_error_mean": round(sum(errors) / len(errors), 4),
                "ordinal_exact": sum(error == 0 for error in errors)}

    source_names = sorted({row["source"] for row in rows})
    report = {
        "status": "ordinal Score comparison on the ten paired transfer cases",
        "rows": rows,
        "overall": {key: metrics(key) for key in ("decider_4b", "decider_2b", "jev")},
        "by_source": {
            source: {
                model_key: {
                    "n": len([row for row in rows if row["source"] == source]),
                    "ordinal_absolute_error_total": sum(row[model_key]["ordinal_absolute_error"] for row in rows if row["source"] == source),
                }
                for model_key in ("decider_4b", "decider_2b", "jev")
            }
            for source in source_names
        },
    }
    OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(OUTPUT), "overall": report["overall"]}, indent=2))


if __name__ == "__main__":
    main()

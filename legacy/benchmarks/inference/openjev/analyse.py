"""Post-process a transfer.py result file. No model, no new inference.

Answers three questions the accuracy number alone cannot:

  calibration  when the model states a confidence, is it earned?
  contrast     does the answer move when the decision-relevant field moves,
               and hold still when an irrelevant one does?
  ranking      for boolean questions, is the signal present but discarded by
               the fixed argmax decision rule?

The ranking question matters most. transfer.py predicts true only when
entailment is the strict argmax of three labels. That threshold is fixed by
the checkpoint's head, not chosen for the task, so a source can separate
perfectly under AUC and still score at its floor under argmax.
"""
import argparse, collections, json, math, os, random, statistics
from pathlib import Path

KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))


def confidence(row):
    """Probability the model assigns to the answer it actually gave.

    choice: renormalise entailment across options; the per-option scores are
    independent softmaxes and do not sum to one.
    noul: the rule collapses {contradiction, neutral} into false, so the
    confidence in a false answer is their sum.
    """
    if row["kind"] == "choice":
        ents = {k: v["entailment"] for k, v in row["scores"].items()}
        total = sum(ents.values())
        return ents[row["predicted"]] / total if total > 0 else 1.0 / len(ents)
    p = row["p_entailment"]
    return p if row["predicted"] else 1.0 - p


def ece(pairs, bins=10):
    """Expected calibration error over equal-width bins, with the bin table."""
    buckets = collections.defaultdict(list)
    for c, ok in pairs:
        buckets[min(int(c * bins), bins - 1)].append((c, ok))
    err, table = 0.0, []
    for b in sorted(buckets):
        got = buckets[b]
        conf = statistics.fmean(c for c, _ in got)
        acc = statistics.fmean(1.0 if ok else 0.0 for _, ok in got)
        err += len(got) / len(pairs) * abs(conf - acc)
        table.append({"bin": f"{b / bins:.1f}-{(b + 1) / bins:.1f}", "n": len(got),
                      "mean_confidence": round(conf, 3), "accuracy": round(acc, 3),
                      "gap": round(conf - acc, 3)})
    return err, table


def auc(pairs):
    """Mann-Whitney U, ties counted as half. Threshold-free by construction."""
    pos = [s for s, y in pairs if y]
    neg = [s for s, y in pairs if not y]
    if not pos or not neg:
        return None
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


def best_threshold(pairs):
    """Upper bound on what recalibration could buy. Fitted on these same
    records, so it is optimistic and must not be quoted as an accuracy."""
    best = (0.0, None)
    for t in sorted({s for s, _ in pairs}):
        acc = statistics.fmean(1.0 if ((s >= t) == y) else 0.0 for s, y in pairs)
        if acc > best[0]:
            best = (acc, t)
    return best


def auc_interval(pairs, rng, resamples, permutations):
    """Bootstrap CI over records, and a permutation p-value against the null
    that the scores carry no ordering information."""
    observed = auc(pairs)
    boots = []
    for _ in range(resamples):
        v = auc([rng.choice(pairs) for _ in pairs])
        if v is not None:
            boots.append(v)
    boots.sort()
    labels = [y for _, y in pairs]
    scores = [s for s, _ in pairs]
    hits = 0
    for _ in range(permutations):
        rng.shuffle(labels)
        if auc(list(zip(scores, labels))) >= observed:
            hits += 1
    return {
        "auc": round(observed, 4),
        "bootstrap_95": [round(boots[int(.025 * len(boots))], 4),
                         round(boots[int(.975 * len(boots))], 4)],
        "permutation_p": round((hits + 1) / (permutations + 1), 6),
    }


def calibration(rows):
    out = {}
    for name, keep in (("all", lambda r: True),
                       ("choice", lambda r: r["kind"] == "choice"),
                       ("noul", lambda r: r["kind"] == "noul")):
        got = [(confidence(r), r["correct"]) for r in rows if keep(r)]
        if not got:
            continue
        err, table = ece(got)
        out[name] = {
            "n": len(got),
            "accuracy": round(statistics.fmean(1.0 if ok else 0.0 for _, ok in got), 4),
            "mean_confidence": round(statistics.fmean(c for c, _ in got), 4),
            "ece_10_bin": round(err, 4),
            "brier": round(statistics.fmean((c - (1.0 if ok else 0.0)) ** 2 for c, ok in got), 4),
            "bins": table,
        }
    return out


def contrast(rows, suite):
    """Composition records come in <scenario>/<arm>/<a|b> groups: the relevant
    arm perturbs a field the policy depends on, the irrelevant arm one it does
    not. Some records are shared between arms and must agree bit for bit."""
    by_id = {r["id"]: r for r in rows}
    arms = collections.defaultdict(dict)
    for rid in by_id:
        if rid.startswith("composition/"):
            head, arm, member = rid.rsplit("/", 2)
            arms[(head, arm)][member] = rid

    tally = collections.defaultdict(lambda: {"n": 0, "ok": 0})
    missed = []
    for (head, arm), members in sorted(arms.items()):
        if set(members) != {"a", "b"}:
            continue
        ra, rb = by_id[members["a"]], by_id[members["b"]]
        if suite[members["a"]]["state"] == suite[members["b"]]["state"]:
            continue                       # same input; covered by the duplicate check
        moved = ra["predicted"] != rb["predicted"]
        if ra["label"] != rb["label"]:
            kind, ok = "relevant_change_answer_must_move", moved
            if not ok:
                missed.append({"group": f"{head}/{arm}",
                               "labels": [ra["label"], rb["label"]],
                               "predicted": [ra["predicted"], rb["predicted"]]})
        else:
            kind, ok = "irrelevant_change_answer_must_hold", not moved
        cell = tally[(ra["src"], kind)]
        cell["n"] += 1
        cell["ok"] += 1 if ok else 0

    duplicates = identical = 0
    for head in {h for h, _ in arms}:
        a = arms.get((head, "relevant"), {}).get("a")
        b = arms.get((head, "irrelevant"), {}).get("a")
        if a and b and suite[a]["state"] == suite[b]["state"]:
            duplicates += 1
            identical += by_id[a]["scores"] == by_id[b]["scores"]

    return {
        "by_source": {f"{src}/{kind}": v for (src, kind), v in sorted(tally.items())},
        "totals": {
            kind: {"n": sum(v["n"] for (_, k), v in tally.items() if k == kind),
                   "ok": sum(v["ok"] for (_, k), v in tally.items() if k == kind)}
            for kind in ("relevant_change_answer_must_move",
                         "irrelevant_change_answer_must_hold")},
        "missed_flips": missed,
        "duplicate_records_across_arms": duplicates,
        "of_those_bit_identical_scores": identical,
    }


def ranking(rows, rng, resamples, permutations):
    noul = [r for r in rows if r["kind"] == "noul"]
    by_src = collections.defaultdict(list)
    for r in noul:
        by_src[r["src"]].append((r["p_entailment"], bool(r["label"])))
    by_src["all_noul"] = [(r["p_entailment"], bool(r["label"])) for r in noul]

    out = {}
    for src, pairs in sorted(by_src.items()):
        got = noul if src == "all_noul" else [r for r in noul if r["src"] == src]
        labels = [y for _, y in pairs]
        acc, thr = best_threshold(pairs)
        out[src] = {
            "n": len(pairs),
            "argmax_accuracy": round(statistics.fmean(
                1.0 if r["correct"] else 0.0 for r in got), 4),
            "majority_floor": round(max(labels.count(True), labels.count(False)) / len(pairs), 4),
            **auc_interval(pairs, rng, resamples, permutations),
            "best_threshold_accuracy_optimistic": round(acc, 4),
            "best_threshold": None if thr is None else round(thr, 4),
        }

    groups = collections.defaultdict(list)
    for r in noul:
        if r["src"] == "contrastive_authorization":
            groups[r["group_id"]].append(r)
    complete = [g for g in groups.values() if len(g) == 2]
    if complete:
        right = sum(1 for g in complete
                    if max(g, key=lambda r: r["p_entailment"])["label"] is True)
        out["contrastive_authorization"]["within_pair_ranking"] = {
            "pairs": len(complete), "correct": right,
            "exact_one_sided_p": round(1 / math.comb(len(complete) * 2, len(complete)), 10)
            if right == len(complete) else None,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, required=True,
                    help="a transfer.py --output file")
    ap.add_argument("--suite", type=Path,
                    default=KEV_HOME / "src/evals/v4/transfer-v4/development.jsonl")
    ap.add_argument("--exclude-source", default="emotion",
                    help="comma list; excluded from every statistic")
    ap.add_argument("--seed", type=int, default=20260920)
    ap.add_argument("--resamples", type=int, default=10000)
    ap.add_argument("--permutations", type=int, default=20000)
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()

    dropped = {s for s in args.exclude_source.split(",") if s}
    source = json.loads(args.results.read_text())
    rows = [r for r in source["rows"] if r["src"] not in dropped]
    suite = {}
    for line in args.suite.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            suite[r["_meta"]["id"]] = r

    rng = random.Random(args.seed)
    report = {
        "results_file": str(args.results),
        "excluded_sources": sorted(dropped),
        "rows_analysed": len(rows),
        "calibration": calibration(rows),
        "contrast": contrast(rows, suite),
        "ranking": ranking(rows, rng, args.resamples, args.permutations),
    }
    text = json.dumps(report, indent=1)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()

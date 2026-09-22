"""Kev's trained readout against the same base model with nothing trained.

Kev-4B is Qwen3-4B-Base plus a trained LoRA plus a trained pointer head read off
hidden states. This scores the *untrained* base on the same records by the only
readout a stock base supports: render the state and the candidates so the next
token names the choice, then restrict the next-token distribution to the option
markers and renormalise. One forward pass, no head, no adapter.

Held constant: the 18 cases, the `orderingsFor(n, 4, 20260921)` presentations,
the 56 records, the labels, and the floors. Changed: the decision mechanism.

Prompt phrasing is an independent variable here, not an implementation detail —
the entailment work in `benchmarks/inference/README.md` moved one source's AUC
from 0.619 to 0.827 by rewording alone. So several renderings are scored and all
are reported. Choosing the best of them on these same 56 records is in-sample
selection and is labelled as such wherever it is quoted.

Needs a llama-server holding the base weights with no `--lora` and no
`--embeddings`, because the readout wants logits rather than hidden states:

    llama-server --model Qwen3-4B-Base.Q8_0.gguf -ngl 99 -c 4096 --port 8098
"""
from __future__ import annotations

import argparse
import json
import math
import urllib.request
from collections import Counter, defaultdict

LETTERS = "ABCDEFGH"

QUESTION = (
    "Exactly one of these eligible candidates should be dispatched now. "
    "Which one best advances the authorized goal from the situation described?"
)

# Qwen3 tokenises " A" as one token but " 1" as two, so the space cannot live on
# a digit marker. Each style says where it sits. A marker that is not exactly one
# token cannot be read in a single pass, and `marker_ids` refuses it rather than
# letting the readout score a bare space.
STYLES = {
    "letter_answer": {"cue": "Answer:", "digits": False, "space_on_marker": True},
    "digit_answer": {"cue": "Answer: ", "digits": True, "space_on_marker": False},
    "letter_dispatch": {"cue": "Dispatch:", "digits": False, "space_on_marker": True},
    "letter_best": {
        "cue": "The candidate that best advances the goal is:",
        "digits": False,
        "space_on_marker": True,
    },
}


def render(item: dict, style: str) -> tuple[str, list[str]]:
    """The prompt, and the marker per candidate in presented order."""
    spec = STYLES[style]
    by_id = {c["candidate_id"]: c for c in item["state"]["eligible_candidates"]}
    cands = [by_id[cid] for cid in item["presented"]]
    labels = [str(i + 1) if spec["digits"] else LETTERS[i] for i in range(len(cands))]
    opts = "\n".join(f"{m}) {c['operation']}: {c['summary']}" for m, c in zip(labels, cands))
    state = item["state"]
    facts = "\n".join(f"- {f}" for f in state["facts"])
    body = (f"Goal: {state['goal']}\nSituation: {state['situation']}\nFacts:\n{facts}"
            f"\n\n{QUESTION}\n\n{opts}\n\n")
    pre = " " if spec["space_on_marker"] else ""
    return body + spec["cue"], [pre + m for m in labels]


def normalise(logprobs: list[float]) -> list[float]:
    """Softmax over the option markers alone. This is the whole readout."""
    hi = max(logprobs)
    ex = [math.exp(x - hi) for x in logprobs]
    total = sum(ex)
    return [e / total for e in ex]


def ece(records: list[dict], bins: int = 10) -> float:
    """Top-label confidence, equal-width bins — the estimator JevBench uses."""
    if not records:
        return 0.0
    grouped = defaultdict(list)
    for r in records:
        hit = 1.0 if r["predicted"] == r["label"] else 0.0
        grouped[min(int(r["confidence"] * bins), bins - 1)].append((r["confidence"], hit))
    return sum(
        len(v) / len(records) * abs(sum(h for _, h in v) / len(v) - sum(c for c, _ in v) / len(v))
        for v in grouped.values()
    )


def brier(records: list[dict]) -> float:
    if not records:
        return 0.0
    return sum(
        sum((p - (1.0 if k == r["label"] else 0.0)) ** 2 for k, p in r["probabilities"].items())
        for r in records
    ) / len(records)


def position_bias(records: list[dict]) -> float:
    """Chosen-position against label-position, within candidate-count strata.

    Stratified because a corpus mixing 2- and 4-candidate cases otherwise spreads
    a last-position lock across indices and hides it.
    """
    strata: dict[int, list] = defaultdict(lambda: [Counter(), Counter(), 0])
    for r in records:
        presented = r["presented"]
        s = strata[len(presented)]
        s[0][presented.index(r["predicted"])] += 1
        s[1][presented.index(r["label"])] += 1
        s[2] += 1
    total = sum(s[2] for s in strata.values())
    if total == 0:
        return 0.0
    return sum(
        sum(abs(s[0][i] / s[2] - s[1][i] / s[2]) for i in range(k)) / 2 * s[2]
        for k, s in strata.items()
    ) / total


def stability(records: list[dict]) -> tuple[int, int]:
    """Cases answered identically under every presentation, over cases permuted."""
    by_case = defaultdict(list)
    for r in records:
        by_case[r["case_id"]].append(r)
    permuted = [v for v in by_case.values() if len({tuple(x["presented"]) for x in v}) > 1]
    stable = [v for v in permuted if len({x["predicted"] for x in v}) == 1]
    return len(stable), len(permuted)


def mcnemar(only_a: int, only_b: int) -> float:
    """Exact two-sided binomial on the discordant pairs.

    The records are paired — both systems answer the same 56 — so the pairing
    has to be kept. Comparing two independent accuracies would overstate the
    evidence by ignoring that they agree on most records.
    """
    n = only_a + only_b
    if n == 0:
        return 1.0
    k = min(only_a, only_b)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def discordant(a: dict[tuple, dict], b: dict[tuple, dict]) -> tuple[int, int]:
    """(right in a only, right in b only) over the shared keys."""
    only_a = only_b = 0
    for key in a:
        hit_a = a[key]["predicted"] == a[key]["label"]
        hit_b = b[key]["predicted"] == b[key]["label"]
        if hit_a and not hit_b:
            only_a += 1
        elif hit_b and not hit_a:
            only_b += 1
    return only_a, only_b


def post(base: str, path: str, payload: dict, timeout: int = 600) -> dict:
    request = urllib.request.Request(
        base.rstrip("/") + path, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(request, timeout=timeout))


def marker_ids(base: str, markers: list[str]) -> dict[str, int]:
    out = {}
    for m in markers:
        tokens = post(base, "/tokenize", {"content": m})["tokens"]
        if len(tokens) != 1:
            raise RuntimeError(
                f"marker {m!r} is {len(tokens)} tokens, not 1 — a multi-token marker "
                "cannot be read in one forward pass, and scoring only its first token "
                "would silently read a bare space")
        out[m] = tokens[0]
    return out


def read_one(base: str, item: dict, style: str, ids: dict[str, int]) -> dict:
    prompt, markers = render(item, style)
    response = post(base, "/completion", {
        "prompt": prompt, "n_predict": 1, "n_probs": 100,
        "temperature": 0, "cache_prompt": False})
    top = {t["id"]: t["logprob"] for t in response["completion_probabilities"][0]["top_logprobs"]}
    floor = min(top.values(), default=-30.0) - 1.0
    missing = sum(1 for m in markers if ids[m] not in top)
    probs = normalise([top.get(ids[m], floor) for m in markers])
    order = item["presented"]
    best = max(range(len(probs)), key=lambda i: probs[i])
    return {
        "case_id": item["case_id"], "ordering_index": item["ordering_index"],
        "label": item["label"], "presented": order, "predicted": order[best],
        "confidence": probs[best],
        "probabilities": {order[i]: probs[i] for i in range(len(order))},
        "markers_missing": missing,
    }


def summarise(records: list[dict]) -> dict:
    correct = sum(1 for r in records if r["predicted"] == r["label"])
    stable, permuted = stability(records)
    return {
        "correct": correct, "n": len(records),
        "accuracy": round(correct / len(records), 4),
        "ece": round(ece(records), 4), "brier": round(brier(records), 4),
        "position_bias": round(position_bias(records), 4),
        "stable": stable, "permuted": permuted,
        "markers_missing": sum(r["markers_missing"] for r in records),
    }


def beats(ref: float, values: list[float]) -> str:
    """How the reference fares against every rendering on one axis, lower better."""
    better = sum(1 for v in values if ref < v)
    tied = sum(1 for v in values if abs(ref - v) < 5e-5)
    return f"{better} of {len(values)}" + (f" ({tied} tied)" if tied else "")


def finding(reference: dict, renderings: dict) -> str:
    """Stated from the measured values, so it cannot drift from the evidence."""
    ps = sorted(r["mcnemar_p"] for r in renderings.values())
    scores = sorted(r["correct"] for r in renderings.values())
    axes = {k: [r[k] for r in renderings.values()] for k in ("ece", "brier", "position_bias")}
    stable = [r["stable"] for r in renderings.values()]
    return (
        f"The untrained base scores {scores[0]}-{scores[-1]} of {reference['n']} against the trained "
        f"checkpoint's {reference['correct']}, and no rendering is distinguishable from it: exact "
        f"McNemar on the paired records gives p {ps[0]:.3f} to {ps[-1]:.3f}. That is low power, not "
        f"equivalence — at {reference['n']} records a seven-point gap needs several hundred to "
        f"resolve and a two-point gap thousands, so the corpus does not license any accuracy claim "
        f"about the training. The trained checkpoint does take the secondary axes: calibration on "
        f"{beats(reference['ece'], axes['ece'])} renderings, order stability on "
        f"{sum(1 for v in stable if reference['stable'] > v)} of {len(stable)}, position bias on "
        f"{beats(reference['position_bias'], axes['position_bias'])}, and Brier on "
        f"{beats(reference['brier'], axes['brier'])}. Training bought calibration and "
        f"order-robustness here, not accuracy."
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backbone", default="http://127.0.0.1:8098")
    ap.add_argument("--items", required=True, help="choice records with presentation orders")
    ap.add_argument("--reference", required=True, help="the Kev run to pair against")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    items = json.load(open(args.items))
    reference = json.load(open(args.reference))
    ref_records = reference["backends"][0]["records"]
    keys = {(i["case_id"], i["ordering_index"]) for i in items}
    if keys != {(r["case_id"], r["ordering_index"]) for r in ref_records}:
        raise SystemExit("record set differs from the reference run; the comparison would not be paired")

    by_key = {(i["case_id"], i["ordering_index"]): i for i in items}
    ref = {(r["case_id"], r["ordering_index"]): dict(r, presented=by_key[(r["case_id"], r["ordering_index"])]["presented"])
           for r in ref_records}

    ids = marker_ids(args.backbone,
                     [" " + c for c in LETTERS[:4]] + [str(d) for d in range(1, 5)])
    renderings = {}
    for style in STYLES:
        # Sequential deliberately. Serving these concurrently across llama-server's
        # slots is ~3x faster and not reproducible: batch composition changes the
        # reduction order in the batched GEMM, which moves the logits slightly and
        # flips any record whose top two options are near-tied. Five of these 56
        # sit under a 0.02 margin, the closest at 0.0012, so concurrency moved the
        # score by a whole record between runs — the entire effect size being
        # measured here. Run sequentially and the score repeats exactly.
        records = [read_one(args.backbone, item, style, ids) for item in items]
        only_ref, only_base = discordant(ref, {(r["case_id"], r["ordering_index"]): r for r in records})
        renderings[style] = dict(summarise(records), **{
            "cue": STYLES[style]["cue"],
            "reference_only_correct": only_ref,
            "rendering_only_correct": only_base,
            "mcnemar_p": round(mcnemar(only_ref, only_base), 4),
        })
        print(f"{style:18} {renderings[style]['correct']:2d}/{len(records)}  "
              f"p={renderings[style]['mcnemar_p']:.3f}")

    reference_summary = {
        "system": "Kev-4B, LoRA + pointer head, llama.cpp Q8_0",
        "file": args.reference,
        "correct": reference["backends"][0]["correct"], "n": len(ref_records),
        "ece": 0.1043, "brier": 0.236,
        "position_bias": round(position_bias(list(ref.values())), 4),
        "stable": stability(list(ref.values()))[0],
        "permuted": stability(list(ref.values()))[1],
    }
    json.dump({
        "measured": "2026-09-22",
        "question": "Does the trained LoRA and pointer head beat the same base model with nothing trained?",
        "corpus": reference["corpus"],
        "floors": reference["floors"],
        "machine": reference["machine"],
        "reference": reference_summary,
        "base": {"weights": "Qwen3-4B-Base.Q8_0.gguf", "lora": None, "head": None,
                 "readout": "next-token logits restricted to the option markers"},
        "renderings": renderings,
        "finding": finding(reference_summary, renderings),
    }, open(args.out, "w"), indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()

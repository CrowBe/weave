"""OpenJev over Kev's transfer-v4 held-out records.

The two local candidates answer the same contract, so measuring them on the
same records is the only way to compare them. OpenJev has one primitive, so
only two of the three question types have a mapping:

  choice -> rerank: each option becomes a hypothesis against the state as
            premise; the prediction is the option with the highest P(entailment).
            This is the `rerank` the model card claims MMLU 0.53 on.
  noul   -> one pair; predict true when the argmax is entailment. P(entailment)
            is recorded so a different rule can be scored without re-running.
  score  -> no mapping. Skipped, and counted as skipped.

--plan tokenizes and prints an estimated cost without loading the model.
"""
import argparse, collections, hashlib, json, math, os, random, resource, statistics, time
from pathlib import Path

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))


def render(v, indent=0):
    """Verbatim from Kev's api.py, so both models read the same state text.

    Option text is deliberately NOT taken from Kev's option_text(), which
    prefixes the key ("a: The arms trade..."). Kev is trained to read that;
    OpenJev's documented rerank takes plain option strings, so it gets those.
    """
    pad = "  " * indent
    if v is None:
        return ""
    if isinstance(v, (str, int, float, bool)):
        return str(v)
    if isinstance(v, list):
        return "\n".join(f"{pad}- {render(x, indent + 1).lstrip()}" for x in v)
    return "\n".join(
        f"{pad}{k}:\n{render(x, indent + 1)}" if isinstance(x, (dict, list))
        else f"{pad}{k}: {render(x)}" for k, x in v.items())


render_state = render


def option_hypothesis(key, desc):
    """Kev's option_text without the "key: " prefix. When a choice option has no
    description the key IS the option (emotion's criteria are {"joy": null, ...}),
    so falling through to the rendered null would hand the model an empty
    hypothesis -- every option identical, and the comparison meaningless."""
    text = render(desc)
    return text if text.strip() else str(key)


NOUL_FROM_CRITERIA = False


def load(suite, split):
    rows = []
    for line in (Path(suite) / f"{split}.jsonl").read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def units(records):
    """Sampling unit is the group, so contrastive pairs stay together."""
    groups = collections.OrderedDict()
    for r in records:
        groups.setdefault(r["_meta"]["group_id"], []).append(r)
    return list(groups.values())


def subsample(records, per_source, seed):
    by_source = collections.OrderedDict()
    for group in units(records):
        by_source.setdefault(group[0]["_meta"]["source"], []).append(group)
    picked = []
    for source, groups in by_source.items():
        rng = random.Random(f"{seed}:{source}")
        order = sorted(groups, key=lambda g: g[0]["_meta"]["id"])
        rng.shuffle(order)
        taken, out = 0, []
        for g in order:
            if per_source is not None and taken >= per_source:
                break
            out.append(g)
            taken += len(g)
        picked.extend(out)
    return [r for g in picked for r in g]


def tasks_of(record):
    """One task per answerable question."""
    state = render_state(record["state"])
    out = []
    for name, q in record["questions"].items():
        kind = q["type"]
        if kind == "choice":
            criteria = q["criteria"]
            out.append({"kind": "choice", "name": name, "src": q["src"],
                        "id": record["_meta"]["id"], "group_id": record["_meta"]["group_id"],
                        "premise": state,
                        "options": {k: option_hypothesis(k, v) for k, v in criteria.items()},
                        "label": q["label"]})
        elif kind == "noul":
            hypothesis = render(q["instructions"])
            criteria = q.get("criteria") or {}
            if NOUL_FROM_CRITERIA and render(criteria.get("true")).strip():
                hypothesis = render(criteria["true"])
            out.append({"kind": "noul", "name": name, "src": q["src"],
                        "id": record["_meta"]["id"], "group_id": record["_meta"]["group_id"],
                        "premise": state, "hypothesis": hypothesis,
                        "label": bool(q["label"])})
        else:
            out.append({"kind": "skipped", "name": name, "src": q["src"],
                        "id": record["_meta"]["id"], "type": kind})
    return out


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--suite", default=str(KEV_HOME / "src/evals/v4/transfer-v4"))
    ap.add_argument("--split", default="development")
    ap.add_argument("--per-source", type=int, default=40)
    ap.add_argument("--seed", type=int, default=20260920)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--warmup-seconds", type=float, default=200.0)
    ap.add_argument("--only-source", default=None,
                    help="restrict to one question src")
    ap.add_argument("--state-key", default=None,
                    help="use only this key of a dict state as the premise, bare")
    ap.add_argument("--noul-from-criteria", action="store_true",
                    help="use criteria.true as the noul hypothesis instead of instructions")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()

    global NOUL_FROM_CRITERIA
    NOUL_FROM_CRITERIA = args.noul_from_criteria

    records = subsample(load(args.suite, args.split), args.per_source, args.seed)
    if args.state_key:
        for r in records:
            if isinstance(r["state"], dict) and args.state_key in r["state"]:
                r["state"] = r["state"][args.state_key]
    tasks = [t for r in records for t in tasks_of(r)]
    if args.only_source:
        wanted = set(args.only_source.split(","))
        tasks = [t for t in tasks if t["src"] in wanted]
    answerable = [t for t in tasks if t["kind"] != "skipped"]
    skipped = [t for t in tasks if t["kind"] == "skipped"]

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
    template = "Premise: {premise}\nHypothesis: {hypothesis}"

    def pairs_of(task):
        if task["kind"] == "choice":
            return [(key, task["premise"], text) for key, text in task["options"].items()]
        return [(None, task["premise"], task["hypothesis"])]

    forwards = [(t, k, p, h) for t in answerable for (k, p, h) in pairs_of(t)]
    lengths = [len(tok(template.format(premise=p, hypothesis=h))["input_ids"])
               for _, _, p, h in forwards]

    if args.plan:
        by_src = collections.Counter(t["src"] for t, _, _, _ in forwards)
        print(f"records {len(records)}  tasks {len(answerable)} answerable, {len(skipped)} skipped")
        print(f"forwards {len(forwards)}  tokens total {sum(lengths)} "
              f"min {min(lengths)} median {statistics.median(lengths):.0f} max {max(lengths)}")
        print("forwards by source:", dict(by_src))
        for rate in (13.5,):
            secs = sum(0.9 + n / rate for n in lengths)
            print(f"  at {rate} tok/s sustained + 0.9s fixed: {secs/60:.0f} min")
        for kind in ("choice", "noul"):
            sel = [t for t in answerable if t["kind"] == kind]
            print(f"  {kind}: {len(sel)} tasks, sources "
                  f"{dict(collections.Counter(t['src'] for t in sel))}")
        return

    import torch
    from transformers import AutoModelForSequenceClassification
    torch.set_num_interop_threads(1)
    torch.set_num_threads(8)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model, local_files_only=True, trust_remote_code=False, dtype=torch.float32).eval()
    model.config.use_cache = False
    labels = {int(i): l for i, l in model.config.id2label.items()}
    assert model.config.nli_template == template

    def predict(premise, hypothesis):
        inputs = tok(template.format(premise=premise, hypothesis=hypothesis), return_tensors="pt")
        t0 = time.monotonic()
        with torch.inference_mode():
            logits = model(**inputs).logits[0].float()
        seconds = time.monotonic() - t0
        s = torch.softmax(logits, dim=-1).tolist()
        return ({labels[i]: v for i, v in enumerate(s)},
                inputs["input_ids"].shape[1], seconds)

    # Warm to sustained clock; a cold process on this part runs ~60% fast.
    warm = tok(template.format(premise="warm " * 100, hypothesis="warm"), return_tensors="pt")
    started, warm_trace = time.monotonic(), []
    while time.monotonic() - started < args.warmup_seconds:
        t0 = time.monotonic()
        with torch.inference_mode():
            model(**warm)
        warm_trace.append(round(time.monotonic() - t0, 3))
    if warm_trace:
        print(f"warmup {len(warm_trace)} forwards, {warm_trace[0]:.2f}s -> "
              f"{warm_trace[-1]:.2f}s", flush=True)
    torch.set_num_threads(args.threads)

    began = time.monotonic()
    rows, done = [], 0
    for task in answerable:
        scores = {}
        tokens = seconds = 0
        for key, p, h in pairs_of(task):
            sc, n, s = predict(p, h)
            scores[key] = sc
            tokens += n
            seconds += s
            done += 1
        if task["kind"] == "choice":
            pred = max(scores, key=lambda k: scores[k]["entailment"])
            confidence = scores[pred]["entailment"]
        else:
            sc = scores[None]
            best = max(sc.values())
            winners = [k for k, v in sc.items() if v == best]
            pred = len(winners) == 1 and winners[0] == "entailment"
            confidence = sc["entailment"]
        rows.append({"id": task["id"], "group_id": task["group_id"], "src": task["src"],
                     "kind": task["kind"], "question": task["name"], "label": task["label"],
                     "predicted": pred, "correct": pred == task["label"],
                     "p_entailment": confidence, "scores": scores,
                     "input_tokens": tokens, "seconds": seconds})
        print(json.dumps({k: rows[-1][k] for k in
                          ("id", "src", "kind", "label", "predicted", "correct", "seconds")}),
              flush=True)

    # Constant predictor: the majority answer of each source, which is the
    # strongest label-free baseline and therefore the honest floor.
    by_src = collections.defaultdict(list)
    for r in rows:
        by_src[r["src"]].append(r)
    stub = {}
    for src, rs in by_src.items():
        counts = collections.Counter(json.dumps(r["label"]) for r in rs)
        top, hits = counts.most_common(1)[0]
        # Two floors. Uniform is label-free honest chance; majority peeks at the
        # label distribution and is therefore the stronger bar to clear.
        uniform = statistics.mean(
            1 / len(r["scores"]) if r["kind"] == "choice" else 0.5 for r in rs)
        stub[src] = {"constant_answer": json.loads(top), "accuracy": hits / len(rs),
                     "uniform_chance": uniform, "n": len(rs)}
    stub_hits = sum(v["accuracy"] * v["n"] for v in stub.values())
    uniform_hits = sum(v["uniform_chance"] * v["n"] for v in stub.values())

    correct, total = sum(r["correct"] for r in rows), len(rows)
    lo, hi = wilson(correct, total)
    report = {
        "operation": "text.assess-entailment applied to the systemone contract",
        "status": "experimental", "calibrated": False,
        "checkpoint_revision": "4b5f9a67fa2ebe77466bce0656ce350effc3148c",
        "checkpoint_subfolder": "qwen3.5-4b-nli-v2",
        "suite": Path(args.suite).name, "split": args.split,
        "suite_sha256": hashlib.sha256((Path(args.suite) / "manifest.json").read_bytes()).hexdigest(),
        "split_sha256": hashlib.sha256((Path(args.suite) / f"{args.split}.jsonl").read_bytes()).hexdigest(),
        "in_distribution": bool(json.loads((Path(args.suite) / "manifest.json").read_text())["trainable_sources"]),
        "seed": args.seed, "per_source": args.per_source,
        "noul_from_criteria": args.noul_from_criteria,
        "only_source": args.only_source, "state_key": args.state_key,
        "records": len(records), "tasks_scored": total,
        "tasks_skipped": len(skipped),
        "skipped_types": dict(collections.Counter(t["type"] for t in skipped)),
        "dtype": "float32", "threads": args.threads, "device": "cpu", "batch_size": 1,
        "torch": torch.__version__, "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "warmup_seconds": args.warmup_seconds,
        "accuracy": correct / total, "correct": correct,
        "standard_error": math.sqrt((correct / total) * (1 - correct / total) / total),
        "wilson_95": [lo, hi],
        "constant_predictor_accuracy": stub_hits / total,
        "uniform_chance_accuracy": uniform_hits / total,
        "constant_predictor_by_source": stub,
        "by_source": {src: {"accuracy": sum(r["correct"] for r in rs) / len(rs), "n": len(rs),
                            "kind": rs[0]["kind"],
                            "constant": stub[src]["accuracy"],
                            "uniform": stub[src]["uniform_chance"],
                            "median_seconds": statistics.median(r["seconds"] for r in rs)}
                      for src, rs in sorted(by_src.items())},
        "by_kind": {kind: {"accuracy": sum(r["correct"] for r in rs) / len(rs), "n": len(rs)}
                    for kind, rs in
                    ((k, [r for r in rows if r["kind"] == k]) for k in ("choice", "noul")) if rs},
        "forwards": done, "wall_seconds": time.monotonic() - began,
        "input_tokens": sum(r["input_tokens"] for r in rows),
        "median_task_seconds": statistics.median(r["seconds"] for r in rows),
        "rows": rows,
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"\naccuracy {correct}/{total} = {correct/total:.4f} [{lo:.3f}, {hi:.3f}]  "
          f"majority-class {stub_hits/total:.4f}  uniform {uniform_hits/total:.4f}", flush=True)


if __name__ == "__main__":
    main()

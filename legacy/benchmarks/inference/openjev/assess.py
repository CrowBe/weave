"""Experimental text.assess-entailment result contract; no routing or authority."""

import math

LABELS = frozenset({"contradiction", "entailment", "neutral"})


def assess(premise, hypothesis, predict):
    if not all(isinstance(s, str) and s.strip() for s in (premise, hypothesis)):
        raise ValueError("premise and hypothesis must be nonempty strings")
    scores = dict(predict(premise, hypothesis))
    if set(scores) != LABELS:
        raise ValueError("expected exactly contradiction, entailment and neutral")
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) or not 0 <= v <= 1 for v in scores.values()):
        raise ValueError("invalid model scores")
    if not math.isclose(sum(scores.values()), 1.0, abs_tol=1e-5):
        raise ValueError("model scores must sum to one")
    best = max(scores.values())
    winners = [label for label, score in scores.items() if score == best]
    return {"label": winners[0] if len(winners) == 1 else "undetermined", "scores": scores}

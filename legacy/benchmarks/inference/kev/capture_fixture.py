"""Capture a real /v1/systemone response from a running local Kev server.

The gateway's TypeSafe adapter test asserts against response fixtures "copied
from a live call, not invented". If Kev is to serve that same contract, the
claim that it is wire-compatible has to rest on a Kev response, recorded the
same way. This prints one, covering all three question types at once.

Usage (with `python -m kev.serve` already listening):
    python benchmarks/inference/kev/capture_fixture.py http://127.0.0.1:8008
"""
from __future__ import annotations

import json
import sys
import urllib.request

REQUEST = {
    "model": "kev-latest",
    "state": {
        "ticket": "Card payment to a merchant was declined twice this morning, "
                  "and the second attempt still shows as pending on my statement.",
        "customer_tier": "standard",
    },
    "questions": {
        # Exactly the three shapes typesafeAiEvaluator emits, including the
        # optional true/false criteria it attaches to a boolean.
        "urgent": {"type": "noul", "instructions": "Is this urgent?",
                   "criteria": {"true": "Needs attention today",
                                "false": "Can wait for normal handling"}},
        "area": {"type": "choice", "instructions": "Which area does this concern?",
                 "criteria": {"auth": "Sign-in or identity",
                              "payments": "Payments and transfers",
                              "ui": "Interface problems"}},
        "severity": {"type": "score", "instructions": "How severe is this?",
                     "criteria": ["trivial", "minor", "serious", "critical"]},
    },
}


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8008").rstrip("/")
    request = urllib.request.Request(
        f"{base}/v1/systemone", data=json.dumps(REQUEST).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer local"})
    with urllib.request.urlopen(request, timeout=600) as response:
        body = json.loads(response.read())
        headers = dict(response.headers)
    print(json.dumps({"request": REQUEST, "response": body,
                      "response_headers": headers}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

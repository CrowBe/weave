#!/usr/bin/env python3
"""E2E S1 sim: extract → fidelity → decide-1 → (decide-2 + arg extract)."""
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CF = os.environ.get("CF_BIN", "cf")
ENV = os.environ.copy()
if os.environ.get("CF_NODE22_BIN"):
    ENV["PATH"] = os.environ["CF_NODE22_BIN"] + ":" + ENV.get("PATH", "")

GENERIC_FIELDS = {
  "intent": {"type": "text", "instructions": "Primary action the user wants, as a short phrase."},
  "entities": {"type": "list", "items": "text", "instructions": "Named ids, repos, files, channels, titles mentioned."},
  "prohibitions": {"type": "list", "items": "text", "instructions": "Complete do-not / never phrases retaining negation."},
  "ask_triggers": {"type": "list", "items": "text", "instructions": "Conditions that require asking the user first."},
  "needs_generation": {"type": "text", "instructions": "yes if free-form drafting is required, no otherwise."},
  "multi_part": {"type": "text", "instructions": "yes if the request has independent subtasks, no if single."},
  "irreversible": {"type": "text", "instructions": "yes if an irreversible act is requested, no, or unclear."},
}

TOOL_CATALOG = {
  "cancel_order": "Cancel an order by id",
  "refund_order": "Refund an order by id",
  "gh_pr_list": "List pull requests for a repo/path",
  "gh_pr_get": "Get one PR by number",
  "gh_pr_create": "Open a draft or ready PR",
  "gh_branch_delete": "Delete a remote branch",
  "linear_create": "Create a Linear issue",
  "slack_post": "Post a message to a Slack channel",
  "save_draft": "Save a draft note without posting",
  "read_file": "Read a file from a repo at a ref",
  "wipe_account": "Permanently delete account data",
  "none": "No matching tool",
}

ARG_SCHEMAS = {
  "cancel_order": {
    "order_id": {"type": "text", "instructions": "Order id exactly as written."},
  },
  "refund_order": {
    "order_id": {"type": "text", "instructions": "Order id exactly as written."},
  },
  "gh_pr_list": {
    "repo": {"type": "text", "instructions": "owner/repo"},
    "path_filter": {"type": "text", "instructions": "Path filter if any, else null."},
  },
  "gh_pr_get": {
    "repo": {"type": "text", "instructions": "owner/repo"},
    "number": {"type": "text", "instructions": "PR number as digits only."},
  },
  "gh_pr_create": {
    "repo": {"type": "text", "instructions": "owner/repo"},
    "title": {"type": "text", "instructions": "PR title"},
    "draft": {"type": "text", "instructions": "yes if draft, no otherwise"},
  },
  "gh_branch_delete": {
    "repo": {"type": "text", "instructions": "owner/repo"},
    "branch": {"type": "text", "instructions": "Branch name"},
  },
  "linear_create": {
    "team": {"type": "text", "instructions": "Linear team key or name"},
    "title": {"type": "text", "instructions": "Issue title"},
    "priority": {"type": "text", "instructions": "Priority"},
    "description": {"type": "text", "instructions": "Issue description span"},
  },
  "slack_post": {
    "channel": {"type": "text", "instructions": "Channel name"},
  },
  "save_draft": {
    "channel": {"type": "text", "instructions": "Channel the draft is for, if any"},
  },
  "read_file": {
    "repo": {"type": "text", "instructions": "owner/repo"},
    "path": {"type": "text", "instructions": "File path"},
    "ref": {"type": "text", "instructions": "Git ref, default main"},
  },
  "wipe_account": {
    "account_id": {"type": "text", "instructions": "Account id if stated, else null"},
    "account_name": {"type": "text", "instructions": "Account name"},
  },
}


def cf_run(model: str, body: dict, out_path: Path) -> dict:
    body_path = out_path.with_suffix(".req.json")
    body_path.write_text(json.dumps(body))
    # model flag in body
    if "model" not in body:
        body = {**body, "model": model.split("/")[-1]}
        body_path.write_text(json.dumps(body))
    cmd = [CF, "ai", "run", model, "--body", f"@{body_path}"]
    r = subprocess.run(cmd, capture_output=True, text=True, env=ENV, cwd=str(ROOT))
    if r.returncode != 0:
        out_path.write_text(json.dumps({"error": r.stderr or r.stdout, "code": r.returncode}))
        raise RuntimeError(f"cf failed {out_path}: {r.stderr[-500:]}")
    data = json.loads(r.stdout)
    out_path.write_text(json.dumps(data, indent=2))
    return data


def extract(task: dict, d: Path) -> dict:
    body = {"model": "clairic", "state": task["input"], "fields": GENERIC_FIELDS}
    return cf_run("@cf/cloudflare/clairic", body, d / "01_extract.out.json")


def fidelity(task: dict, ext: dict, d: Path) -> dict:
    compact = {
        k: {"value": v.get("value"), "confidence": v.get("confidence"), "p_null": v.get("p_null")}
        for k, v in ext.get("answers", {}).items()
    }
    body = {
        "model": "clef-flash",
        "state": {
            "original_input": task["input"],
            "extraction": compact,
            "policy": "Original is authoritative. Lists with near-zero confidence are hints only.",
        },
        "questions": {
            "prefer_original": {
                "type": "noul",
                "instructions": "Should decide treat original as authoritative and extraction as hints only?",
            },
            "scalars_or_entities_usable": {
                "type": "noul",
                "instructions": "Are high-signal entities/ids from extraction safe enough as hints?",
            },
            "lists_usable": {
                "type": "noul",
                "instructions": "Are list fields complete enough to drive planning without re-reading original?",
            },
            "gate": {
                "type": "choice",
                "instructions": "Fidelity gate for the next decide pass.",
                "criteria": {
                    "use_hints": "Use high-conf extract hints alongside original",
                    "original_only": "Ignore weak extract; decide from original only",
                    "reprompt": "Re-extract with tighter schema first",
                },
            },
        },
    }
    return cf_run("@cf/cloudflare/clef-flash", body, d / "02_fidelity.out.json")


def decide1(task: dict, ext: dict, fid: dict, d: Path) -> dict:
    compact = {
        k: {"value": v.get("value"), "confidence": v.get("confidence")}
        for k, v in ext.get("answers", {}).items()
    }
    gate = fid["answers"]["gate"]["choice"]
    body = {
        "model": "clef-flash",
        "state": {
            "original_input": task["input"],
            "extraction_hints": compact if gate != "original_only" else "SUPPRESSED — use original only",
            "fidelity_gate": gate,
            "fidelity_scores": {
                "prefer_original": fid["answers"]["prefer_original"]["noul"],
                "lists_usable": fid["answers"]["lists_usable"]["noul"],
            },
            "policy": (
                "Decide-1 is coarse only. Do NOT pick a concrete tool name. "
                "Bands: tool_call = one deterministic tool act; spawn_subtasks = independent children; "
                "escalate_gen = free-form generation past frontier; ask_human = irreversible+low-conf or user-only ambiguity (D-ENG-030)."
            ),
        },
        "questions": {
            "band": {
                "type": "choice",
                "instructions": "Which coarse act band?",
                "criteria": {
                    "tool_call": "A single deterministic tool action covers the request",
                    "spawn_subtasks": "Independent subtasks should become child threads",
                    "escalate_gen": "Needs generative drafting with a pre-targeted brief",
                    "ask_human": "Ask the user before any consequential act",
                },
            },
            "split_gain": {
                "type": "noul",
                "instructions": "If multi-part, would spawning children improve correctness/parallelism?",
            },
            "irreversible_low_conf": {
                "type": "noul",
                "instructions": "Is there an irreversible act with unresolved identity or low confidence?",
            },
        },
    }
    return cf_run("@cf/cloudflare/clef-flash", body, d / "03_decide1.out.json")


def is_gate_incomplete(fid: dict) -> bool:
    return fid["answers"]["gate"]["choice"] == "reprompt"


def decide2_tool(task: dict, d: Path) -> dict:
    body = {
        "model": "clef-flash",
        "state": {
            "original_input": task["input"],
            "phase": "decide-2 after band=tool_call",
            "policy": "Pick exactly one tool. Prefer the least irreversible matching tool.",
        },
        "questions": {
            "tool": {
                "type": "choice",
                "instructions": "Which tool?",
                "criteria": TOOL_CATALOG,
            },
            "args_likely_in_input": {
                "type": "noul",
                "instructions": "Are the required arguments present in the original input?",
            },
        },
    }
    return cf_run("@cf/cloudflare/clef-flash", body, d / "04_decide2.out.json")


def extract_args(task: dict, tool: str, d: Path) -> dict | None:
    schema = ARG_SCHEMAS.get(tool)
    if not schema or tool == "none":
        return None
    body = {
        "model": "clairic",
        "state": task["input"],
        "fields": schema,
    }
    return cf_run("@cf/cloudflare/clairic", body, d / "05_args.out.json")


def summarize(task, ext, fid, d1, d2=None, args=None):
    band = d1["answers"]["band"]
    row = {
        "id": task["id"],
        "expect_band": task["expect_band"],
        "band": band["choice"],
        "band_conf": band["confidence"],
        "band_match": band["choice"] == task["expect_band"],
        "fidelity_gate": fid["answers"]["gate"]["choice"],
        "prefer_original": fid["answers"]["prefer_original"]["noul"],
        "lists_usable": fid["answers"]["lists_usable"]["noul"],
        "split_gain": d1["answers"]["split_gain"]["noul"],
        "irreversible_low_conf": d1["answers"]["irreversible_low_conf"]["noul"],
        "tool": None,
        "tool_conf": None,
        "args": None,
    }
    if d2:
        t = d2["answers"]["tool"]
        row["tool"] = t["choice"]
        row["tool_conf"] = t["confidence"]
    if args and "answers" in args:
        row["args"] = {
            k: {"value": v.get("value"), "confidence": v.get("confidence"), "p_null": v.get("p_null")}
            for k, v in args["answers"].items()
        }
    return row


def summarize_incomplete(task, fid):
    return {
        "id": task["id"],
        "expect_band": task["expect_band"],
        "band": None,
        "band_conf": None,
        "band_match": None,
        "fidelity_gate": fid["answers"]["gate"]["choice"],
        "prefer_original": fid["answers"]["prefer_original"]["noul"],
        "lists_usable": fid["answers"]["lists_usable"]["noul"],
        "split_gain": None,
        "irreversible_low_conf": None,
        "tool": None,
        "tool_conf": None,
        "args": None,
        "incomplete": True,
        "incomplete_reason": "reprompt fidelity gate rejected extraction hints; stopped before decide-1",
    }


def main():
    tasks = json.loads((ROOT / "tasks.json").read_text())
    rows = []
    for i, task in enumerate(tasks, 1):
        d = ROOT / task["id"]
        d.mkdir(exist_ok=True)
        (d / "input.txt").write_text(task["input"])
        print(f"[{i}/{len(tasks)}] {task['id']} …", flush=True)
        try:
            ext = extract(task, d)
            fid = fidelity(task, ext, d)
            if is_gate_incomplete(fid):
                row = summarize_incomplete(task, fid)
                print("  → incomplete: reprompt fidelity gate rejected hints; stopped before decide-1", flush=True)
                rows.append(row)
                continue
            d1 = decide1(task, ext, fid, d)
            band = d1["answers"]["band"]["choice"]
            d2 = args = None
            if band == "tool_call":
                d2 = decide2_tool(task, d)
                tool = d2["answers"]["tool"]["choice"]
                args = extract_args(task, tool, d)
            row = summarize(task, ext, fid, d1, d2, args)
        except Exception as e:
            row = {"id": task["id"], "expect_band": task["expect_band"], "error": str(e)}
            print(f"  ERROR: {e}", flush=True)
        rows.append(row)
        print(f"  → {json.dumps({k: row.get(k) for k in ['band','band_match','fidelity_gate','tool','band_conf']})}", flush=True)

    (ROOT / "summary.json").write_text(json.dumps(rows, indent=2))
    matched = sum(1 for r in rows if r.get("band_match"))
    decided = sum(1 for r in rows if isinstance(r.get("band"), str))
    print(f"\nDONE {matched}/{len(rows)} band matches ({decided} decided)", flush=True)


def selftest() -> int:
    for gate, want in (("reprompt", True), ("use_hints", False), ("original_only", False)):
        fid = {"answers": {"gate": {"choice": gate}}}
        assert is_gate_incomplete(fid) == want
    fid = {"answers": {"gate": {"choice": "reprompt"}, "prefer_original": {"noul": 0.85}, "lists_usable": {"noul": 0.02}}}
    row = summarize_incomplete({"id": "T09_two_reads", "expect_band": "spawn_subtasks"}, fid)
    assert row["incomplete"] is True and row["band"] is None and row["band_match"] is None
    assert row["fidelity_gate"] == "reprompt" and row["incomplete_reason"]
    print("selftest ok (reprompt->incomplete, other gates proceed)", flush=True)
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    main()

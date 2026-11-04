#!/usr/bin/env python3
"""Coding preflight sim: extract → fidelity → decide-1 → target-set decide → spawn plan (depends_on)."""
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def eval_edit_ok(to_edit, expect_edit) -> bool:
    return set(to_edit) == set(expect_edit)
CF = os.environ.get("CF_BIN", "cf")
ENV = os.environ.copy()
if os.environ.get("CF_NODE22_BIN"):
    ENV["PATH"] = os.environ["CF_NODE22_BIN"] + ":" + ENV.get("PATH", "")

TASK = {
  "id": "T11_code_edit",
  "expect_band": "spawn_subtasks",
  "expect_shape": "preflight_reads_then_gen",
  "input": (
    "USER: In CrowBe/weave on main, amend VISION.md so System-1 extract→decide→act/split/ask "
    "with escalate-to-gen past the frontier is explicit after the model-at-centre paragraph. "
    "Also update packages/weave/src/sites/CONTRACT.md to note that intake.classify / D1 / D2 "
    "will gain dispatch authority (D-ENG-031) — do not change boolean.ts or any runtime code. "
    "Do not touch GLOSSARY.md. Keep the change docs-only. Open nothing; just produce the edits.\n"
    "CONTEXT: Reading files is a tool. Coordinated multi-file docs edits need generation after "
    "the relevant files are read. Target set must be decided before escalate_gen."
  ),
}

EXTRACT_FIELDS = {
  "intent": {"type": "text", "instructions": "Primary action as a short phrase."},
  "read_paths": {"type": "list", "items": "text", "instructions": "Repo-relative paths that must be read before editing."},
  "edit_paths": {"type": "list", "items": "text", "instructions": "Repo-relative paths that may be edited."},
  "forbidden_paths": {"type": "list", "items": "text", "instructions": "Paths explicitly must-not-touch."},
  "needs_generation": {"type": "text", "instructions": "yes if free-form drafting/edits required after reads."},
  "multi_part": {"type": "text", "instructions": "yes if independent subtasks, no if single sequenced plan."},
  "irreversible": {"type": "text", "instructions": "yes/no/unclear for irreversible acts."},
  "constraints": {"type": "list", "items": "text", "instructions": "Hard constraints retaining negation."},
}

def cf_run(model: str, body: dict, out_path: Path) -> dict:
    body_path = out_path.with_suffix(".req.json")
    if "model" not in body:
        body = {**body, "model": model.split("/")[-1]}
    body_path.write_text(json.dumps(body))
    cmd = [CF, "ai", "run", model, "--body", f"@{body_path}"]
    r = subprocess.run(cmd, capture_output=True, text=True, env=ENV, cwd=str(ROOT))
    if r.returncode != 0:
        out_path.write_text(json.dumps({"error": r.stderr or r.stdout, "code": r.returncode}))
        raise RuntimeError(f"cf failed {out_path.name}: {(r.stderr or r.stdout)[-800:]}")
    data = json.loads(r.stdout)
    out_path.write_text(json.dumps(data, indent=2))
    return data

def main():
    d = ROOT / TASK["id"]
    d.mkdir(exist_ok=True)
    (d / "input.txt").write_text(TASK["input"])
    print("1 extract…", flush=True)
    ext = cf_run("@cf/cloudflare/clairic", {"model": "clairic", "state": TASK["input"], "fields": EXTRACT_FIELDS}, d / "01_extract.out.json")

    compact = {k: {"value": v.get("value"), "confidence": v.get("confidence"), "p_null": v.get("p_null")} for k, v in ext.get("answers", {}).items()}
    print("2 fidelity…", flush=True)
    fid = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {"original_input": TASK["input"], "extraction": compact, "policy": "Original authoritative. Path lists are hints."},
        "questions": {
            "prefer_original": {"type": "noul", "instructions": "Treat original as authoritative?"},
            "path_lists_usable": {"type": "noul", "instructions": "Are read/edit/forbidden path lists usable as planning hints?"},
            "reads_before_gen": {"type": "noul", "instructions": "Must files be read before any generation/edit?"},
            "gate": {"type": "choice", "instructions": "Fidelity gate.", "criteria": {
                "use_hints": "Use high-conf path hints with original",
                "original_only": "Ignore weak extract; original only",
                "reprompt": "Re-extract tighter first",
            }},
        },
    }, d / "02_fidelity.out.json")

    gate = fid["answers"]["gate"]["choice"]
    print("3 decide-1…", flush=True)
    d1 = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {
            "original_input": TASK["input"],
            "extraction_hints": compact if gate != "original_only" else "SUPPRESSED",
            "fidelity_gate": gate,
            "fidelity_scores": {k: fid["answers"][k]["noul"] for k in ("prefer_original", "path_lists_usable", "reads_before_gen")},
            "policy": (
                "Decide-1 coarse only. Coding edits that need context first are spawn_subtasks "
                "(preflight reads → then escalate_gen), NOT bare escalate_gen. "
                "Bands: tool_call | spawn_subtasks | escalate_gen | ask_human."
            ),
        },
        "questions": {
            "band": {"type": "choice", "instructions": "Which coarse act band?", "criteria": {
                "tool_call": "One deterministic tool covers it",
                "spawn_subtasks": "Need children (incl. sequenced reads-before-gen)",
                "escalate_gen": "Bare generation with brief already targeted — no further gathers",
                "ask_human": "Irreversible+low-conf or user-only ambiguity",
            }},
            "veto_bare_gen": {"type": "noul", "instructions": "Should bare escalate_gen be vetoed because reads/targets are still needed?"},
            "split_gain": {"type": "noul", "instructions": "Does splitting (preflight + gen) improve correctness?"},
        },
    }, d / "03_decide1.out.json")

    # Apply known tunings: reads_before_gen or veto_bare_gen → force spawn
    raw_band = d1["answers"]["band"]["choice"]
    raw_conf = d1["answers"]["band"]["confidence"]
    rbg = fid["answers"]["reads_before_gen"]["noul"]
    veto = d1["answers"]["veto_bare_gen"]["noul"]
    tuned = raw_band
    notes = []
    if raw_conf < 0.35:
        notes.append("conf_floor")
    if rbg >= 0.35 or veto >= 0.35:
        if tuned == "escalate_gen" or tuned == "tool_call":
            tuned = "spawn_subtasks"
            notes.append("reads_before_gen→spawn")
        elif tuned != "spawn_subtasks" and tuned != "ask_human":
            tuned = "spawn_subtasks"
            notes.append("reads_before_gen→spawn")

    print(f"  raw={raw_band}@{raw_conf:.3f} tuned={tuned} notes={notes}", flush=True)

    # Preflight decide: closed set of candidate paths → select read/edit/forbid
    print("4 target-set decide…", flush=True)
    candidates = [
        "VISION.md",
        "packages/weave/src/sites/CONTRACT.md",
        "packages/weave/src/sites/boolean.ts",
        "GLOSSARY.md",
        "ARCHITECTURE.md",
        "AGENTS.md",
        "docs/research/prompt-decomposition-extraction-vs-generation.md",
    ]
    targets = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {
            "original_input": TASK["input"],
            "candidate_paths": candidates,
            "extraction_hints": compact if gate != "original_only" else "SUPPRESSED",
            "policy": (
                "Preflight decide: from candidates only, mark each path role. "
                "edit = will change; read = needed context only; forbid = must not touch; skip = irrelevant."
            ),
        },
        "questions": {
            "VISION.md": {"type": "choice", "instructions": "Role for VISION.md", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "packages/weave/src/sites/CONTRACT.md": {"type": "choice", "instructions": "Role for CONTRACT.md", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "packages/weave/src/sites/boolean.ts": {"type": "choice", "instructions": "Role for boolean.ts", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "GLOSSARY.md": {"type": "choice", "instructions": "Role for GLOSSARY.md", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "ARCHITECTURE.md": {"type": "choice", "instructions": "Role for ARCHITECTURE.md", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "AGENTS.md": {"type": "choice", "instructions": "Role for AGENTS.md", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
            "docs/research/prompt-decomposition-extraction-vs-generation.md": {"type": "choice", "instructions": "Role for research doc", "criteria": {"edit": "edit", "read": "read only", "forbid": "must not touch", "skip": "irrelevant"}},
        },
    }, d / "04_targets.out.json")

    roles = {p: targets["answers"][p]["choice"] for p in candidates}
    confs = {p: targets["answers"][p]["confidence"] for p in candidates}
    print(f"  roles={roles}", flush=True)

    # Spawn plan with depends_on sequence
    print("5 spawn plan…", flush=True)
    to_read = [p for p, r in roles.items() if r in ("edit", "read")]
    to_edit = [p for p, r in roles.items() if r == "edit"]
    forbid = [p for p, r in roles.items() if r == "forbid"]
    spawn = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {
            "original_input": TASK["input"],
            "band": tuned,
            "target_roles": roles,
            "to_read": to_read,
            "to_edit": to_edit,
            "forbid": forbid,
            "policy": (
                "Plan children as a SEQUENCE with depends_on, not siblings. "
                "Child kinds: tool_call (read_file) then one escalate_gen that edits only to_edit paths. "
                "Never edit forbid paths."
            ),
        },
        "questions": {
            "child_count": {"type": "choice", "instructions": "How many children in the sequence?", "criteria": {
                "2": "one gather + one gen", "3": "two gathers + gen", "4": "three gathers + gen", "5": "four gathers + gen",
            }},
            "gen_depends_on_all_reads": {"type": "noul", "instructions": "Should the escalate_gen child depend_on every read child?"},
            "plan_ok": {"type": "noul", "instructions": "Is sequenced reads→gen the right shape for this task?"},
        },
    }, d / "05_spawn.out.json")

    # Build explicit plan from roles (deterministic merge; Clef only validated shape)
    read_children = [{"id": f"read_{i}", "kind": "tool_call", "tool": "read_file", "path": p, "depends_on": []} for i, p in enumerate(to_read)]
    gen_child = {
        "id": "gen_edits",
        "kind": "escalate_gen",
        "edit_paths": to_edit,
        "forbid_paths": forbid,
        "depends_on": [c["id"] for c in read_children],
        "brief": f"Amend only {to_edit}; respect forbid {forbid}; evidence from prior reads.",
    }
    plan = {"children": read_children + [gen_child], "clef": {
        "child_count": spawn["answers"]["child_count"]["choice"],
        "gen_depends_on_all_reads": spawn["answers"]["gen_depends_on_all_reads"]["noul"],
        "plan_ok": spawn["answers"]["plan_ok"]["noul"],
        "conf": {k: spawn["answers"][k].get("confidence") for k in spawn["answers"]},
    }}
    (d / "06_plan.json").write_text(json.dumps(plan, indent=2))

    expect_edit = {"VISION.md", "packages/weave/src/sites/CONTRACT.md"}
    expect_forbid = {"packages/weave/src/sites/boolean.ts", "GLOSSARY.md"}
    summary = {
        "id": TASK["id"],
        "expect_band": TASK["expect_band"],
        "raw_band": raw_band,
        "raw_conf": raw_conf,
        "tuned_band": tuned,
        "band_match": tuned == TASK["expect_band"],
        "tune_notes": notes,
        "fidelity": {k: fid["answers"][k].get("noul", fid["answers"][k].get("choice")) for k in fid["answers"]},
        "extract_paths": {
            "read": compact.get("read_paths", {}).get("value"),
            "edit": compact.get("edit_paths", {}).get("value"),
            "forbid": compact.get("forbidden_paths", {}).get("value"),
            "conf": {k: compact.get(k, {}).get("confidence") for k in ("read_paths", "edit_paths", "forbidden_paths")},
        },
        "target_roles": roles,
        "target_confs": confs,
        "edit_ok": eval_edit_ok(to_edit, expect_edit),
        "forbid_ok": all(roles.get(p) in ("forbid", "skip") for p in expect_forbid) and not any(p in to_edit for p in expect_forbid),
        "plan": plan,
        "shape_match": plan["clef"]["plan_ok"] >= 0.35 and tuned == "spawn_subtasks",
    }

    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: summary[k] for k in ("tuned_band", "band_match", "edit_ok", "forbid_ok", "shape_match", "target_roles")}, indent=2), flush=True)

def selftest() -> int:
    cases = [
        (["VISION.md", "packages/weave/src/sites/CONTRACT.md"], {"VISION.md", "packages/weave/src/sites/CONTRACT.md"}, True),
        (["VISION.md", "packages/weave/src/sites/CONTRACT.md", "ARCHITECTURE.md"], {"VISION.md", "packages/weave/src/sites/CONTRACT.md"}, False),
        (["VISION.md"], {"VISION.md", "packages/weave/src/sites/CONTRACT.md"}, False),
    ]
    for to_edit, expect_edit, want in cases:
        got = eval_edit_ok(to_edit, expect_edit)
        assert got == want, f"eval_edit_ok({to_edit}, {expect_edit}) -> {got}, want {want}"
    print(f"selftest ok ({len(cases)} cases)", flush=True)
    return 0

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    main()

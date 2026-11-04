#!/usr/bin/env python3
"""Held-out T12: AGENTS.md + research doc edit; forbid VISION and runtime."""
from __future__ import annotations
import json, os, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CF = os.environ.get("CF_BIN", "cf")
ENV = os.environ.copy()
if os.environ.get("CF_NODE22_BIN"):
    ENV["PATH"] = os.environ["CF_NODE22_BIN"] + ":" + ENV.get("PATH", "")

TASK = {
  "id": "T12_agents_research",
  "expect_band": "spawn_subtasks",
  "input": (
    "USER: On CrowBe/weave main, update AGENTS.md with a short 'System-1 loop' bullet: "
    "extract→decide→act/split/ask, escalate-gen only past frontier with a pre-targeted brief. "
    "Also add one paragraph to docs/research/prompt-decomposition-extraction-vs-generation.md "
    "pointing at the closed-set preflight target-role Decide pattern (edit|read|forbid|skip). "
    "Do not edit VISION.md. Do not touch packages/weave/src/sites/boolean.ts or any TypeScript. "
    "Docs/markdown only; no PR.\n"
    "CONTEXT: Reads are tools. Multi-file markdown edits need generation after the files to change are read."
  ),
}

EXTRACT_FIELDS = {
  "intent": {"type": "text", "instructions": "Primary action as a short phrase."},
  "read_paths": {"type": "list", "items": "text", "instructions": "Paths that must be read before editing."},
  "edit_paths": {"type": "list", "items": "text", "instructions": "Paths that may be edited."},
  "forbidden_paths": {"type": "list", "items": "text", "instructions": "Paths explicitly must-not-touch."},
  "needs_generation": {"type": "text", "instructions": "yes if free-form drafting/edits required after reads."},
  "multi_part": {"type": "text", "instructions": "yes if independent subtasks, no if single sequenced plan."},
  "irreversible": {"type": "text", "instructions": "yes/no/unclear."},
}

CANDIDATES = [
  "AGENTS.md",
  "VISION.md",
  "docs/research/prompt-decomposition-extraction-vs-generation.md",
  "packages/weave/src/sites/boolean.ts",
  "packages/weave/src/sites/CONTRACT.md",
  "GLOSSARY.md",
  "ARCHITECTURE.md",
]

def cf_run(model: str, body: dict, out_path: Path) -> dict:
    body_path = out_path.with_suffix(".req.json")
    if "model" not in body:
        body = {**body, "model": model.split("/")[-1]}
    body_path.write_text(json.dumps(body))
    r = subprocess.run([CF, "ai", "run", model, "--body", f"@{body_path}"], capture_output=True, text=True, env=ENV, cwd=str(ROOT))
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
        "state": {"original_input": TASK["input"], "extraction": compact, "policy": "Original authoritative."},
        "questions": {
            "prefer_original": {"type": "noul", "instructions": "Treat original as authoritative?"},
            "path_lists_usable": {"type": "noul", "instructions": "Are open path lists usable?"},
            "reads_before_gen": {"type": "noul", "instructions": "Must files be read before generation/edit?"},
            "gate": {"type": "choice", "instructions": "Fidelity gate.", "criteria": {"use_hints": "use hints", "original_only": "original only", "reprompt": "re-extract"}},
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
            "policy": "Decide-1 coarse. Coding needing context first = spawn_subtasks (preflight reads→gen), not bare escalate_gen.",
        },
        "questions": {
            "band": {"type": "choice", "instructions": "Coarse band?", "criteria": {
                "tool_call": "one tool", "spawn_subtasks": "children / sequenced reads-before-gen",
                "escalate_gen": "bare gen already targeted", "ask_human": "ask user first",
            }},
            "veto_bare_gen": {"type": "noul", "instructions": "Veto bare escalate_gen because gathers still needed?"},
            "split_gain": {"type": "noul", "instructions": "Does preflight+gen split help?"},
        },
    }, d / "03_decide1.out.json")
    raw_band = d1["answers"]["band"]["choice"]
    raw_conf = d1["answers"]["band"]["confidence"]
    rbg = fid["answers"]["reads_before_gen"]["noul"]
    veto = d1["answers"]["veto_bare_gen"]["noul"]
    tuned = raw_band
    notes = []
    if raw_conf < 0.35: notes.append("conf_floor")
    if (rbg >= 0.35 or veto >= 0.35) and tuned in ("escalate_gen", "tool_call"):
        tuned = "spawn_subtasks"; notes.append("reads_before_gen→spawn")
    print(f"  raw={raw_band}@{raw_conf:.3f} tuned={tuned} {notes}", flush=True)
    print("4 targets…", flush=True)
    targets = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {"original_input": TASK["input"], "candidate_paths": CANDIDATES, "policy": "Mark each candidate edit|read|forbid|skip."},
        "questions": {p: {"type": "choice", "instructions": f"Role for {p}", "criteria": {"edit": "edit", "read": "read", "forbid": "forbid", "skip": "skip"}} for p in CANDIDATES},
    }, d / "04_targets.out.json")
    roles = {p: targets["answers"][p]["choice"] for p in CANDIDATES}
    confs = {p: targets["answers"][p]["confidence"] for p in CANDIDATES}
    to_read = [p for p, r in roles.items() if r in ("edit", "read")]
    to_edit = [p for p, r in roles.items() if r == "edit"]
    forbid = [p for p, r in roles.items() if r == "forbid"]
    print("5 spawn…", flush=True)
    spawn = cf_run("@cf/cloudflare/clef-flash", {
        "model": "clef-flash",
        "state": {"band": tuned, "to_read": to_read, "to_edit": to_edit, "forbid": forbid, "policy": "Sequence via depends_on: reads then one escalate_gen."},
        "questions": {
            "gen_depends_on_all_reads": {"type": "noul", "instructions": "Gen child depends_on every read?"},
            "plan_ok": {"type": "noul", "instructions": "Is sequenced reads→gen correct?"},
        },
    }, d / "05_spawn.out.json")
    plan = {
        "children": [{"id": f"read_{i}", "kind": "tool_call", "tool": "read_file", "path": p, "depends_on": []} for i, p in enumerate(to_read)]
        + [{"id": "gen_edits", "kind": "escalate_gen", "edit_paths": to_edit, "forbid_paths": forbid, "depends_on": [f"read_{i}" for i in range(len(to_read))]}],
        "clef": {k: spawn["answers"][k].get("noul", spawn["answers"][k].get("choice")) for k in spawn["answers"]},
    }
    expect_edit = {"AGENTS.md", "docs/research/prompt-decomposition-extraction-vs-generation.md"}
    expect_forbid_or_skip = {"VISION.md", "packages/weave/src/sites/boolean.ts"}
    summary = {
        "id": TASK["id"], "raw_band": raw_band, "raw_conf": raw_conf, "tuned_band": tuned, "notes": notes,
        "band_match": tuned == TASK["expect_band"],
        "fidelity": {k: fid["answers"][k].get("noul", fid["answers"][k].get("choice")) for k in fid["answers"]},
        "target_roles": roles, "target_confs": confs,
        "edit_ok": expect_edit.issubset(set(to_edit)),
        "forbid_ok": all(roles.get(p) in ("forbid", "skip") for p in expect_forbid_or_skip) and not any(p in to_edit for p in expect_forbid_or_skip),
        "plan": plan,
        "shape_match": spawn["answers"]["plan_ok"]["noul"] >= 0.35 and tuned == "spawn_subtasks",
    }
    (ROOT / "summary_t12.json").write_text(json.dumps(summary, indent=2))
    (d / "06_plan.json").write_text(json.dumps(plan, indent=2))
    print(json.dumps({k: summary[k] for k in ("tuned_band","band_match","edit_ok","forbid_ok","shape_match","target_roles")}, indent=2))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Print a compact side-by-side summary of results/compare-{node,rust}-*.json (raw files stay git-ignored)."""
import glob, json, os, sys

root = os.path.join(os.path.dirname(__file__), "..", "..", "results")


def load(impl, key):
    p = os.path.join(root, f"compare-{impl}-{key}.json")
    return json.load(open(p)) if os.path.exists(p) else None


def scen(r):
    if "not_applicable" in r:
        return f"N/A ({r['not_applicable']})"
    n = r.get("notification") or {}
    d = r.get("delivered") or []
    atts = [a["filename"] for m in d for a in m["attachments"]]
    notice = any(m["has_security_notice"] for m in d)
    disp = [(a["filename"], a["scan_state"], a.get("disposition"), a.get("withheld_category")) for a in r.get("attachments", [])]
    scans = [(s["scanner"], s["verdict"], (s.get("error") or "")[:40]) for s in r.get("scans", [])]
    return (f"http={r['http_status']} state={n.get('state')} err={n.get('last_error_code')} msgs={len(d)} "
            f"delivered_atts={atts} notice={notice}\n      db={disp}\n      scans={scans}")


for key in sys.argv[1:] or ["A", "B", "C", "D", "E", "F", "G"]:
    print(f"=== {key}")
    for impl in ("node", "rust"):
        d = load(impl, key)
        if d is None:
            print(f"  [{impl}] (no data)")
            continue
        if isinstance(d, list):
            for r in d:
                print(f"  [{impl}] {r.get('label', r.get('name'))}: " + (scen(r) if "http_status" in r or "not_applicable" in r else json.dumps(r)))
        else:
            print(f"  [{impl}] " + json.dumps(d)[:1800])

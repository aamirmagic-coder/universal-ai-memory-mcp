#!/usr/bin/env python3
"""One-way, reviewed PMB JSON-export -> Universal AI Memory sync.

PMB remains the local source of truth. This script mirrors active events to the
Supabase-backed memory service; it never modifies the PMB SQLite/LanceDB store.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_BATCH = 50
ALLOWED_TYPES = {"fact", "decision", "lesson", "event", "goal", "note", "project", "preference"}
TYPE_MAP = {"fact": "fact", "qa": "note", "git": "event", "file": "note", "test": "event", "activity": "event", "milestone": "event", "goal": "goal"}
WORKSPACE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def load_export(path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("workspace"), dict):
        raise ValueError("PMB export must contain a workspace object")
    workspace = payload["workspace"]
    if not isinstance(workspace.get("id"), str) or not workspace["id"]:
        raise ValueError("PMB export workspace.id is missing")
    events = payload.get("events")
    if not isinstance(events, list) or any(not isinstance(item, dict) for item in events):
        raise ValueError("PMB export must contain an events array of objects")
    return workspace, events


def map_event(event: dict[str, Any], workspace_id: str, workspace_name: str, target_workspace: str) -> dict[str, Any] | None:
    """Map one PMB event to a cloud record; return None for pin markers/junk."""
    ulid, content = event.get("ulid"), event.get("content")
    event_type = str(event.get("type") or "note").lower()
    if not isinstance(ulid, str) or not ulid:
        return None
    if not isinstance(content, str) or not content.strip():
        return None
    raw_meta = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    if event_type == "qa":
        question = raw_meta.get("query")
        if isinstance(question, str) and question.strip():
            content = f"Q: {question.strip()}\nA: {content}"
    if len(content) > 20_000:
        raise ValueError(f"PMB event {ulid} exceeds the 20,000-character cloud limit")
    kind = str(raw_meta.get("kind") or "").lower()
    memory_type = "note" if event_type == "pin" else ("lesson" if kind in {"lesson", "failure"} else (kind if kind in ALLOWED_TYPES else TYPE_MAP.get(event_type, "note")))
    tags = raw_meta.get("tags") if isinstance(raw_meta.get("tags"), list) else []
    safe_metadata: dict[str, Any] = {
        "source": "pmb-ai", "pmb_event_type": event_type,
        "pmb_workspace_id": workspace_id, "pmb_workspace_name": workspace_name, "pmb_ulid": ulid,
    }
    # Copy only low-risk provenance fields; arbitrary PMB metadata may include paths or private payloads.
    for key in ("kind", "project", "source"):
        value = raw_meta.get(key)
        if isinstance(value, (str, int, float, bool)):
            safe_metadata[f"pmb_{key}"] = value
    timestamp = event.get("timestamp")
    source_created_at = datetime.fromtimestamp(timestamp, tz=UTC).isoformat() if isinstance(timestamp, (int, float)) else None
    importance = event.get("importance", 0.5)
    return {
        "external_id": f"pmb:{workspace_id}:{ulid}", "workspace_id": target_workspace,
        "memory_type": memory_type, "content": content,
        "tags": [str(tag)[:80] for tag in tags[:50]], "metadata": safe_metadata,
        "importance": max(0.0, min(1.0, float(importance if importance is not None else 0.5))),
        "confidence": 1.0, "is_pinned": event_type == "pin" or bool(raw_meta.get("pinned", False)),
        "source_created_at": source_created_at,
    }


def stable_fingerprint(record: dict[str, Any]) -> str:
    canonical = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_state(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Sync state file is invalid")
    return {str(k): str(v) for k, v in data.items()}


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def post_batch(endpoint: str, token: str, workspace: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    body = json.dumps({"operation": "upsert_batch", "workspace_id": workspace, "records": records}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.loads(response.read().decode("utf-8"))
            if response.status >= 300 or not result.get("ok"):
                raise RuntimeError(f"Cloud sync failed with HTTP {response.status}")
            return result
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Cloud sync failed with HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("Cloud sync could not reach the memory endpoint") from exc


def run(args: argparse.Namespace) -> int:
    workspace, events = load_export(args.export_file)
    target_workspace = args.target_workspace or f"pmb-{workspace['id']}"
    if not WORKSPACE_RE.fullmatch(target_workspace):
        raise ValueError("Target workspace must be 1-64 letters, numbers, dots, underscores or hyphens")
    mapped = [
        record for event in events if not event.get("archived")
        if (record := map_event(event, workspace["id"], workspace.get("name", workspace["id"]), target_workspace))
    ]
    if args.max_items:
        mapped = mapped[:args.max_items]
    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)
    changed = [record for record in mapped if state.get(record["external_id"]) != stable_fingerprint(record)]
    print(f"PMB workspace: {workspace.get('name', workspace['id'])} ({workspace['id']})")
    print(f"Cloud workspace: {target_workspace}")
    print(f"Exported events: {len(events)} | eligible: {len(mapped)} | changed/new: {len(changed)}")
    if not args.apply:
        print("DRY RUN: no data sent. Review the export for sensitive content before applying.")
        return 0
    if not args.reviewed:
        raise ValueError("Refusing upload: pass --reviewed only after manually reviewing the export for sensitive data")
    endpoint = args.endpoint or os.environ.get("UNIVERSAL_MEMORY_SYNC_URL")
    token = args.token or os.environ.get("PMB_SYNC_TOKEN")
    if not endpoint or not token:
        raise ValueError("Set UNIVERSAL_MEMORY_SYNC_URL and PMB_SYNC_TOKEN, or pass --endpoint and --token")
    if not endpoint.startswith("https://"):
        raise ValueError("The sync endpoint must use HTTPS")
    sent = 0
    batch_size = min(args.batch_size, MAX_BATCH)
    for offset in range(0, len(changed), batch_size):
        batch = changed[offset:offset + batch_size]
        result = post_batch(endpoint, token, target_workspace, batch)
        if result.get("processed") != len(batch):
            raise RuntimeError("Cloud returned an incomplete batch result; state was not advanced")
        for record in batch:
            state[record["external_id"]] = stable_fingerprint(record)
        save_state(state_path, state)
        sent += len(batch)
        print(f"Synced {sent}/{len(changed)}")
    print(f"Completed: {sent} records mirrored. PMB local data was not modified.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_file", help="Path to a PMB pmb export --format json file")
    parser.add_argument("--target-workspace", help="Cloud workspace; default is pmb-<local-workspace-id>")
    parser.add_argument("--endpoint", help="Supabase sukuma-memory-sync HTTPS URL (or UNIVERSAL_MEMORY_SYNC_URL)")
    parser.add_argument("--token", help="Bearer token (prefer PMB_SYNC_TOKEN environment variable)")
    parser.add_argument("--state-file", default="~/.pmb/universal-memory-sync-state.json")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--apply", action="store_true", help="Actually upload; otherwise this is a dry run")
    parser.add_argument("--reviewed", action="store_true", help="Confirm you manually reviewed the export for sensitive data")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not 1 <= args.batch_size <= MAX_BATCH:
        print(f"--batch-size must be between 1 and 50", file=sys.stderr)
        return 2
    try:
        return run(args)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

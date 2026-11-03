import json
from pathlib import Path

from integrations.pmb_sync import load_export, map_event, stable_fingerprint


def sample_event(**overrides):
    event = {
        "ulid": "01JTEST0000000000000000000", "type": "fact",
        "content": "Project uses PostgreSQL 17.", "timestamp": 1793670000,
        "importance": 0.8, "archived": False,
        "metadata": {"kind": "decision", "project": "SUKUMA", "tags": ["database"]},
    }
    event.update(overrides)
    return event


def test_map_event_preserves_workspace_and_stable_id():
    record = map_event(sample_event(), "workspace123", "Main", "sukuma")
    assert record["external_id"] == "pmb:workspace123:01JTEST0000000000000000000"
    assert record["workspace_id"] == "sukuma"
    assert record["memory_type"] == "decision"
    assert record["content"] == "Project uses PostgreSQL 17."
    assert record["metadata"]["pmb_workspace_id"] == "workspace123"


def test_map_event_does_not_copy_unapproved_metadata_fields():
    event = sample_event(metadata={"kind": "lesson", "file": "/private/home/secret.txt", "tags": ["rule"]})
    record = map_event(event, "ws", "Main", "pmb-ws")
    assert record["memory_type"] == "lesson"
    assert "file" not in record["metadata"]


def test_map_event_preserves_pin_events_as_pinned_notes():
    record = map_event(sample_event(type="pin"), "ws", "Main", "pmb-ws")
    assert record is not None
    assert record["memory_type"] == "note"
    assert record["is_pinned"] is True


def test_map_event_preserves_question_context_for_qa_events():
    event = sample_event(type="qa", metadata={"query": "Why use Postgres?", "tags": ["architecture"]})
    record = map_event(event, "ws", "Main", "pmb-ws")
    assert record["content"] == "Q: Why use Postgres?\\nA: Project uses PostgreSQL 17."


def test_load_export_validates_shape(tmp_path: Path):
    path = tmp_path / "export.json"
    path.write_text(json.dumps({"workspace": {"id": "abc", "name": "Main"}, "events": [sample_event()]}))
    workspace, events = load_export(path)
    assert workspace["id"] == "abc"
    assert len(events) == 1


def test_stable_fingerprint_changes_when_content_changes():
    a = map_event(sample_event(), "ws", "Main", "pmb-ws")
    b = map_event(sample_event(content="Updated decision."), "ws", "Main", "pmb-ws")
    assert stable_fingerprint(a) != stable_fingerprint(b)
    assert stable_fingerprint(a) == stable_fingerprint(dict(a))


def test_failure_kind_maps_to_lesson():
    record = map_event(sample_event(metadata={"kind": "failure"}), "ws", "Main", "pmb-ws")
    assert record["memory_type"] == "lesson"


def test_zero_importance_is_preserved():
    record = map_event(sample_event(importance=0), "ws", "Main", "pmb-ws")
    assert record["importance"] == 0

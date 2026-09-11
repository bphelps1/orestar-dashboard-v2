"""Contracts for same-job account-summary and exact-ID evidence batches."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest


ROOT = Path(__file__).parent.parent
SCRAPER_DIR = ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

import atomic_balance_evidence as ABE  # noqa: E402


SNAPSHOT = "sha256:" + "a" * 64


def _source(*scopes: tuple[list[str], str]) -> dict:
    return {
        "version": 2,
        "calculation_version": "cash-balance-v2",
        "transaction_snapshot_id": SNAPSHOT,
        "scopes": {
            "|".join(sorted(ids)): {
                "filer_ids": ids,
                "app_scope_transaction_digest": digest,
            }
            for ids, digest in scopes
        },
    }


def _row(ids: list[str], *, delta: float, count: int, captured: float = 1000) -> dict:
    return {
        "name": "Committee " + "|".join(ids),
        "filer_id": ids[0],
        "filer_ids": ids,
        "delta": delta,
        "tran_count": count,
        "comparison_status": "paired",
        "transaction_snapshot_id": SNAPSHOT,
        "scrape_ts": captured,
        "closed": False,
        "newer_app_data": False,
    }


def _payload(rows: list[dict]) -> dict:
    return {
        "schema_version": 2,
        "basis": "paired_capture_window_v1",
        "rows": rows,
    }


def test_plan_selects_whole_unanchored_scopes_and_skips_certified(
    monkeypatch, tmp_path,
) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)
    seen = {}

    def certify(_rows, requirements, candidates, _transaction_dir):
        seen["requirements"] = requirements
        seen["candidates"] = set(candidates)
        return {"30": {"filer_id": "30"}}, set(), None

    monkeypatch.setattr(ABE, "certify_exact_scope_rows", certify)
    result = ABE.build_plan(
        _payload([
            _row(["10", "20"], delta=100, count=5),
            _row(["30"], delta=200, count=1),
        ]),
        [],
        _source((["10", "20"], "sha256:scope-a"),
                (["30"], "sha256:scope-b")),
        tmp_path,
        max_scopes=10,
        planned_at="2026-09-10T12:00:00.000000Z",
    )

    assert seen["candidates"] == {"10", "20", "30"}
    assert seen["requirements"]["10"] is seen["requirements"]["20"]
    assert result["already_anchored_scope_count"] == 1
    assert result["remaining_scope_count"] == 1
    assert result["scopes"][0]["filer_ids"] == ["10", "20"]


def test_plan_orders_old_attempts_then_cheaper_scopes(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)
    monkeypatch.setattr(
        ABE,
        "certify_exact_scope_rows",
        lambda *_args, **_kwargs: ({}, {"10", "20"}, None),
    )
    diff = [
        {"filer_id": "10", "checked_at": "2026-09-09T00:00:00Z"},
        {"filer_id": "20", "checked_at": "2026-09-08T00:00:00Z"},
    ]
    result = ABE.build_plan(
        _payload([
            _row(["10"], delta=999, count=50),
            _row(["20"], delta=1, count=2),
        ]),
        diff,
        _source((["10"], "sha256:scope-a"),
                (["20"], "sha256:scope-b")),
        tmp_path,
        max_scopes=2,
        planned_at="2026-09-10T12:00:00.000000Z",
    )

    assert [scope["filer_ids"] for scope in result["scopes"]] == [["20"], ["10"]]


def test_automatic_plan_defers_same_day_failure_but_explicit_target_overrides(
    monkeypatch, tmp_path,
) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)
    monkeypatch.setattr(
        ABE, "certify_exact_scope_rows", lambda *_args, **_kwargs: ({}, set(), None)
    )
    diff = [{
        "filer_id": "10",
        "complete": None,
        "last_attempt_at": "2026-09-10T01:00:00Z",
    }]
    kwargs = dict(
        balance_payload=_payload([_row(["10"], delta=100, count=5)]),
        diff_rows=diff,
        source=_source((["10"], "sha256:scope-a")),
        transaction_dir=tmp_path,
        max_scopes=10,
        planned_at="2026-09-10T12:00:00Z",
    )

    automatic = ABE.build_plan(**kwargs)
    explicit = ABE.build_plan(**kwargs, requested_ids=["10"])

    assert automatic["remaining_scope_count"] == 1
    assert automatic["deferred_scope_count"] == 1
    assert automatic["selected_scope_count"] == 0
    assert explicit["selected_scope_count"] == 1


def test_explicit_scope_expansion_cannot_be_silently_truncated(
    monkeypatch, tmp_path,
) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)
    monkeypatch.setattr(
        ABE, "certify_exact_scope_rows", lambda *_args, **_kwargs: ({}, set(), None)
    )

    with pytest.raises(ABE.AtomicEvidenceError, match="more scopes than max_scopes"):
        ABE.build_plan(
            _payload([
                _row(["10"], delta=1, count=1),
                _row(["20"], delta=1, count=1),
            ]),
            [],
            _source((["10"], "sha256:a"), (["20"], "sha256:b")),
            tmp_path,
            max_scopes=1,
            requested_ids=["10", "20"],
            planned_at="2026-09-10T12:00:00Z",
        )


def test_ready_keeps_only_complete_scopes_captured_after_plan(
    monkeypatch, tmp_path,
) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)

    def comparison(ids, *_args, **_kwargs):
        fresh = ids == ["10", "20"]
        captured = 2000 if fresh else 900
        return {
            "status": "paired",
            "capture_started_at": captured,
            "captured_at": captured + 1,
            "app_transaction_snapshot_id": SNAPSHOT,
            "filer_ids": ids,
            "scope_digest_matches_capture": True,
            "orestar_data_changed_since_capture": False,
        }

    monkeypatch.setattr(ABE, "paired_comparison", comparison)
    plan = {
        "version": 1,
        "planned_at": "1970-01-01T00:16:40Z",  # epoch 1000
        "transaction_snapshot_id": SNAPSHOT,
        "scopes": [
            {"filer_ids": ["10", "20"], "app_scope_transaction_digest": "sha256:a"},
            {"filer_ids": ["30"], "app_scope_transaction_digest": "sha256:b"},
        ],
    }
    result = ABE.ready_plan(
        plan,
        {},
        tmp_path,
        now=datetime(2026, 9, 10, tzinfo=timezone.utc),
    )

    assert result["ready_scope_count"] == 1
    assert result["scopes"][0]["filer_ids"] == ["10", "20"]
    assert result["rejected_scopes"] == [
        {"filer_ids": ["30"], "reason": "not_freshly_captured"}
    ]
    assert result["end_date"] == "2026-09-10"


def test_verify_counts_only_fully_certified_scopes(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(ABE, "_current_snapshot", lambda *_args, **_kwargs: SNAPSHOT)
    captured = {}

    def certify(rows, requirements, candidates, _transaction_dir, **kwargs):
        captured["requirements"] = requirements
        captured["candidates"] = set(candidates)
        captured["ranges"] = kwargs["active_ranges"]
        by_id = {row["filer_id"]: row for row in rows}
        return {"10": by_id["10"], "20": by_id["20"], "30": by_id["30"]}, {"40"}, None

    monkeypatch.setattr(ABE, "certify_exact_scope_rows", certify)
    ready = {
        "version": 1,
        "planned_at": "1970-01-01T00:16:40Z",
        "transaction_snapshot_id": SNAPSHOT,
        "end_date": "2026-09-10",
        "ready_scope_count": 2,
        "scopes": [
            {
                "filer_ids": ["10", "20"],
                "capture_started_at": 1900,
                "captured_at": 2000,
                "capture_day": "1970-01-01",
                "app_scope_transaction_digest": "sha256:a",
            },
            {
                "filer_ids": ["30", "40"],
                "capture_started_at": 1900,
                "captured_at": 2000,
                "capture_day": "1970-01-01",
                "app_scope_transaction_digest": "sha256:b",
            },
        ],
    }
    rows = [
        {"filer_id": "10", "missing": ["m1"], "surplus": []},
        {"filer_id": "20", "missing": [], "surplus": ["s1", "s2"]},
        {"filer_id": "30", "missing": [], "surplus": []},
        {"filer_id": "40", "missing": [], "surplus": []},
    ]
    result = ABE.verify_plan(ready, rows, tmp_path)

    assert captured["candidates"] == {"10", "20", "30", "40"}
    assert captured["requirements"]["10"] is captured["requirements"]["20"]
    assert set(captured["ranges"].values()) == {"2026-09-10"}
    assert result["certified_scope_count"] == 1
    assert result["certified_filer_count"] == 2
    assert result["missing_id_count"] == 1
    assert result["surplus_id_count"] == 2
    assert result["blocked_filer_ids"] == ["30", "40"]


def test_ready_requirements_are_shared_and_pin_the_frozen_range() -> None:
    ready = {
        "version": 1,
        "planned_at": "2026-09-10T12:00:00Z",
        "transaction_snapshot_id": SNAPSHOT,
        "end_date": "2026-09-10",
        "ready_scope_count": 1,
        "scopes": [{
            "filer_ids": ["10", "20"],
            "capture_started_at": 1_789_041_601,
            "captured_at": 1_789_041_602,
            "capture_day": "2026-09-10",
            "app_scope_transaction_digest": "sha256:scope",
        }],
    }

    scopes, requirements, ranges = ABE.requirements_from_ready_plan(
        ready, SNAPSHOT
    )

    assert scopes == [["10", "20"]]
    assert requirements["10"] is requirements["20"]
    assert requirements["10"]["active_range_end"] == "2026-09-10"
    assert requirements["10"]["active_range_conflict"] is False
    assert ranges == {"10": "2026-09-10", "20": "2026-09-10"}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"ready_scope_count": 2}, "scope count"),
        ({"planned_at": "2026-09-10"}, "explicitly UTC"),
        ({"scope_ids": ["20", "10"]}, "canonical"),
        ({"capture_started_at": 1_789_041_599}, "after planning"),
        ({"capture_day": "2026-09-09"}, "capture day"),
        ({"end_date": "2026-09-09"}, "before capture day"),
    ],
)
def test_ready_requirement_contract_rejects_malformed_windows(
    change, message,
) -> None:
    ready = {
        "version": 1,
        "planned_at": "2026-09-10T12:00:00Z",
        "transaction_snapshot_id": SNAPSHOT,
        "end_date": "2026-09-10",
        "ready_scope_count": 1,
        "scopes": [{
            "filer_ids": ["10", "20"],
            "capture_started_at": 1_789_041_601,
            "captured_at": 1_789_041_602,
            "capture_day": "2026-09-10",
            "app_scope_transaction_digest": "sha256:scope",
        }],
    }
    change = dict(change)
    scope_ids = change.pop("scope_ids", None)
    if scope_ids is not None:
        ready["scopes"][0]["filer_ids"] = scope_ids
    elif set(change).issubset({"capture_started_at", "capture_day"}):
        ready["scopes"][0].update(change)
    else:
        ready.update(change)

    with pytest.raises(ABE.AtomicEvidenceError, match=message):
        ABE.requirements_from_ready_plan(ready, SNAPSHOT)


def test_snapshot_drift_is_a_hard_failure(tmp_path) -> None:
    transactions = tmp_path / "transactions"
    transactions.mkdir()
    (transactions / "txn_2026.csv.gz").write_bytes(b"frozen bytes")

    with pytest.raises(ABE.AtomicEvidenceError, match="Transaction snapshot changed"):
        ABE._current_snapshot(transactions, SNAPSHOT)


def test_workflow_runs_both_collectors_without_a_second_pull() -> None:
    workflow = (ROOT / ".github" / "workflows" / "atomic-balance-evidence.yml").read_text()
    summary = workflow.index("      - name: Capture fresh summaries for planned scopes")
    diff = workflow.index("      - name: Diff exactly the freshly paired scopes")
    publish = workflow.index("      - name: Publish atomic evidence state")
    aggregate = workflow.index("      - name: Re-aggregate from durable evidence")

    assert summary < diff < publish < aggregate
    assert workflow.count("pipeline_state.py pull") == 1
    assert "pull transactions summaries auxiliary" in workflow
    assert "--force --current-only" in workflow
    diff_block = workflow[diff:publish]
    assert '--scope-plan "$READY_PATH"' in diff_block
    assert "--filer-ids" not in diff_block
    assert "--flagged" not in workflow
    assert "push summaries auxiliary" in workflow
    assert "require-no-missing" not in workflow


def test_workflow_stops_partial_batches_before_any_successor_dispatch() -> None:
    workflow = (ROOT / ".github" / "workflows" / "atomic-balance-evidence.yml").read_text()
    summary = workflow.index("      - name: Capture fresh summaries for planned scopes")
    diff = workflow.index("      - name: Diff exactly the freshly paired scopes")
    terminal = workflow.index("      - name: Enforce truthful terminal status")
    successor = workflow.index("      - name: Continue bounded evidence chain")
    diff_block = workflow[diff:terminal]
    terminal_block = workflow[terminal:successor]
    successor_block = workflow[successor:]

    assert "steps.summaries.outcome == 'success'" in diff_block
    assert terminal < successor
    assert "steps.ready.outputs.ready_scopes" in terminal_block
    assert "steps.plan.outputs.selected_scopes" in terminal_block
    assert "steps.diff.outcome" in terminal_block
    assert "steps.verify.outputs.certified_scopes" in terminal_block
    assert "success() && !cancelled()" in successor_block
    assert "gh workflow run atomic-balance-evidence.yml" in successor_block
    assert "dispatch_retry.sh" not in successor_block
    assert "group: atomic-balance-evidence-${{ github.run_id }}" in workflow


def test_empty_atomic_plan_recovers_already_published_aggregation() -> None:
    workflow = (ROOT / ".github" / "workflows" / "atomic-balance-evidence.yml").read_text()
    recovery = workflow.split(
        "      - name: Recover aggregation when the atomic plan is empty", 1
    )[1].split("      - name: Enforce truthful terminal status", 1)[0]

    assert "steps.plan.outcome == 'success'" in recovery
    assert "steps.plan.outputs.filer_ids == ''" in recovery
    assert "python scraper/process.py" in recovery


def test_completed_current_summary_sweep_hands_off_only_after_publication() -> None:
    workflow = (ROOT / ".github" / "workflows" / "earliest-balances.yml").read_text()
    handoff = workflow.split(
        "      - name: Hand off completed current sweep to atomic evidence", 1
    )[1]

    assert "env.current_only == 'true'" in handoff
    assert "env.targeted != 'true'" in handoff
    assert "steps.remaining.outputs.remaining == '0'" in handoff
    assert "steps.final_aggregation.outcome == 'success'" in handoff
    assert "steps.summary_publish.outcome == 'success'" in handoff
    assert "gh workflow run atomic-balance-evidence.yml" in handoff
    assert "dispatch_retry.sh atomic-balance-evidence.yml" not in handoff


def test_atomic_workflow_is_in_shared_orestar_lane() -> None:
    action = (ROOT / ".github" / "actions" / "await-orestar" / "action.yml").read_text()
    assert ".github/workflows/atomic-balance-evidence.yml" in action

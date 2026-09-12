"""Bounded real recapture ordering and truthful terminal behavior."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scraper"))
import stabilize_atomic_balances as RUN

SNAPSHOT = "sha256:" + "a" * 64


def _ready():
    return {
        "version": 1, "planned_at": "2026-09-12T12:00:00Z",
        "transaction_snapshot_id": SNAPSHOT, "end_date": "2026-09-12",
        "ready_scope_count": 2, "selected_scope_count": 2, "rejected_scope_count": 0,
        "scopes": [
            {"filer_ids": ids, "app_scope_transaction_digest": "sha256:" + digest * 64,
             "capture_started_at": 1001, "captured_at": 1002, "capture_day": "2026-09-12",
             "scope_capture_id": "old-" + ids[0], "captured_app_cash_on_hand": 100,
             "captured_app_tran_count": 3}
            for ids, digest in [(["10"], "b"), (["20", "30"], "c")]
        ],
    }


class Harness:
    def __init__(self, monkeypatch, tmp_path, assessments):
        self.root = tmp_path
        self.events = []
        self.commands = []
        self.assessed = []
        self.plans = []
        self.assessments = iter(assessments)
        self.fail_command = None
        self.incomplete = False
        self.uncertified = False
        self.validation_failure = None
        self.round = 0
        monkeypatch.setattr(RUN.ABE, "assess_stabilization", self.assess)
        monkeypatch.setattr(RUN.ABE, "ready_plan", self.make_ready)
        monkeypatch.setattr(RUN.ABE, "verify_plan", self.verify)
        monkeypatch.setattr(RUN.ABE, "utc_timestamp", lambda: "2026-09-13T00:00:00Z")

    def assess(self, ready, source, yearly, transactions):
        self.events.append("assess")
        self.assessed.append(copy.deepcopy(ready))
        assert transactions == self.root / "data" / "transactions"
        assert len(ready["scopes"]) == 2  # Never narrow assessment to the retried subset.
        item = next(self.assessments)
        if isinstance(item, Exception):
            raise item
        selected = [s for s in ready["scopes"] if set(s["filer_ids"]) & set(item)]
        return {"transaction_snapshot_id": SNAPSHOT, "stable_scope_count": 2 - len(selected),
                "unsettled_scope_count": len(selected), "unsettled_filer_ids": item,
                "scopes": [{"reason": "fresh_annual_treatment_changed"}]}

    def cache(self, key):
        # Explicit known-scope replanning must not depend on an actionable-only
        # discrepancy selector: annual-only retries may be absent from it.
        assert key == "balance_snapshot_source"
        return {"transaction_snapshot_id": SNAPSHOT}

    def command(self, argv):
        assert argv[0] == sys.executable
        name = {"scraper/fetch_earliest_balances.py": "summary",
                "scraper/diff_coverage.py": "diff", "scripts/pipeline_state.py": "publish",
                "scraper/process.py": "process"}[argv[1]]
        self.events.append(name)
        self.commands.append(argv)
        if name == "summary":
            self.round += 1
        if name == "publish":
            assert argv[2:] == ["push", "summaries", "auxiliary"]
        if name == "diff":
            ready_path = Path(argv[argv.index("--scope-plan") + 1])
            ready = json.loads(ready_path.read_text())
            assert argv[argv.index("--end-date") + 1] == ready["end_date"]
            assert argv[argv.index("--max-minutes") + 1] == "70"
            assert argv[argv.index("--start-year") + 1] == "2006"
            assert "--recheck" in argv
        return int(self.fail_command == name)

    def make_ready(self, plan, yearly, transactions):
        self.events.append("ready")
        self.plans.append(copy.deepcopy(plan))
        if self.validation_failure == "ready":
            raise RUN.ABE.AtomicEvidenceError("Transaction snapshot changed")
        out = copy.deepcopy(plan)
        out.update(end_date="2026-09-13", rejected_scope_count=0)
        for scope in out["scopes"]:
            scope.update(capture_started_at=2000 + self.round * 10,
                         captured_at=2001 + self.round * 10, capture_day="2026-09-13",
                         scope_capture_id=f"new-{self.round}", captured_app_cash_on_hand=50,
                         captured_app_tran_count=3)
        if self.incomplete:
            out["scopes"] = []
            out["rejected_scope_count"] = len(plan["scopes"])
        out["ready_scope_count"] = len(out["scopes"])
        return out

    def verify(self, ready, diff, transactions):
        self.events.append("verify")
        if self.validation_failure == "verify":
            raise RUN.ABE.AtomicEvidenceError("Transaction snapshot changed")
        return {"certified_scope_count": 0 if self.uncertified else len(ready["scopes"]),
                "blocked_filer_count": 1 if self.uncertified else 0}

    def run(self, **kwargs):
        return RUN.run_stabilization(_ready(), root=self.root, command_runner=self.command,
                                    cache_reader=self.cache, **kwargs)


def test_already_settled_performs_no_collection_publication_or_aggregation(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [[]])
    result = h.run()
    assert result["passes_completed"] == 1
    assert h.events == ["assess"]
    assert h.commands == []


def test_second_pass_uses_real_collectors_in_required_order(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"], []])
    result = h.run()
    assert result["passes_completed"] == 2
    assert h.events == ["assess", "summary", "ready", "diff", "verify", "publish", "process", "assess"]
    assert h.commands[0][2:] == ["--filer-ids", "10", "--force", "--current-only"]
    assert h.plans[0]["planned_at"] == "2026-09-13T00:00:00Z"
    assert h.plans[0]["transaction_snapshot_id"] == SNAPSHOT
    assert "captured_at" not in h.plans[0]["scopes"][0]
    assert h.assessed[-1]["scopes"][0]["captured_at"] == 2011
    assert h.assessed[-1]["scopes"][1] == _ready()["scopes"][1]
    assert h.assessed[-1]["planned_at"] == _ready()["planned_at"]
    assert h.assessed[-1]["end_date"] == "2026-09-13"


def test_bound_includes_first_workflow_pass_and_runs_only_two_more(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"], ["10"], ["10"]])
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="after 3 total"):
        h.run()
    assert h.events.count("summary") == 2
    assert h.events.count("diff") == 2
    assert h.events.count("process") == 2
    assert h.events.count("assess") == 3
    stored = json.loads((tmp_path / ".atomic-stabilization" / "assessment.json").read_text())
    assert stored["passes_completed"] == 3
    assert stored["unsettled_scope_count"] == 1


@pytest.mark.parametrize("limit", [0, 4, 99, True])
def test_invalid_bound_never_runs_collectors(monkeypatch, tmp_path, limit):
    h = Harness(monkeypatch, tmp_path, [])
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="between 1 and 3"):
        h.run(max_passes=limit)
    assert not h.events


def test_one_total_pass_means_assessment_only(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"]])
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="after 1 total"):
        h.run(max_passes=1)
    assert h.events == ["assess"]


def test_reassesses_previously_stable_scopes_and_preserves_their_real_capture(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"], ["20", "30"], []])
    assert h.run()["passes_completed"] == 3
    summaries = [a for a in h.commands if a[1].endswith("fetch_earliest_balances.py")]
    assert summaries[1][2:] == ["--filer-ids", "20", "30", "--force", "--current-only"]
    assert h.assessed[2]["scopes"][0] == h.assessed[1]["scopes"][0]
    assert h.assessed[2]["scopes"][1]["captured_at"] == 2021
    assert all(a["planned_at"] == _ready()["planned_at"] for a in h.assessed)


@pytest.mark.parametrize("stage", ["summary", "diff", "publish", "process"])
def test_command_failure_stops_before_any_next_pass(monkeypatch, tmp_path, stage):
    h = Harness(monkeypatch, tmp_path, [["10"]])
    h.fail_command = stage
    with pytest.raises(RUN.ABE.AtomicEvidenceError):
        h.run()
    assert h.events.count("summary") == 1
    assert h.events.count("assess") == 1
    if stage == "publish":
        assert "process" not in h.events
    else:
        assert h.events.index("publish") < h.events.index("process")
    if stage == "summary":
        assert "diff" not in h.events
    # Partial collector results are validated and durably saved before projection.
    assert h.events.index("verify") < h.events.index("publish")


def test_green_but_incomplete_summary_projects_partial_without_diff_or_continuation(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"]])
    h.incomplete = True
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="fresh paired summary"):
        h.run()
    assert h.events == ["assess", "summary", "ready", "verify", "publish", "process"]


def test_uncertified_exact_scope_projects_partial_without_continuation(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["10"]])
    h.uncertified = True
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="certifiable exact"):
        h.run()
    assert h.events[-2:] == ["publish", "process"]
    assert h.events.count("assess") == 1


@pytest.mark.parametrize("stage", ["ready", "verify"])
def test_validation_drift_never_publishes_or_aggregates(monkeypatch, tmp_path, stage):
    h = Harness(monkeypatch, tmp_path, [["10"]])
    h.validation_failure = stage
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="snapshot changed"):
        h.run()
    assert "publish" not in h.events
    assert "process" not in h.events


def test_assessment_drift_stops_before_collection(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [RUN.ABE.AtomicEvidenceError("Current capture drift")])
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="capture drift"):
        h.run()
    assert h.events == ["assess"]


def test_assessor_cannot_request_half_a_canonical_scope(monkeypatch, tmp_path):
    h = Harness(monkeypatch, tmp_path, [["20"]])
    with pytest.raises(RUN.ABE.AtomicEvidenceError, match="split the original"):
        h.run()
    assert h.events == ["assess"]


def test_workflow_stabilizes_only_after_complete_first_pass_and_blocks_chaining():
    text = (ROOT / ".github/workflows/atomic-balance-evidence.yml").read_text()
    block = text.split("      - name: Stabilize captured cash", 1)[1].split("      # If a prior", 1)[0]
    assert "id: stabilize" in block
    assert "!cancelled()" in block
    assert "steps.aggregate.outcome == 'success'" in block
    assert "steps.summaries.outcome == 'success'" in block
    assert "steps.diff.outcome == 'success'" in block
    assert "steps.verify.outputs.certified_scopes == steps.plan.outputs.selected_scopes" in block
    assert "xvfb-run --auto-servernum python scraper/stabilize_atomic_balances.py" in block
    assert '--plan "$READY_PATH" --max-passes 3' in block
    terminal = text.split("      - name: Enforce truthful terminal status", 1)[1]
    assert 'if [ "${{ steps.stabilize.outcome }}" != "success" ]; then' in terminal
    assert "success() && !cancelled()" in terminal
    assert "timeout-minutes: 360" in text


def test_empty_plan_recovery_replans_before_bounded_automatic_continuation():
    text = (ROOT / ".github/workflows/atomic-balance-evidence.yml").read_text()
    recovery = text.split("      - name: Recover aggregation when the atomic plan is empty", 1)[1]
    assert "id: recover_aggregate" in recovery
    replan = recovery.split("      - name: Replan after recovering empty-plan aggregation", 1)[1]
    assert "if: steps.recover_aggregate.outcome == 'success'" in replan
    assert "python scraper/atomic_balance_evidence.py plan" in replan
    assert '--max-scopes "$MAX_SCOPES"' in replan
    chain = text.split("      - name: Continue bounded evidence chain", 1)[1]
    assert "success() && !cancelled() && inputs.filer_ids == ''" in chain
    assert "steps.recovery_plan.outputs.selected_scopes != '0'" in chain
    assert 'MAX_CHAIN: "12"' in chain
    assert 'if [ "$CHAIN" -ge "$MAX_CHAIN" ]' in chain
    assert "Recovered aggregation left" in chain

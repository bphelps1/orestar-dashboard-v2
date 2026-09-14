"""A named effort budget survives failure, reruns, and handoff counter resets."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("atomic_evidence_effort", ROOT / "scripts" / "atomic_evidence_effort.py")
assert SPEC and SPEC.loader
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)
EFFORT = "balance-recovery-20260914"
REPOSITORY = "owner/repo"


def policy(**updates):
    return {
        "version": 1, "effort_id": EFFORT, "enabled": True,
        "max_attempts": 12, "max_scopes": 12, "max_searches": 45,
        "excluded_filer_ids": ["33", "191"], **updates,
    }


def run(rid, *, attempt=1, effort=EFFORT, status="completed", conclusion="success", **updates):
    return {
        "id": rid, "run_attempt": attempt, "workflow_id": 55,
        "path": ".github/workflows/atomic-balance-evidence.yml",
        "display_title": "Atomic balance evidence: " + effort,
        "status": status, "conclusion": conclusion, **updates,
    }


class GitHub:
    """Emulate ordinary 100-record workflow pages and the current-run endpoint."""
    def __init__(self, rows, current=None):
        self.rows = copy.deepcopy(rows)
        self.current = copy.deepcopy(current if current is not None else rows[-1])
        self.calls = []
        self.current_reads = 0

    def __call__(self, endpoint):
        self.calls.append(endpoint)
        if "/workflows/atomic-balance-evidence.yml/runs?" in endpoint:
            query = parse_qs(urlsplit(endpoint).query)
            assert query["per_page"] == ["100"]
            page = int(query["page"][0])
            return {"total_count": len(self.rows),
                    "workflow_runs": copy.deepcopy(self.rows[(page - 1) * 100:page * 100])}
        assert endpoint == f"repos/{REPOSITORY}/actions/runs/{self.current['id']}"
        self.current_reads += 1
        return copy.deepcopy(self.current)


def admit(rows, *, current=None, config=None, effort_id=EFFORT, attempt=None, api=None):
    current = current or rows[-1]
    return E.admit(config or policy(), effort_id=effort_id, repository=REPOSITORY,
                   run_id=current["id"], run_attempt=current["run_attempt"] if attempt is None else attempt,
                   api_reader=api or GitHub(rows, current))


def test_last_allowed_attempt_counts_failures_cancellations_and_reruns():
    rows = [run(1, attempt=4, conclusion="failure"),
            run(2, attempt=3, conclusion="cancelled"),
            run(3, attempt=4, status="queued", conclusion=None),
            run(4, status="in_progress", conclusion=None)]
    result = admit(rows)
    assert result["admitted"] is True
    assert result["attempts_used"] == 12
    assert result["attempts_remaining"] == 0
    assert result["max_scopes"] == 12
    assert result["max_searches"] == 45
    assert result["excluded_filer_ids"] == ["33", "191"]


def test_chain_counter_reset_and_summary_handoff_cannot_renew_budget():
    rows = [run(1, attempt=12, conclusion="failure"),
            run(2, status="in_progress", conclusion=None, chain_index=1)]
    with pytest.raises(E.EffortError, match="13 attempts exceed"):
        admit(rows)
    assert E.handoff(policy(), repository=REPOSITORY,
                     api_reader=GitHub(rows))["can_dispatch"] is False


def test_rerunning_existing_run_consumes_another_attempt():
    rows = [run(1, attempt=11), run(2, attempt=2, status="in_progress", conclusion=None)]
    with pytest.raises(E.EffortError, match="13 attempts exceed"):
        admit(rows)


def test_pagination_finds_current_and_old_effort_attempts_beyond_first_page():
    rows = [run(i, effort="older-phase") for i in range(1, 101)]
    rows += [run(101, attempt=8, conclusion="failure"), run(102, attempt=3, conclusion="cancelled"),
             run(103, status="in_progress", conclusion=None)]
    api = GitHub(rows)
    result = admit(rows, api=api)
    assert result["attempts_used"] == 12
    assert [c.rsplit("page=", 1)[-1] for c in api.calls if "per_page" in c] == ["1", "2"]
    assert api.current_reads == 2


def test_exact_effort_title_ignores_older_phase_and_similar_prefixes():
    rows = [run(1, effort=EFFORT + "-extra", attempt=40),
            run(2, effort="balance-recovery-old", attempt=20), run(3)]
    assert admit(rows)["attempts_used"] == 1


@pytest.mark.parametrize("change", [
    {"display_title": "Build Atomic Balance Evidence"},
    {"path": ".github/workflows/earliest-balances.yml"},
    {"run_attempt": 2},
])
def test_current_api_identity_or_attempt_must_match_environment(change):
    current = run(10, status="in_progress", conclusion=None)
    api_current = {**current, **change}
    api = GitHub([api_current], api_current)
    with pytest.raises(E.EffortError):
        admit([current], current=current, attempt=1, api=api)


def test_requested_effort_must_match_policy_before_api_access():
    def unexpected(_endpoint):
        pytest.fail("Mismatched effort must fail before API access")
    with pytest.raises(E.EffortError, match="does not match"):
        admit([run(1)], effort_id="replacement-counter", api=unexpected)


def test_current_run_must_be_present_in_complete_listing():
    current = run(3)
    with pytest.raises(E.EffortError, match="missing or inconsistent"):
        admit([run(1)], current=current, api=GitHub([run(1)], current))


def test_current_listed_attempt_must_match_live_current_attempt():
    current = run(3, attempt=2)
    with pytest.raises(E.EffortError, match="missing or inconsistent"):
        admit([run(3)], current=current, api=GitHub([run(3)], current))


def test_attempt_change_during_pagination_fails_closed():
    current = run(3)
    api = GitHub([current])
    def reader(endpoint):
        value = api(endpoint)
        if "/workflows/" not in endpoint and api.current_reads == 2:
            value["run_attempt"] = 2
        return value
    with pytest.raises(E.EffortError, match="changed during admission"):
        admit([current], api=reader)


def test_duplicate_run_across_pages_fails_instead_of_undercharging():
    rows = [run(i, effort="older-phase") for i in range(1, 101)] + [run(1)]
    current = run(100)
    with pytest.raises(E.EffortError, match="Duplicate"):
        admit(rows, current=current, api=GitHub(rows, current))


@pytest.mark.parametrize("payload", [
    None, {}, {"total_count": True, "workflow_runs": []},
    {"total_count": 2, "workflow_runs": [run(1)]},
    {"total_count": 0, "workflow_runs": [run(1)]},
    {"total_count": 1, "workflow_runs": [{**run(1), "run_attempt": True}]},
    {"total_count": 1, "workflow_runs": [{**run(1), "run_attempt": "1"}]},
    {"total_count": 1, "workflow_runs": [{**run(1), "run_attempt": 0}]},
    {"total_count": 1, "workflow_runs": [{**run(1), "display_title": None}]},
    {"total_count": 1, "workflow_runs": [{**run(1), "workflow_id": 56}]},
])
def test_malformed_or_truncated_history_fails_closed(payload):
    def reader(endpoint):
        return copy.deepcopy(payload) if "/workflows/" in endpoint else run(1)
    with pytest.raises(E.EffortError):
        admit([run(1)], api=reader)


def test_changing_total_between_pages_fails_closed():
    rows = [run(i, effort="older-phase") for i in range(1, 101)] + [run(101)]
    api = GitHub(rows)
    def reader(endpoint):
        value = api(endpoint)
        if endpoint.endswith("page=2"):
            value["total_count"] += 1
        return value
    with pytest.raises(E.EffortError, match="changed during pagination"):
        admit(rows, api=reader)


def test_second_page_api_failure_never_admits_partial_count():
    rows = [run(i, effort="older-phase") for i in range(1, 101)] + [run(101)]
    api = GitHub(rows)
    def reader(endpoint):
        if endpoint.endswith("page=2"):
            raise OSError("simulated network failure with sensitive detail")
        return api(endpoint)
    with pytest.raises(E.EffortError, match="GitHub API read failed") as caught:
        admit(rows, api=reader)
    assert "sensitive" not in str(caught.value)


@pytest.mark.parametrize("updates", [
    {"version": True}, {"version": 2}, {"enabled": 1},
    {"max_attempts": True}, {"max_attempts": "12"}, {"max_attempts": 0},
    {"max_scopes": 101}, {"max_scopes": -1}, {"max_searches": False}, {"max_searches": 46},
    {"effort_id": "bad\nname"}, {"excluded_filer_ids": [33]},
    {"excluded_filer_ids": ["33", "33"]}, {"excluded_filer_ids": [" 33"]},
    {"excluded_filer_ids": "33"}, {"extra": 1},
])
def test_policy_validation_rejects_ambiguous_or_coerced_values(updates):
    with pytest.raises(E.EffortError):
        E.validate_policy(policy(**updates), EFFORT, allow_disabled=True)


def test_policy_read_failure_and_invalid_json_fail_closed(tmp_path):
    missing = tmp_path / "missing.json"
    with pytest.raises(E.EffortError, match="Cannot read"):
        E.load_policy(missing)
    missing.write_text("{not json}")
    with pytest.raises(E.EffortError, match="Cannot read"):
        E.load_policy(missing)


def test_disabled_policy_denies_admission_but_handoff_returns_false():
    config = policy(enabled=False)
    rows = [run(1, attempt=4)]
    with pytest.raises(E.EffortError, match="not enabled"):
        admit(rows, config=config)
    result = E.handoff(config, repository=REPOSITORY, api_reader=GitHub(rows))
    assert result["can_dispatch"] is False
    assert result["attempts_used"] == 4
    assert result["effort_id"] == EFFORT


@pytest.mark.parametrize("used,can_dispatch,remaining", [(0, True, 12), (11, True, 1), (12, False, 0), (14, False, 0)])
def test_handoff_uses_strict_less_than_limit(used, can_dispatch, remaining):
    rows = [] if used == 0 else [run(1, attempt=used)]
    api = GitHub(rows, run(1))
    result = E.handoff(policy(), repository=REPOSITORY, api_reader=api)
    assert result["can_dispatch"] is can_dispatch
    assert result["attempts_remaining"] == remaining
    assert len(api.calls) == 1


def test_cli_handoff_and_admit_emit_safe_github_outputs(tmp_path, monkeypatch, capsys):
    config = tmp_path / "policy.json"
    config.write_text(json.dumps(policy()))
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_REPOSITORY", REPOSITORY)
    monkeypatch.setenv("GITHUB_RUN_ID", "7")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    api = GitHub([run(7, status="in_progress", conclusion=None)])
    def process(argv, **kwargs):
        assert argv[:4] == ["gh", "api", "--method", "GET"]
        assert kwargs["capture_output"] is True
        return SimpleNamespace(returncode=0, stdout=json.dumps(api(argv[4])))
    monkeypatch.setattr(E.subprocess, "run", process)
    assert E.main(["handoff", "--policy", str(config)]) == 0
    assert json.loads(capsys.readouterr().out)["can_dispatch"] is True
    assert "excluded_filer_ids=33 191\n" in output.read_text()
    assert "max_attempts=12\n" in output.read_text()
    assert E.main(["admit", "--effort-id", EFFORT, "--policy", str(config)]) == 0
    assert json.loads(capsys.readouterr().out)["admitted"] is True
    assert "admitted=true\n" in output.read_text()


@pytest.mark.parametrize("failure", ["process", "json"])
def test_cli_api_failure_emits_no_success_or_sensitive_response(tmp_path, monkeypatch, capsys, failure):
    config = tmp_path / "policy.json"
    config.write_text(json.dumps(policy()))
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_REPOSITORY", REPOSITORY)
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(E.subprocess, "run", lambda *_a, **_k: SimpleNamespace(
        returncode=1 if failure == "process" else 0, stdout="credential detail", stderr="secret"))
    assert E.main(["handoff", "--policy", str(config)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "secret" not in captured.err and "credential" not in captured.err
    assert not output.exists()


def test_checked_in_policy_has_the_approved_operational_caps():
    assert E.load_policy(E.DEFAULT_POLICY) == policy()


def test_duplicate_json_policy_fields_are_not_silently_overwritten(tmp_path):
    config = tmp_path / "duplicate.json"
    text = json.dumps(policy())
    config.write_text(text[:-1] + ',"max_attempts":120}')
    with pytest.raises(E.EffortError, match="Duplicate JSON field"):
        E.load_policy(config)


def test_duplicate_json_api_fields_fail_closed(monkeypatch):
    monkeypatch.setattr(E.subprocess, "run", lambda *_a, **_k: SimpleNamespace(
        returncode=0, stdout='{"total_count":120,"total_count":0,"workflow_runs":[]}'))
    with pytest.raises(E.EffortError, match="Duplicate JSON field"):
        E.gh_json("repos/owner/repo/actions/workflows/atomic-balance-evidence.yml/runs")


@pytest.mark.parametrize("value", [None, "", "0", " 1", "+1", "1.0", "true"])
def test_current_environment_ids_cannot_be_coerced(value):
    with pytest.raises(E.EffortError):
        E._environment_int(value, "GITHUB_RUN_ATTEMPT")

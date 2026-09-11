#!/usr/bin/env python3
"""Plan and validate one atomic balance-evidence batch.

The account summary and the exact transaction-ID diff must describe the same
application transaction snapshot, and the diff query must begin after the
summary capture.  This helper keeps that contract out of workflow shell:

* ``plan`` selects whole actionable canonical scopes that do not already have
  certifiable exact evidence and freezes the local transaction fingerprint.
* ``ready`` keeps only scopes whose complete current summaries were freshly
  paired to that fingerprint during this batch.
* ``verify`` accepts only complete-scope exact evidence collected afterward
  against the same fingerprint and date range.

The workflow deliberately runs both network collectors in one job without a
second checkout or state hydration.  A transaction snapshot mismatch is a hard
failure, never a reason to compare whatever happens to be newest.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).parent))

import supabase_sync
from balance_snapshot import (
    CALCULATION_VERSION,
    FORMAT_VERSION,
    paired_comparison,
    scope_key,
    transaction_snapshot_id,
    utc_timestamp,
)
from exact_coverage_evidence import certify_exact_scope_rows


ROOT = Path(__file__).resolve().parents[1]
TRANSACTION_DIR = ROOT / "data" / "transactions"
YEARLY_PATH = ROOT / "data" / "orestar_yearly_summaries.json"
DIFF_PATH = ROOT / "data" / "coverage_diff.json"
SNAPSHOT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PLAN_VERSION = 1


class AtomicEvidenceError(RuntimeError):
    """The batch cannot prove its atomic evidence contract."""


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except (OSError, json.JSONDecodeError) as exc:
        raise AtomicEvidenceError(f"Could not read {path}: {exc}") from exc


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def _strict_snapshot_id(value: Any) -> str:
    text = str(value or "")
    if not SNAPSHOT_RE.fullmatch(text):
        raise AtomicEvidenceError(f"Invalid transaction snapshot ID: {text!r}")
    return text


def _current_snapshot(transaction_dir: Path, expected: str | None = None) -> str:
    actual = transaction_snapshot_id(transaction_dir)
    if actual is None:
        raise AtomicEvidenceError("No local transaction shards are available")
    _strict_snapshot_id(actual)
    if expected is not None and actual != _strict_snapshot_id(expected):
        raise AtomicEvidenceError(
            f"Transaction snapshot changed: expected {expected}, found {actual}"
        )
    return actual


def _epoch(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise AtomicEvidenceError(f"Invalid capture time: {value!r}") from exc
    if not math.isfinite(result):
        raise AtomicEvidenceError(f"Invalid capture time: {value!r}")
    return result


def _iso_epoch(value: Any) -> float:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise AtomicEvidenceError(f"Invalid UTC time: {value!r}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise AtomicEvidenceError(f"Time is not explicitly UTC: {value!r}")
    return parsed.timestamp()


def _payload_rows(payload: Any) -> list[dict]:
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 2
        or payload.get("basis") != "paired_capture_window_v1"
        or not isinstance(payload.get("rows"), list)
    ):
        raise AtomicEvidenceError(
            "balance_discrepancies is not the paired-capture schema"
        )
    return [row for row in payload["rows"] if isinstance(row, dict)]


def _diff_entries(rows: Any) -> dict[str, dict]:
    if rows is None:
        return {}
    if not isinstance(rows, list):
        raise AtomicEvidenceError("coverage_diff is not a list")
    entries: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise AtomicEvidenceError("coverage_diff contains a non-object row")
        filer_id = str(row.get("filer_id") or "").strip()
        if not filer_id:
            continue
        if filer_id in entries:
            raise AtomicEvidenceError(
                f"coverage_diff contains duplicate filer {filer_id}"
            )
        entries[filer_id] = row
    return entries


def _scope_record(row: dict, source: dict) -> dict | None:
    if (
        row.get("comparison_status") != "paired"
        or row.get("newer_app_data")
        or row.get("closed")
    ):
        return None
    try:
        delta = float(row.get("delta") or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(delta) or abs(delta) <= 0.01:
        return None

    raw_ids = row.get("filer_ids") or [row.get("filer_id")]
    if not isinstance(raw_ids, list):
        return None
    ids = sorted({str(value or "").strip() for value in raw_ids})
    if not ids or "" in ids or any(not filer_id.isdigit() for filer_id in ids):
        return None

    key = scope_key(ids)
    source_scope = (source.get("scopes") or {}).get(key)
    if not isinstance(source_scope, dict):
        return None
    source_ids = sorted({
        str(value or "").strip()
        for value in source_scope.get("filer_ids", [])
    })
    scope_digest = source_scope.get("app_scope_transaction_digest")
    if (
        source_scope.get("status") == "ambiguous"
        or source_ids != ids
        or not isinstance(scope_digest, str)
        or not scope_digest.strip()
    ):
        return None

    fingerprint = row.get("transaction_snapshot_id")
    try:
        fingerprint = _strict_snapshot_id(fingerprint)
        captured_at = _epoch(row.get("scrape_ts"))
        capture_day = datetime.fromtimestamp(
            captured_at, tz=timezone.utc
        ).date().isoformat()
        tran_count = int(row.get("tran_count") or 0)
    except (AtomicEvidenceError, TypeError, ValueError, OverflowError):
        return None
    if tran_count < 0:
        return None

    return {
        "filer_ids": ids,
        "name": str(row.get("name") or ""),
        "delta": round(delta, 2),
        "tran_count": tran_count,
        "prior_captured_at": captured_at,
        "prior_transaction_snapshot_id": fingerprint,
        "app_scope_transaction_digest": scope_digest,
        "requirement": {
            "captured_at": captured_at,
            "capture_day": capture_day,
            "transaction_snapshot_id": fingerprint,
            "scope_ids": ids,
        },
    }


def _latest_attempt(scope: dict, entries: dict[str, dict]) -> str:
    values = []
    for filer_id in scope["filer_ids"]:
        row = entries.get(filer_id) or {}
        for key in ("last_attempt_at", "checked_at", "last_attempt", "checked"):
            value = row.get(key)
            if value:
                values.append(str(value))
    return max(values, default="")


def _attempt_day(value: str) -> date | None:
    """Parse precise and legacy attempt stamps for automatic cooldown."""
    if not value:
        return None
    try:
        return datetime.fromtimestamp(_iso_epoch(value), tz=timezone.utc).date()
    except AtomicEvidenceError:
        try:
            return datetime.strptime(value[:10], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return None


def build_plan(
    balance_payload: Any,
    diff_rows: Any,
    source: Any,
    transaction_dir: Path,
    *,
    max_scopes: int,
    requested_ids: Iterable[str] = (),
    planned_at: str | None = None,
) -> dict:
    """Return a bounded whole-scope plan against the current local snapshot."""
    if not 1 <= max_scopes <= 100:
        raise AtomicEvidenceError("max_scopes must be between 1 and 100")
    snapshot_id = _current_snapshot(transaction_dir)
    if (
        not isinstance(source, dict)
        or source.get("version") != FORMAT_VERSION
        or source.get("calculation_version") != CALCULATION_VERSION
        or source.get("transaction_snapshot_id") != snapshot_id
        or not isinstance(source.get("scopes"), dict)
    ):
        raise AtomicEvidenceError(
            "The live balance snapshot source does not match the local ledger"
        )

    entries = _diff_entries(diff_rows)
    scopes = []
    seen_scopes: set[tuple[str, ...]] = set()
    owners: dict[str, set[tuple[str, ...]]] = {}
    for row in _payload_rows(balance_payload):
        record = _scope_record(row, source)
        if (
            record is None
            or record["prior_transaction_snapshot_id"] != snapshot_id
        ):
            continue
        key = tuple(record["filer_ids"])
        if key in seen_scopes:
            continue
        seen_scopes.add(key)
        scopes.append(record)
        for filer_id in key:
            owners.setdefault(filer_id, set()).add(key)

    ambiguous = {
        filer_id for filer_id, owned in owners.items() if len(owned) != 1
    }
    scopes = [
        scope for scope in scopes
        if not (set(scope["filer_ids"]) & ambiguous)
    ]

    requested = {str(value).strip() for value in requested_ids if str(value).strip()}
    if requested and any(not filer_id.isdigit() for filer_id in requested):
        raise AtomicEvidenceError("Requested filer IDs must be numeric")
    if requested:
        scopes = [
            scope for scope in scopes
            if requested & set(scope["filer_ids"])
        ]
        represented = {
            filer_id for scope in scopes for filer_id in scope["filer_ids"]
        }
        missing = sorted(requested - represented)
        if missing:
            raise AtomicEvidenceError(
                "Requested filers are not in an actionable unambiguous scope: "
                + " ".join(missing)
            )

    requirements = {
        filer_id: scope["requirement"]
        for scope in scopes
        for filer_id in scope["filer_ids"]
    }
    candidate_ids = set(requirements)
    certified: dict[str, dict] = {}
    if candidate_ids:
        certified, _blocked, scan_error = certify_exact_scope_rows(
            list(entries.values()),
            requirements,
            candidate_ids,
            transaction_dir,
        )
        if scan_error:
            raise AtomicEvidenceError(
                f"Could not certify existing exact evidence: {scan_error}"
            )

    unresolved = [
        scope for scope in scopes
        if requested or not set(scope["filer_ids"]).issubset(certified)
    ]
    for scope in unresolved:
        scope["last_exact_attempt_at"] = _latest_attempt(scope, entries)
        scope.pop("requirement", None)
    # An automatic chain must not spend every child on the same F5 casualty.
    # Explicit filer IDs remain a deliberate operator override, but ordinary
    # planning cools any scope attempted during the current UTC day.
    instant = planned_at or utc_timestamp()
    instant_epoch = _iso_epoch(instant)
    all_unresolved = list(unresolved)
    if not requested:
        today = datetime.fromtimestamp(instant_epoch, tz=timezone.utc).date()
        unresolved = [
            scope for scope in unresolved
            if (_attempt_day(scope["last_exact_attempt_at"]) or date.min) < today
        ]
    deferred_count = len(all_unresolved) - len(unresolved)
    unresolved.sort(key=lambda scope: (
        scope["last_exact_attempt_at"],
        scope["tran_count"],
        -abs(scope["delta"]),
        scope["filer_ids"],
    ))
    if requested and len(unresolved) > max_scopes:
        raise AtomicEvidenceError(
            "Requested filer IDs expand to more scopes than max_scopes allows"
        )
    selected = unresolved[:max_scopes]
    return {
        "version": PLAN_VERSION,
        "planned_at": instant,
        "transaction_snapshot_id": snapshot_id,
        "candidate_scope_count": len(scopes),
        "already_anchored_scope_count": len(scopes) - len(all_unresolved),
        "remaining_scope_count": len(all_unresolved),
        "deferred_scope_count": deferred_count,
        "selected_scope_count": len(selected),
        "scopes": selected,
    }


def ready_plan(
    plan: Any,
    yearly_cache: Any,
    transaction_dir: Path,
    *,
    now: datetime | None = None,
) -> dict:
    """Keep only complete scopes freshly paired during this batch."""
    if not isinstance(plan, dict) or plan.get("version") != PLAN_VERSION:
        raise AtomicEvidenceError("Unsupported or malformed atomic plan")
    snapshot_id = _current_snapshot(
        transaction_dir, str(plan.get("transaction_snapshot_id") or "")
    )
    if not isinstance(yearly_cache, dict):
        raise AtomicEvidenceError("Yearly summary cache is not an object")
    planned_epoch = _iso_epoch(plan.get("planned_at"))
    ready, rejected = [], []
    raw_scopes = plan.get("scopes")
    if not isinstance(raw_scopes, list):
        raise AtomicEvidenceError("Atomic plan scopes are not a list")
    for raw_scope in raw_scopes:
        if not isinstance(raw_scope, dict):
            raise AtomicEvidenceError("Atomic plan contains a non-object scope")
        scope = dict(raw_scope)
        ids = scope.get("filer_ids")
        if not isinstance(ids, list) or not ids:
            raise AtomicEvidenceError("Atomic plan contains an invalid scope")
        comparison = paired_comparison(
            ids,
            yearly_cache,
            current_transaction_id=snapshot_id,
            current_scope_digest=scope.get("app_scope_transaction_digest"),
        )
        reason = None
        if comparison.get("status") != "paired":
            reason = comparison.get("reason") or "not_paired"
        elif comparison.get("app_transaction_snapshot_id") != snapshot_id:
            reason = "transaction_snapshot_mismatch"
        elif sorted(comparison.get("filer_ids") or []) != sorted(ids):
            reason = "scope_membership_mismatch"
        elif comparison.get("scope_digest_matches_capture") is not True:
            reason = "scope_digest_mismatch"
        elif comparison.get("orestar_data_changed_since_capture"):
            reason = "newer_unpaired_summary_attempt"
        elif _epoch(comparison.get("capture_started_at")) <= planned_epoch:
            reason = "not_freshly_captured"
        if reason:
            rejected.append({"filer_ids": ids, "reason": reason})
            continue
        captured_at = _epoch(comparison.get("captured_at"))
        scope.update({
            "capture_started_at": _epoch(comparison.get("capture_started_at")),
            "captured_at": captured_at,
            "capture_day": datetime.fromtimestamp(
                captured_at, tz=timezone.utc
            ).date().isoformat(),
        })
        ready.append(scope)

    current_day = (now or datetime.now(timezone.utc)).astimezone(
        timezone.utc
    ).date().isoformat()
    end_date = max(
        [current_day, *(scope["capture_day"] for scope in ready)]
    )
    return {
        **{key: value for key, value in plan.items() if key != "scopes"},
        "end_date": end_date,
        "ready_scope_count": len(ready),
        "rejected_scope_count": len(rejected),
        "scopes": ready,
        "rejected_scopes": rejected,
    }


def requirements_from_ready_plan(
    ready: Any,
    snapshot_id: str,
    *,
    end_date: str | None = None,
) -> tuple[list[list[str]], dict[str, dict], dict[str, str]]:
    """Validate a ready plan and derive its fresh paired requirements.

    Both the collector and the final verifier call this function.  That keeps
    scope membership and provenance tied to the just-written yearly cache,
    rather than letting the exact collector reread stale generated details
    from the database before the final aggregation exists.
    """
    if not isinstance(ready, dict) or ready.get("version") != PLAN_VERSION:
        raise AtomicEvidenceError("Unsupported or malformed ready plan")
    snapshot_id = _strict_snapshot_id(snapshot_id)
    if ready.get("transaction_snapshot_id") != snapshot_id:
        raise AtomicEvidenceError("Ready plan transaction snapshot does not match")
    planned_epoch = _iso_epoch(ready.get("planned_at"))
    try:
        plan_end = datetime.strptime(
            str(ready.get("end_date") or ""), "%Y-%m-%d"
        ).date().isoformat()
    except ValueError as exc:
        raise AtomicEvidenceError("Ready plan has an invalid end date") from exc
    if end_date is not None and plan_end != end_date:
        raise AtomicEvidenceError(
            f"Ready plan end date changed: expected {end_date}, found {plan_end}"
        )

    scopes: list[list[str]] = []
    requirements: dict[str, dict] = {}
    active_ranges: dict[str, str] = {}
    seen: set[str] = set()
    raw_scopes = ready.get("scopes")
    if not isinstance(raw_scopes, list):
        raise AtomicEvidenceError("Ready plan scopes are not a list")
    if ready.get("ready_scope_count") != len(raw_scopes):
        raise AtomicEvidenceError("Ready plan scope count is inconsistent")
    for raw_scope in raw_scopes:
        if not isinstance(raw_scope, dict):
            raise AtomicEvidenceError("Ready plan contains a non-object scope")
        raw_ids = raw_scope.get("filer_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise AtomicEvidenceError("Ready plan contains an invalid scope")
        ids = [str(value or "").strip() for value in raw_ids]
        if (
            ids != sorted(set(ids))
            or any(not filer_id.isdigit() for filer_id in ids)
            or seen.intersection(ids)
        ):
            raise AtomicEvidenceError(
                "Ready plan scopes must be canonical, numeric, and disjoint"
            )
        capture_started_at = _epoch(raw_scope.get("capture_started_at"))
        captured_at = _epoch(raw_scope.get("captured_at"))
        if not planned_epoch < capture_started_at <= captured_at:
            raise AtomicEvidenceError(
                "Ready plan capture did not begin after planning"
            )
        capture_day = datetime.fromtimestamp(
            captured_at, tz=timezone.utc
        ).date().isoformat()
        if raw_scope.get("capture_day") != capture_day:
            raise AtomicEvidenceError("Ready plan capture day does not match its time")
        if plan_end < capture_day:
            raise AtomicEvidenceError("Ready plan exact range ends before capture day")
        digest = raw_scope.get("app_scope_transaction_digest")
        if not isinstance(digest, str) or not digest.strip():
            raise AtomicEvidenceError("Ready plan scope digest is missing")
        requirement = {
            "captured_at": captured_at,
            "capture_day": capture_day,
            "transaction_snapshot_id": snapshot_id,
            "scope_ids": ids,
            "active_range_end": plan_end,
            "active_range_conflict": False,
        }
        scopes.append(ids)
        seen.update(ids)
        for filer_id in ids:
            requirements[filer_id] = requirement
            active_ranges[filer_id] = plan_end
    return scopes, requirements, active_ranges


def verify_plan(
    ready: Any,
    diff_rows: Any,
    transaction_dir: Path,
) -> dict:
    """Certify newly collected exact evidence at complete-scope granularity."""
    if not isinstance(ready, dict) or ready.get("version") != PLAN_VERSION:
        raise AtomicEvidenceError("Unsupported or malformed ready plan")
    snapshot_id = _current_snapshot(
        transaction_dir, str(ready.get("transaction_snapshot_id") or "")
    )
    scope_ids, requirements, active_ranges = requirements_from_ready_plan(
        ready, snapshot_id
    )

    entries = _diff_entries(diff_rows)
    certified, blocked, scan_error = certify_exact_scope_rows(
        list(entries.values()),
        requirements,
        requirements,
        transaction_dir,
        active_ranges=active_ranges,
    )
    if scan_error:
        raise AtomicEvidenceError(f"Exact evidence verification failed: {scan_error}")

    certified_scopes = [ids for ids in scope_ids if set(ids).issubset(certified)]
    certified_ids = {
        filer_id for scope in certified_scopes for filer_id in scope
    }
    certified_rows = [certified[filer_id] for filer_id in sorted(certified_ids)]
    return {
        "version": PLAN_VERSION,
        "transaction_snapshot_id": snapshot_id,
        "end_date": ready.get("end_date"),
        "ready_scope_count": len(scope_ids),
        "certified_scope_count": len(certified_scopes),
        "certified_filer_count": len(certified_ids),
        "blocked_filer_count": len(set(requirements) - certified_ids),
        "missing_id_count": sum(len(row.get("missing") or []) for row in certified_rows),
        "surplus_id_count": sum(len(row.get("surplus") or []) for row in certified_rows),
        "blocked_filer_ids": sorted(
            (set(requirements) - certified_ids) | set(blocked)
        ),
    }


def _load_plan(path: Path) -> dict:
    value = _read_json(path)
    if not isinstance(value, dict):
        raise AtomicEvidenceError(f"No valid plan at {path}")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("--max-scopes", type=int, default=40)
    plan_parser.add_argument("--filer-ids", nargs="*", default=[])
    plan_parser.add_argument("--output", type=Path, required=True)

    ready_parser = subparsers.add_parser("ready")
    ready_parser.add_argument("--plan", type=Path, required=True)
    ready_parser.add_argument("--output", type=Path, required=True)

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--plan", type=Path, required=True)
    verify_parser.add_argument("--output", type=Path, required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            value = build_plan(
                supabase_sync.require_dashboard_cache("balance_discrepancies"),
                _read_json(DIFF_PATH, []),
                supabase_sync.require_dashboard_cache("balance_snapshot_source"),
                TRANSACTION_DIR,
                max_scopes=args.max_scopes,
                requested_ids=args.filer_ids,
            )
            _write_json(args.output, value)
            print(
                "ATOMIC_PLAN "
                f"snapshot={value['transaction_snapshot_id']} "
                f"selected_scopes={value['selected_scope_count']} "
                f"remaining_scopes={value['remaining_scope_count']}"
            )
        elif args.command == "ready":
            value = ready_plan(
                _load_plan(args.plan),
                _read_json(YEARLY_PATH, {}),
                TRANSACTION_DIR,
            )
            _write_json(args.output, value)
            print(
                "ATOMIC_READY "
                f"ready_scopes={value['ready_scope_count']} "
                f"rejected_scopes={value['rejected_scope_count']} "
                f"end_date={value['end_date']}"
            )
        else:
            value = verify_plan(
                _load_plan(args.plan),
                _read_json(DIFF_PATH, []),
                TRANSACTION_DIR,
            )
            _write_json(args.output, value)
            print(
                "ATOMIC_VERIFY "
                f"certified_scopes={value['certified_scope_count']} "
                f"certified_filers={value['certified_filer_count']} "
                f"blocked_filers={value['blocked_filer_count']} "
                f"missing_ids={value['missing_id_count']} "
                f"surplus_ids={value['surplus_id_count']}"
            )
    except (AtomicEvidenceError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

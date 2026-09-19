"""Re-reading lumped "Miscellaneous" rows, and measuring what it re-prices.

ORESTAR edits lumped "Miscellaneous ... $100 and under" rows in place: the
Tran ID, status and filed date stay the same while the amount changes (Eli for
Portland 5675002: $340 -> $830). A filed-date window is never fetched twice,
so the fetcher re-reads just these rows, and the merge measures every row the
re-read re-prices. No browser or database is used here.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent / "scraper"))

import fetch as F  # noqa: E402
import process as P  # noqa: E402


def test_windows_partition_the_range_at_any_size() -> None:
    for days in (7, 28, 91):
        windows = list(F.week_windows(date(2006, 1, 1), date(2026, 9, 19), days))
        assert windows[0][0] == date(2006, 1, 1)
        assert windows[-1][1] == date(2026, 9, 19)
        for (a_start, a_end), (b_start, _) in zip(windows, windows[1:]):
            assert (b_start - a_end).days == 1
            assert (a_end - a_start).days == days - 1


def test_reread_tasks_ask_only_for_lumped_rows() -> None:
    tasks = F._range_tasks(date(2026, 7, 1), date(2026, 9, 19), F.MISC_TYPES,
                           F.MISC_RECENT_WINDOW_DAYS, F.MISC_PREFIX)
    assert {t[5] for t in tasks} == {"Miscellaneous"}
    assert {t[0] for t in tasks} == {"C", "E", "O", "OD", "OR"}
    # The rolling pass stays small: ten searches or so a day.
    recent = F._range_tasks(date(2026, 7, 25), date(2026, 9, 19), F.MISC_TYPES,
                            F.MISC_RECENT_WINDOW_DAYS, F.MISC_PREFIX)
    assert len(recent) <= 15


def test_remaining_count_mirrors_the_fetcher_and_its_own_log(tmp_path, monkeypatch, capsys) -> None:
    log = tmp_path / "fetched_windows_misc.json"
    monkeypatch.setattr(F, "FETCHED_LOG_MISC", log)
    tasks = F._range_tasks(date(2026, 1, 1), date.today(), F.MISC_TYPES,
                           F.MISC_REREAD_WINDOW_DAYS, F.MISC_PREFIX)

    assert F.count_misc_remaining(2026) == len(tasks)
    F._save_fetched({F._task_key(t) for t in tasks[:3]}, log)
    assert F.count_misc_remaining(2026) == len(tasks) - 3
    # Progress lives in its own log, never in the permanent fetch logs.
    assert log not in (F.FETCHED_LOG, F.FETCHED_LOG_TRN)
    capsys.readouterr()


def test_a_rolling_reread_records_no_progress() -> None:
    F._save_fetched({("C", "2026-01-01", "2026-01-28")}, None)   # no-op, no error


def test_the_merge_measures_rows_a_download_repriced() -> None:
    existing = pd.DataFrame([
        {"tran_id": "5675002", "amount": 340.0},
        {"tran_id": "5686507", "amount": 65.0},
        {"tran_id": "5505204", "amount": 350.0},
    ])
    incoming = pd.DataFrame([
        {"tran_id": "5675002", "amount": "$830.00", "filer id": "23295",
         "contributor_payee": "Miscellaneous Cash Contributions $100 and under"},
        {"tran_id": "5686507", "amount": "215", "filer id": "23295",
         "contributor_payee": "Miscellaneous Cash Contributions $100 and under"},
        {"tran_id": "5505204", "amount": "350.00", "filer id": "23295",
         "contributor_payee": "A Donor"},
        {"tran_id": "9999999", "amount": "25", "filer id": "23295",
         "contributor_payee": "New Row"},
    ])

    result = P._amount_updates(existing, incoming)

    assert result["rows"] == 2
    assert result["miscellaneous_rows"] == 2
    assert result["net"] == 640.0
    assert {r["tran_id"]: (r["old"], r["new"]) for r in result["sample"]} == {
        "5675002": (340.0, 830.0), "5686507": (65.0, 215.0)}


def test_repriced_rows_are_appended_to_the_published_record(tmp_path, monkeypatch) -> None:
    path = tmp_path / "amount_updates.json"
    monkeypatch.setattr(P, "AMOUNT_UPDATES_PATH", path)
    existing = pd.DataFrame([{"tran_id": "1", "amount": 10.0}])

    P._record_amount_updates(existing, pd.DataFrame([{"tran_id": "1", "amount": "10"}]))
    assert not path.exists()                     # nothing re-priced, nothing written

    P._record_amount_updates(existing, pd.DataFrame([{"tran_id": "1", "amount": "12.5"}]))
    P._record_amount_updates(existing, pd.DataFrame([{"tran_id": "1", "amount": "11"}]))
    history = json.loads(path.read_text())
    assert [entry["net"] for entry in history] == [2.5, 1.0]
    assert all(entry["rows"] == 1 and entry["at"] for entry in history)

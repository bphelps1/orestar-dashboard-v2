"""The daily top_donors build records which saved merges it applied, in the
same form the Donors tab computes (docs/lib/identity.js), so the tab can use
the stored ranking instead of re-ranking ~2M contributions live."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scraper"))

import refresh_donor_aggregates as r  # noqa: E402

ROWS = [("a", "a"), ("b", "a"), ("é9", "a")]


class Cursor:
    def __init__(self, rows=ROWS, log=None):
        self.rows, self.log = rows, log if log is not None else []

    def execute(self, sql, *args):
        self.log.append(" ".join(sql.split())[:60])

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        # "select count(*) from donors" has rows; there is no contributor-type blob.
        return [1] if "count(*)" in self.log[-1] else None


def test_fingerprint_matches_the_browser_and_ignores_row_order():
    # tests/identity_frontend.test.cjs expects this same value for these rows.
    assert r.identity_fingerprint(Cursor()) == "v1:3:e82ff12a"
    assert r.identity_fingerprint(Cursor(list(reversed(ROWS)))) == "v1:3:e82ff12a"
    assert r.identity_fingerprint(Cursor(ROWS[:2])) != "v1:3:e82ff12a"


def test_the_build_takes_the_fingerprint_before_staging_and_stores_it(monkeypatch):
    order, written = [], {}

    class Conn:
        def __init__(self):
            self.cur = Cursor(log=order)

        def cursor(self):
            return self.cur

        def commit(self):
            order.append("commit")

        def close(self):
            pass

    monkeypatch.setattr(r.s, "_connect", lambda *a, **k: Conn())
    real_fingerprint = r.identity_fingerprint
    monkeypatch.setattr(r, "identity_fingerprint", lambda cur: (order.append("fingerprint"), real_fingerprint(cur))[1])
    monkeypatch.setattr(r, "stage_donor_rows", lambda cur: order.append("stage"))
    monkeypatch.setattr(r, "build_top_donors", lambda cur: {"all_time": [], "by_year": {}})
    monkeypatch.setattr(r, "_upsert", lambda conn, cur, key, data: written.setdefault(key, data))
    monkeypatch.setattr(r, "rebuild_filer_donors", lambda cur: 0)
    monkeypatch.setattr(r, "canonical_to_entity", lambda cur: {})

    assert r.main() == 0
    assert order.index("fingerprint") < order.index("stage"), "a merge saved mid-build must not look included"
    assert written["top_donors"]["identity_fingerprint"] == "v1:3:e82ff12a"

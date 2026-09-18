"""ORESTAR Certificates of Limited Contributions and Expenditures.

A committee that expects to raise and spend little may file a certificate for a
calendar year. While it is in force the committee does not itemize its
transactions. ORESTAR builds each year's account summary from itemized
transactions, so a certificate year shows no activity and closes at the balance
it opened with — yet the committee's cash really moves, and ORESTAR states the
result in a LATER year's opening balance. The prior year's ending and the next
year's "Beginning Balance (Previous Year)" then disagree, on ORESTAR's own
pages, read in a single sitting.

That is the whole mechanism behind the year-boundary breaks in ORESTAR's
balance chain. Measured 2026-09-18 across all 4,541 certificates ORESTAR holds
(2007-2026) against every consecutive pair of annual summaries:

    certificate on an adjacent year   2,140 boundaries   868 breaks   40.6%
    committee never certified        26,886 boundaries     9 breaks    0.03%

868 of 878 breaks (98.9%) touch a certificate year. Friends of Daniel Bunn
(15764) is the worked example: certificates for 2013, 2014 and 2015; breaks of
+$2,500, +$2,500 and +$3,250 into 2014, 2015 and 2016; and 2012 and 2016,
which he itemized, chain cleanly. The $8,250 is money he really handled — it is
spent through ordinary itemized expenditures in 2016 and 2017.

This module holds the pure logic: reading the certificate search, and turning
ORESTAR's own restatements into ghost rows. Fetching lives in
fetch_certificates.py and applying the rows lives in process.py, so each piece
can be tested without a browser or a full aggregation.
"""

from __future__ import annotations

import re
from datetime import date
from html.parser import HTMLParser
from typing import Any, Iterable

CERTIFICATES_FILENAME = "orestar_certificates.json"
FORMAT_VERSION = 1

# A ghost row is a DERIVED record, never an ORESTAR transaction. The id prefix
# and sub_type make that impossible to miss in any downstream listing, and keep
# the rows out of every exact-identity comparison: they are generated during
# aggregation and are never written into the transaction mirror, whose rows
# must stay an exact copy of what ORESTAR returns.
GHOST_ID_PREFIX = "ghost-certificate-"
GHOST_SUB_TYPE = "Certificate Period Restatement (derived)"

# The results table always carries this header, even for a year with no
# certificates. Its presence is the success signal: F5's challenge scripts
# are embedded in real pages too, so their markers cannot distinguish a
# block from a result.
_HEADER_CELLS = ("year", "date filed", "committee", "expiration date", "submitted by")
_FILER_ID_RE = re.compile(r"\((\d+)\)\s*$")
_DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")


class _TableRows(HTMLParser):
    """Collect every leaf <tr>'s cell texts, ignoring layout tables.

    ORESTAR nests its results table inside page-layout tables. A row counts
    only if no other table opens inside it, which is what separates the five
    certificate columns from the outer tables that contain the whole page.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._stack: list[dict] = []   # open <tr>s: {"cells", "cell", "nested"}

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            for row in self._stack:
                row["nested"] = True
        elif tag == "tr":
            self._stack.append({"cells": [], "cell": None, "nested": False})
        elif tag in ("td", "th") and self._stack:
            self._stack[-1]["cell"] = []
        elif tag == "br" and self._stack and self._stack[-1]["cell"] is not None:
            self._stack[-1]["cell"].append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._stack:
            row = self._stack[-1]
            if row["cell"] is not None:
                row["cells"].append("".join(row["cell"]))
                row["cell"] = None
        elif tag == "tr" and self._stack:
            row = self._stack.pop()
            if not row["nested"]:
                self.rows.append(row["cells"])

    def handle_data(self, data: str) -> None:
        if self._stack and self._stack[-1]["cell"] is not None:
            self._stack[-1]["cell"].append(data)


def _clean(text: str) -> str:
    return " ".join(text.replace("\xa0", " ").split())


def parse_certificate_page(html: str, year: int) -> list[dict] | None:
    """Certificates listed on one year's search result, or None if unrendered.

    None means the results table never appeared — a bot challenge, an error
    page, a timeout. An empty list means the table rendered and the year truly
    has no certificates. Callers must not confuse the two: treating a failed
    load as "no certificates" would silently remove ghost rows and move
    balances.
    """
    parser = _TableRows()
    parser.feed(html or "")
    parser.close()
    header_seen = False
    out: list[dict] = []
    for cells in parser.rows:
        texts = [_clean(c) for c in cells]
        if len(texts) == 5 and tuple(t.lower() for t in texts) == _HEADER_CELLS:
            header_seen = True
            continue
        if len(texts) != 5 or texts[0] != str(year):
            continue
        # The committee cell is "Candidate, Name<br>Committee Name (12345)" or
        # just "Committee Name (12345)". The trailing parenthesised number is
        # the filer id, and it is the only part relied on.
        committee_lines = [_clean(line) for line in cells[2].split("\n") if _clean(line)]
        committee = committee_lines[-1] if committee_lines else ""
        match = _FILER_ID_RE.search(committee)
        if not match:
            continue
        filed = texts[1] if _DATE_RE.match(texts[1]) else None
        expires = texts[3] if _DATE_RE.match(texts[3]) else None
        out.append({
            "filer_id": match.group(1),
            "committee": _FILER_ID_RE.sub("", committee).strip(),
            "filed": filed,
            "expires": expires,
            "submitted_by": texts[4] or None,
        })
    return out if header_seen else None


def merge_certificates(
    previous: dict | None,
    fetched: dict[int, list[dict] | None],
    fetched_at: str,
) -> tuple[dict, list[int]]:
    """Fold one run's per-year results into the stored file.

    Returns (payload, years_kept_from_previous). A year that failed to render
    keeps its previous certificates rather than being dropped, and a year that
    rendered EMPTY where it previously held certificates is treated as a failed
    read too — ORESTAR does not revoke a whole year's filings, so an empty page
    there is far likelier a bad load than a real change. Either way the stored
    certificates would otherwise vanish and every affected balance would jump
    back on the next aggregation.
    """
    prior_years = ((previous or {}).get("years") or {})
    years: dict[str, dict] = {str(k): v for k, v in prior_years.items()}
    kept: list[int] = []
    for year, rows in sorted(fetched.items()):
        key = str(year)
        prior_rows = (prior_years.get(key) or {}).get("certificates") or []
        if rows is None or (not rows and prior_rows):
            if key in prior_years:
                kept.append(year)
            continue
        years[key] = {"fetched_at": fetched_at, "certificates": rows}
    return {"version": FORMAT_VERSION, "years": years}, kept


def certificates_by_filer(payload: Any) -> dict[str, dict[int, dict]]:
    """filer_id -> {year: certificate} from the stored file. Tolerates absence."""
    out: dict[str, dict[int, dict]] = {}
    if not isinstance(payload, dict):
        return out
    for key, entry in (payload.get("years") or {}).items():
        try:
            year = int(key)
        except (TypeError, ValueError):
            continue
        for cert in (entry or {}).get("certificates") or []:
            fid = str((cert or {}).get("filer_id") or "").strip()
            if fid.isdigit():
                out.setdefault(fid, {})[year] = {
                    "filed": cert.get("filed"),
                    "expires": cert.get("expires"),
                }
    return out


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def certificate_restatements(
    orestar_years: dict,
    certificate_years: Iterable[int],
) -> list[dict]:
    """Ghost rows for the balance ORESTAR restated around certificate years.

    For every consecutive pair of ORESTAR annual summaries where at least one
    of the two years was a certificate year, ORESTAR's opening for the later
    year minus its closing for the earlier one is money that moved without
    being itemized. Each such step becomes one ghost row:

      * leaving a certificate year  -> dated 31 December of that year, the
        year the unitemized activity belongs to;
      * entering a certificate year from an itemized one -> dated 1 January
        of the certificate year, where ORESTAR restated the opening.

    Either way every ghost row sits inside a certificate year.

    The amounts are ORESTAR's own figures, independent of anything we hold.
    That is deliberate. It cannot double-count itemized rows we already have
    inside a certificate year (e.g. after a certificate expired mid-year),
    because ORESTAR's closing figure already includes those. And it cannot
    absorb an unrelated gap in our data, which a "set our balance to ORESTAR's
    opening" rule would: across all 308 points where a certificate period ends,
    the two agree to the cent in 306, and the other two differ by $93.73 in
    total — a real, separate gap that stays visible rather than being
    relabelled as certificate activity.

    Boundaries where ORESTAR's chain holds produce nothing, and a break with no
    certificate on either side is left alone: those nine cases in 26,886 are
    unexplained, and a ghost row would hide them.
    """
    certs = {int(y) for y in certificate_years}
    if not certs or not isinstance(orestar_years, dict):
        return []
    years = sorted(int(y) for y in orestar_years if str(y).isdigit())
    rows: list[dict] = []
    for prior, year in zip(years, years[1:]):
        if year - prior != 1 or (prior not in certs and year not in certs):
            continue
        prior_end = _number((orestar_years.get(str(prior)) or {}).get("ending_cash_balance"))
        opening = _number((orestar_years.get(str(year)) or {}).get("beginning_balance"))
        if prior_end is None or opening is None:
            continue
        step = round(opening - prior_end, 2)
        if abs(step) <= 0.005:
            continue
        leaving = prior in certs
        when = date(prior, 12, 31) if leaving else date(year, 1, 1)
        rows.append({
            "date": when.isoformat(),
            "year": when.year,
            "amount": step,
            "boundary": [prior, year],
            "orestar_prior_ending": round(prior_end, 2),
            "orestar_opening": round(opening, 2),
            "placement": "certificate_year_end" if leaving else "certificate_year_start",
        })
    return rows

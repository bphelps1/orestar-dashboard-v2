"""Seed PARTNER designations from a FuturePAC-style lobby list.

The 2024 lobby list ranks every lobbyist Partner / 1 / 2 / 3. Tiers 1–3 are
recomputed from giving by the Recommend page, but PARTNER is a standing
relationship with one caucus and cannot be derived — it lives in
lobbyist_partners (migration 017), keyed by chamber and party.

The list itself is private and is NOT in this repo: pass the path to the JSON
export (the same file `match_lobbyists.py --sheet2024` takes), whose rows carry
first/last/firm/email/cell and a `tier` of "PARTNER" for the ones seeded here.

A partner is matched to an existing lobbyist by email first, then by exact
name — the list has typos ("Thiesen" for "Theisen") but the address is right.
Anyone still unmatched is added as a lobbyist, the same way the list's other
additions were.

    python scripts/seed_partners_2024.py lobby2024.json              # dry run
    python scripts/seed_partners_2024.py lobby2024.json --apply
    python scripts/seed_partners_2024.py list.json --chamber senate --party R
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
import supabase_sync as s  # noqa: E402

SET_BY = "2024 lobby list (FuturePAC)"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("sheet", help="path to the lobby list JSON export")
    p.add_argument("--chamber", default="house", choices=["house", "senate"])
    p.add_argument("--party", default="D", choices=["D", "R"])
    p.add_argument("--apply", action="store_true", help="write the rows (otherwise dry run)")
    return p.parse_args()


def find_lobbyist(cur, row):
    email = (row.get("email") or "").strip().lower()
    if email:
        cur.execute("select lobbyist_id, name from lobbyists where lower(email) = %s", (email,))
        hit = cur.fetchone()
        if hit:
            return hit, "email"
    name = " ".join(f"{row['first']} {row['last']}".split())
    cur.execute("select lobbyist_id, name from lobbyists where lower(name) = lower(%s) order by lobbyist_id",
                (name,))
    hit = cur.fetchone()
    return (hit, "name") if hit else (None, None)


def add_lobbyist(cur, row):
    name = " ".join(f"{row['first']} {row['last']}".split())
    cur.execute("""insert into lobbyists (kind, name, first_name, last_name, firm, email, phone,
                                          source, notes)
                   values ('person', %s, %s, %s, %s, %s, %s, 'sheet_2024', %s)
                   returning lobbyist_id, name""",
                (name, row["first"].strip(), row["last"].strip(), (row.get("firm") or "").strip() or None,
                 (row.get("email") or "").strip().lower() or None,
                 (row.get("cell") or row.get("work") or "").strip() or None,
                 f"Added from the {SET_BY}; not listed on Capitol Club."))
    return cur.fetchone()


def main():
    args = parse_args()
    rows = [r for r in json.loads(Path(args.sheet).read_text())
            if (r.get("tier") or "").strip().upper() == "PARTNER"]
    if not rows:
        raise SystemExit("no rows with tier PARTNER in that file")

    conn = s._connect()
    cur = conn.cursor()
    added = 0
    for row in rows:
        hit, how = find_lobbyist(cur, row)
        if not hit:
            hit = add_lobbyist(cur, row)
            how = "added"
        lid, name = hit
        cur.execute("""insert into lobbyist_partners (lobbyist_id, chamber, party, set_by)
                       values (%s, %s, %s, %s)
                       on conflict (lobbyist_id, chamber, party) do nothing""",
                    (lid, args.chamber, args.party, SET_BY))
        added += cur.rowcount
        print(f"  {name:28} #{lid:<5} matched by {how}")
    print(f"{len(rows)} partners in the list, {added} new {args.chamber}/{args.party} designations")

    if args.apply:
        conn.commit()
        print("applied")
    else:
        conn.rollback()
        print("dry run — nothing written (pass --apply to write)")


if __name__ == "__main__":
    main()

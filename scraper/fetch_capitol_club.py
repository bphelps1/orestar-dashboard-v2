#!/usr/bin/env python3
"""
fetch_capitol_club.py — scrape the Oregon Capitol Club lobbyist directory.

oregoncapitolclub.org/user/ lists every member lobbyist as a vCard: name, a
title/firm line, mailing address, email, phones, category (Association /
Independent / Corporate) and the clients they represent. The industry pages
classify clients by industry. This is the only published lobbyist → client
list we have, and it changes during session, so it is re-read rather than
kept as a static seed.

Replaces the standalone ~/Desktop/ClaudeProjects/capitol_club_scraper, which
dropped the address block and had a fixed page count.

Output: data/capitol_club.json
  { "scraped_at": iso, "members": [ {cc_id, name, affiliation, address, city,
     state, zip, email, phone, phone_alt, category, preferred_contact,
     clients: [..], industries: {client: [..]}} ] }

With --sync (and Supabase credentials), upserts `lobbyists` and
`lobbyist_clients`: members are matched by Capitol Club id; a client pair
Capitol Club no longer lists is marked inactive rather than deleted.

Cloudflare fronts the site and rejects the default python-requests agent, so
a browser User-Agent is sent.

Usage:
    python scraper/fetch_capitol_club.py            # scrape → JSON
    python scraper/fetch_capitol_club.py --sync     # scrape → JSON → Supabase
    python scraper/fetch_capitol_club.py --sync --from-json   # re-sync last scrape
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from lobby_match import norm_org  # noqa: E402

log = logging.getLogger(__name__)

MEMBER_URL = "https://oregoncapitolclub.org/user/"
INDUSTRY_URL = "https://oregoncapitolclub.org/industry/"
OUT_PATH = Path(__file__).parent.parent / "data" / "capitol_club.json"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
}
MAX_PAGES = 60          # safety stop; the directory is ~19 pages (WordPress ?paged=N)
PAGE_DELAY = 1.0

_CATEGORIES = ("Independent", "Corporate", "Association")


def _text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip() if el else ""


def parse_profile(profile) -> dict | None:
    """One .user-profile block → member dict."""
    title = profile.select_one(".profile-title a") or profile.select_one(".profile-title")
    name = _text(title) or _text(profile.select_one(".fn"))
    if not name:
        return None

    adr = profile.select_one(".adr")
    street = [_text(s) for s in adr.select(".street-address")] if adr else []
    # The first street-address line is usually a title/firm ("SVP, CFM
    # Advocates"), not a street. Treat a line that starts with a digit or
    # "PO Box" as the street; everything before it is affiliation.
    affiliation, address_lines = [], []
    for line in street:
        if address_lines or re.match(r"^(\d|p\.?\s*o\.?\s*box)", line, re.I):
            address_lines.append(line)
        else:
            affiliation.append(line)

    email_el = profile.select_one('a[href^="mailto:"]')
    # Some cards put a website behind a tel: link; keep only phone-shaped text.
    phones = [t for t in (_text(a) for a in profile.select('a[href^="tel:"]'))
              if re.fullmatch(r"[\d\s().+-]{7,}(?:\s*(?:x|ext\.?)\s*\d+)?", t, re.I)]
    cell = _text(profile.select_one(".tel a.cell"))
    phone = cell if cell in phones else (phones[0] if phones else "")
    phone_alt = next((p for p in phones if p != phone), "")

    klass = _text(profile.select_one(".classification"))
    category = next((c for c in _CATEGORIES if c in klass), "")
    if not category:
        body = profile.get_text(" ")
        category = next((c for c in _CATEGORIES if c in body), "")

    preferred = ""
    for div in profile.select(".right-text div"):
        t = _text(div)
        if t.lower().startswith("preferred contact method"):
            preferred = t[len("preferred contact method"):].strip(" :")

    clients = [_text(a) for a in profile.select(".client-list a") if _text(a)]

    return {
        "cc_id": profile.get("id") or "",
        "name": name,
        "affiliation": "; ".join(affiliation),
        "address": ", ".join(address_lines),
        "city": _text(adr.select_one(".locality")) if adr else "",
        "state": _text(adr.select_one(".region")) if adr else "",
        "zip": _text(adr.select_one(".postal-code")) if adr else "",
        "email": _text(email_el).lower(),
        "phone": phone,
        "phone_alt": phone_alt,
        "category": category,
        "preferred_contact": preferred,
        "clients": clients,
    }


def scrape_members(session) -> list[dict]:
    members, seen = [], set()
    for page in range(1, MAX_PAGES + 1):
        url = MEMBER_URL if page == 1 else f"{MEMBER_URL}?paged={page}"
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        profiles = soup.select(".user-profile")
        new = 0
        for p in profiles:
            m = parse_profile(p)
            if not m:
                continue
            key = m["cc_id"] or m["name"]
            if key in seen:
                continue
            seen.add(key)
            members.append(m)
            new += 1
        log.info("members page %d: %d profiles, %d new", page, len(profiles), new)
        if not profiles or not new:
            break
        time.sleep(PAGE_DELAY)
    return members


def scrape_industries(session) -> dict[str, list[str]]:
    """Client name → industries, from the paginated industry index."""
    out: dict[str, set] = {}
    seen_pairs: set[tuple[str, str]] = set()
    for page in range(1, 10):
        url = INDUSTRY_URL if page == 1 else f"{INDUSTRY_URL}?paged={page}"
        resp = session.get(url, timeout=30)
        if resp.status_code == 404:
            break
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        article = soup.select_one("article .entry-content")
        if not article:
            break
        count, current = 0, None
        for child in article.find_all(recursive=False):
            if child.name == "header":
                current = _text(child)
            elif child.name == "div" and current:
                for a in child.select("a"):
                    org = _text(a)
                    if org and (org, current) not in seen_pairs:
                        seen_pairs.add((org, current))
                        out.setdefault(org, set()).add(current)
                        count += 1
        log.info("industry page %d: %d org-industry pairs", page, count)
        if not count:
            break
        time.sleep(PAGE_DELAY)
    return {k: sorted(v) for k, v in out.items()}


def scrape() -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    members = scrape_members(session)
    industries = scrape_industries(session)
    by_key = {norm_org(k): v for k, v in industries.items()}
    for m in members:
        m["industries"] = {c: by_key.get(norm_org(c), []) for c in m["clients"]}
    return {"scraped_at": dt.datetime.now(dt.timezone.utc).isoformat(), "members": members}


# ── Supabase sync ────────────────────────────────────────────────────────────

def _split_name(name: str) -> tuple[str, str]:
    parts = re.sub(r"\s+", " ", name).strip().split(" ")
    if len(parts) == 1:
        return "", parts[0]
    # Drop suffixes so "John Powell Jr" files under Powell.
    while len(parts) > 2 and parts[-1].rstrip(".").lower() in {"jr", "sr", "ii", "iii", "iv"}:
        parts.pop()
    return parts[0], parts[-1]


# The contact fields Capitol Club supplies, in the order the update below
# passes them.
CC_FIELDS = ["name", "first_name", "last_name", "affiliation", "email", "phone", "phone_alt",
             "address", "city", "state", "zip", "category", "preferred_contact"]


def _refresh_set_clause() -> str:
    """SET clause that leaves fields an admin edited by hand alone.

    A member's card is re-read every week, which used to overwrite a
    correction made at /admin/lobbyists the moment it was saved. A field named
    in lobbyists.manual_fields now keeps its stored value; clearing the edit
    there hands the field back to the scrape. first_name/last_name follow
    'name', since they are derived from it.
    """
    def guard(field: str) -> str:
        owner = "name" if field in ("first_name", "last_name") else field
        return f"{field} = case when '{owner}' = any(l.manual_fields) then l.{field} else v.{field} end"
    return ", ".join(guard(f) for f in CC_FIELDS)


def sync(data: dict) -> None:
    import supabase_sync as s
    from psycopg2.extras import execute_values
    if not s.sync_enabled():
        raise SystemExit("SUPABASE_DB_URL is not set; nothing to sync")
    today = dt.date.fromisoformat(data["scraped_at"][:10])
    conn = s._connect()
    cur = conn.cursor()

    cur.execute("select lobbyist_id, cc_id, lower(coalesce(email, '')) from lobbyists")
    by_cc, by_email = {}, {}
    for lid, cc_id, email in cur.fetchall():
        if cc_id:
            by_cc[cc_id] = lid
        elif email:
            # A manual/sheet row for the same email is the same person: adopt
            # it rather than creating a twin, so its decisions stay attached.
            by_email.setdefault(email, lid)

    updates, inserts = [], []
    for m in data["members"]:
        first, last = _split_name(m["name"])
        vals = (m["name"], first, last, m["affiliation"] or None, m["email"] or None,
                m["phone"] or None, m["phone_alt"] or None, m["address"] or None,
                m["city"] or None, m["state"] or None, m["zip"] or None,
                m["category"] or None, m["preferred_contact"] or None, m["cc_id"])
        lid = by_cc.get(m["cc_id"]) or (by_email.pop(m["email"], None) if m["email"] else None)
        if lid:
            updates.append((lid, *vals, today))
        else:
            inserts.append(vals)

    if updates:
        execute_values(cur, f"""
            update lobbyists l set {_refresh_set_clause()}, cc_id=v.cc_id, on_capitol_club=true,
                   cc_last_seen=v.seen::date, updated_at=now()
            from (values %s) as v(lobbyist_id, name, first_name, last_name, affiliation, email, phone,
                                  phone_alt, address, city, state, zip, category, preferred_contact,
                                  cc_id, seen)
            where l.lobbyist_id = v.lobbyist_id::bigint""", updates)
    if inserts:
        execute_values(cur, """
            insert into lobbyists (name, first_name, last_name, affiliation, email, phone, phone_alt,
                                   address, city, state, zip, category, preferred_contact, cc_id,
                                   on_capitol_club, cc_last_seen, source)
            values %s""", [(*v, True, today, "capitol_club") for v in inserts])

    # Members who dropped off the directory keep their row (and their links)
    # but stop counting as current.
    cur.execute("""update lobbyists set on_capitol_club=false, updated_at=now()
                   where on_capitol_club and (cc_last_seen is null or cc_last_seen < %s)""", (today,))

    cur.execute("select cc_id, lobbyist_id from lobbyists where cc_id is not null")
    ids = dict(cur.fetchall())
    pairs = {}
    for m in data["members"]:
        lid = ids[m["cc_id"]]
        for client in m["clients"]:
            key = norm_org(client)
            if key and (lid, key) not in pairs:
                pairs[(lid, key)] = (lid, key, client, m["industries"].get(client, []), "capitol_club", True, today)
    execute_values(cur, """
        insert into lobbyist_clients (lobbyist_id, client_key, client_name, industries, source, active, last_seen)
        values %s
        on conflict (lobbyist_id, client_key, source) do update
          set client_name=excluded.client_name, industries=excluded.industries,
              active=true, last_seen=excluded.last_seen""", list(pairs.values()), page_size=500)
    cur.execute("""update lobbyist_clients set active=false
                   where source='capitol_club' and active and (last_seen is null or last_seen < %s)""",
                (today,))
    conn.commit()
    log.info("synced %d lobbyists (%d new), %d client pairs", len(data["members"]), len(inserts), len(pairs))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sync", action="store_true", help="upsert into Supabase")
    ap.add_argument("--from-json", action="store_true", help="skip scraping; use data/capitol_club.json")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s",
                        datefmt="%H:%M:%S")

    if args.from_json:
        data = json.loads(OUT_PATH.read_text())
    else:
        data = scrape()
        n = len(data["members"])
        # The directory has ~450 members. A handful means Cloudflare served a
        # challenge page or the markup changed; syncing that would mark nearly
        # every lobbyist as gone.
        if n < 200:
            raise SystemExit(f"only {n} members parsed — refusing to write; check the site markup")
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps(data, indent=1))
        log.info("wrote %s (%d members, %d with clients)", OUT_PATH, n,
                 sum(1 for m in data["members"] if m["clients"]))
    if args.sync:
        sync(data)


if __name__ == "__main__":
    main()

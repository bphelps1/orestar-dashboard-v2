"""Lobbyist ↔ donor attribution: name rules, scrapers' parsers, matcher logic.

Every case here is a real pair from the first run against ORESTAR and Capitol
Club (September 2026), either one the matcher must find or a false positive it
once produced.
"""

import sys
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))

import fetch_capitol_club as cc  # noqa: E402
import fetch_committee_persons as cp  # noqa: E402
import match_lobbyists as ml  # noqa: E402
from lobby_match import (  # noqa: E402
    client_alternatives, core_org, first_last, is_private_domain, is_public_client, norm_org,
    norm_person,
)


# ── Normalization ────────────────────────────────────────────────────────────

def test_norm_org_is_a_stable_key():
    assert norm_org("The Kroger Co.") == "kroger co"
    assert norm_org("Oregon REALTORS®") == norm_org("Oregon Realtors")
    assert norm_org("L & E Smith") == norm_org("L and E Smith")


@pytest.mark.parametrize(("raw", "core"), [
    ("Oregon Beverage PAC (126)", "oregon beverage"),
    ("Anheuser-Busch Cos., Inc.", "anheuser busch"),
    ("Google LLC and its Affiliates", "google"),
    ("Bank of America Corporation PAC (FED ID #C00043489)", "bank america"),
    ("VSP Vision Inc., c/o MultiState Associates LLC", "vsp vision"),
    ("State Farm Insurance Companies", "state farm insurance"),
    ("Assn. of NW Steelheaders", "association northwest steelheaders"),
])
def test_core_org(raw, core):
    assert core_org(raw) == core


def test_public_bodies_and_bare_places_never_match():
    for name in ("City of Eugene", "Clackamas County", "Port of Morrow", "Business Oregon",
                 "Salem-Keizer School District 24J", "Redmond", "Sisters"):
        assert is_public_client(name), name
    for name in ("Oregon Business & Industry", "Oregon Association of Nurseries", "Kroger"):
        assert not is_public_client(name), name


def test_slash_clients_split_but_not_on_a_state():
    assert client_alternatives("Albertsons/Safeway") == ["Albertsons/Safeway", "Albertsons", "Safeway"]
    assert "Idaho" not in client_alternatives("AAA Oregon/Idaho")


def test_private_domains():
    assert is_private_domain("seiu503.org")
    for d in ("gmail.com", "comcast.net", "oregon.gov", "c-esystems.com", "pps.k12.or.us"):
        assert not is_private_domain(d), d


def test_person_names():
    assert norm_person("KOLMER, SEAN") == "sean kolmer"
    assert norm_person("Jef A Green") == "jef green"
    assert norm_person("Dale Penn ll") == "dale penn"
    assert first_last("John Powell Jr") == ("john", "powell")


# ── Capitol Club profile parsing ─────────────────────────────────────────────

CC_PROFILE = """
<div class="user-profile" id="user-1753"><div class="profile-content"><div class="vcard">
 <div class="vcard-content"><header class="profile-header"><h1 class="profile-title">
  <a href="/user/?search=Sean Kolmer">Sean Kolmer</a></h1></header>
  <div class="adr"><div class="street-address">Executive Vice President, HAO</div>
   <div class="street-address">4000 Kruse Way Place</div>
   <span class="locality">Lake Oswego</span>, <span class="region">OR</span>
   <span class="postal-code">97035</span></div>
  <a class="email" href="mailto:skolmer@oregonhospitals.org">skolmer@oregonhospitals.org</a>
  <div class="tel">PRIMARY: <a class="cell" href="tel:503-351-0838">503-351-0838</a></div>
  <div class="tel"><a href="tel:https://oregonhospitals.org/">https://oregonhospitals.org/</a></div>
 </div>
 <div class="vcard-content right-text"><div class="classification">Association</div>
  <div><u><b>Preferred Contact Method</b></u><br/>Primary Number</div></div>
</div>
<div class="client-list"><a href="/client/?search=Hospital">Hospital Association of Oregon</a></div>
</div></div>
"""


def test_capitol_club_profile():
    m = cc.parse_profile(BeautifulSoup(CC_PROFILE, "html.parser").select_one(".user-profile"))
    assert m["cc_id"] == "user-1753"
    assert m["name"] == "Sean Kolmer"
    assert m["affiliation"] == "Executive Vice President, HAO"
    assert m["address"] == "4000 Kruse Way Place"
    assert (m["city"], m["state"], m["zip"]) == ("Lake Oswego", "OR", "97035")
    assert m["email"] == "skolmer@oregonhospitals.org"
    assert m["phone"] == "503-351-0838"
    assert m["phone_alt"] == ""            # a website behind tel: is not a phone
    assert m["category"] == "Association"
    assert m["clients"] == ["Hospital Association of Oregon"]


# ── ORESTAR Persons Associated with Committee ───────────────────────────────

PERSONS_PAGE = """
<table><tr><td class="label">Name:</td><td> Oregon Hospital Political Action Committee </td>
 <td class="label">ID:</td><td> 161 </td></tr>
 <tr><td class="label">Statement Effective From:</td><td> 11/20/2025
   to
   present</td></tr></table>
<table><tr><td><br></td></tr>
 <tr><td class="backgound-ash"><h5>Treasurer Name</h5></td><td><b>Address</b></td><td><b>Contact</b></td></tr>
 <tr><td> Jef A Green </td><td> PO Box 42307 <br> Portland,
    OR 97242 </td>
  <td><table><tr><td class="label">Work Phone: </td><td> </td></tr>
   <tr><td class="label">Email Address:</td><td> j.green@c-esystems.com </td></tr></table></td></tr></table>
<table><tr><td><br></td></tr>
 <tr><td class="backgound-ash"><h5>Correspondence Recipient</h5></td><td><b>Address</b></td><td><b>Contact</b></td></tr>
 <tr><td> Sean Kolmer </td><td> 12909 SW 68th Parkway <br> Ste 300 <br> Tigard, OR 97223 </td>
  <td><table><tr><td class="label">Work Phone: </td><td> (503)351-0838 </td></tr>
   <tr><td class="label">Email Address:</td><td> SKolmer@oregonhospitals.org </td></tr></table></td></tr></table>
<table><tr><td><br></td></tr>
 <tr class="trSpace"><td class="backgound-ash"><h5>Director Name</h5></td><td>From</td><td>To</td>
  <td>Address</td><td>Phone</td><td>Occupation / Employer</td></tr>
 <tr><td> Brian Shipley </td><td> 11/03/2023 </td><td> Present </td>
  <td> 400 NE Mother Joseph Place <br> Vancouver, WA 98664 </td><td> </td>
  <td> Vice President, Government Affairs <br>PeaceHealth<br> Vancouver, WA </td></tr></table>
"""


def test_persons_page():
    r = cp.parse_persons_page(PERSONS_PAGE)
    assert r["committee_name"] == "Oregon Hospital Political Action Committee"
    assert r["statement_from"] == "11/20/2025 to present"
    by_role = {p["role"]: p for p in r["persons"]}
    assert by_role["treasurer"]["address"] == "PO Box 42307, Portland, OR 97242"
    assert by_role["correspondence"]["email"] == "skolmer@oregonhospitals.org"
    assert by_role["correspondence"]["phone"] == "(503)351-0838"
    d = by_role["director"]
    assert (d["name"], d["occupation"], d["employer"]) == (
        "Brian Shipley", "Vice President, Government Affairs", "PeaceHealth")
    assert d["effective_to"] == "Present"


# ── Donor ↔ client name matching ────────────────────────────────────────────

CLIENTS = [
    "Kroger", "DaVita HealthCare Partners", "Everytown", "Hospital Association of Oregon",
    "Associated Oregon Hazelnut Industries", "Oregon Mortgage Bankers Association", "Toyota",
    "Oregon Humane Society", "Albertsons/Safeway", "AAA Oregon/Idaho", "Apple", "Redmond",
    "Oregon Association of Nurseries",
]


def _pool(*names, prefix="d"):
    return [{"donor_id": f"{prefix}{i}", "display_name": n, "names": [n.lower()]} for i, n in enumerate(names)]


_COMMON = ["safety", "gun", "health", "healthcare", "care", "partners", "services", "group", "fund",
           "action", "auto", "body", "city", "power", "insurance", "society", "education", "industries"]
_FILLER = _pool(*[f"Oregon Association of {_COMMON[i % len(_COMMON)]} Widgets {i}" for i in range(6000)],
                prefix="f")


def _matches(*donors):
    clients = {norm_org(c): c for c in CLIENTS}
    # Filler so token IDF looks like the real ~17k-name corpus the thresholds
    # were tuned on: "oregon" and "association" are everywhere, brand words
    # appear once or twice.
    filler = _FILLER
    rows = ml.match_clients(_pool(*donors) + filler, clients)
    names = {d["donor_id"]: d["display_name"] for d in _pool(*donors)}
    return {(names[r["donor_id"]], r["client_name"]) for r in rows if r["donor_id"] in names}


@pytest.mark.parametrize(("donor", "client"), [
    ("The Kroger Co.", "Kroger"),
    ("Davita Inc.", "DaVita HealthCare Partners"),
    ("Everytown for Gun Safety", "Everytown"),
    ("Oregon Hospital Political Action Committee", "Hospital Association of Oregon"),
    ("Safeway", "Albertsons/Safeway"),
    ("Oregon Nurseries Political Action Committee", "Oregon Association of Nurseries"),
])
def test_finds_real_matches(donor, client):
    assert (donor, client) in _matches(donor)


@pytest.mark.parametrize("donor", [
    "Associated Oregon Industries PAC (10)",     # OBI's old name vs a hazelnut group
    "Oregon Bankers Association",                # not the mortgage bankers
    "Toyota of Portland",                        # a dealership, not Toyota
    "Southern Oregon Humane Society",            # a different shelter
    "Idaho Power Company",                       # AAA's service area, not a company
    "Apple City Auto Body",
    "Redmond Education Association",             # "Redmond" is the city
])
def test_rejects_known_false_positives(donor):
    assert not _matches(donor), _matches(donor)


# ── Committee contacts ↔ lobbyists ───────────────────────────────────────────

def _lob(i, name, email, on_cc=True, kind="person"):
    return {"lobbyist_id": i, "name": name, "email": email, "kind": kind,
            "on_capitol_club": on_cc, "aliases": []}


def test_committee_contacts():
    pool = [{"donor_id": "c161", "committee_id": "161", "display_name": "OHPAC", "names": []},
            {"donor_id": "c33", "committee_id": "33", "display_name": "CAPE", "names": []}]
    lobbyists = [_lob(1, "Sean Kolmer", "skolmer@oregonhospitals.org"),
                 _lob(2, "Courtney Graham", "grahamc@seiu503.org"),
                 _lob(3, "Someone Else", "else@gmail.com")]
    persons = [
        {"filer_id": "161", "role": "correspondence", "name": "Sean Kolmer",
         "email": "skolmer@oregonhospitals.org", "employer": None},
        {"filer_id": "161", "role": "treasurer", "name": "Jef A Green",
         "email": "j.green@c-esystems.com", "employer": None},
        {"filer_id": "33", "role": "correspondence", "name": "Nina Freelander",
         "email": "freelandern@seiu503.org", "employer": None},
        {"filer_id": "33", "role": "treasurer", "name": "Felicia Fournier",
         "email": "feli.fournier@gmail.com", "employer": None},
    ]
    links, _ = ml.match_committee_contacts(pool, persons, lobbyists, [])
    got = {(l["donor_id"], l["lobbyist_id"], l["method"]) for l in links}
    assert got == {("c161", 1, "email_exact"), ("c33", 2, "email_domain")}


# ── Tracker labels → lobbyists ───────────────────────────────────────────────

LOBBYISTS = [
    _lob(1, "Kirsten Larson Adams", "kirstena@agc-oregon.org"),
    _lob(2, "Jessica Adamson", "jessicaa@cfmpdx.com"),
    _lob(3, "Jack Dempsey", "jack@dempseypublicaffairs.com"),
    _lob(4, "Don Loving", "donloving18@gmail.com"),
    _lob(5, "Nicole Palmateer-Hazelbaker", "nicole@braviocommunications.com"),
    _lob(6, "Dale Penn ll", "dalep@cfmpdx.com"),
    _lob(7, "John C. Powell", "jcp@johnpowell.us"),
    _lob(8, "John Powell", "john@johnpowell.us"),
    _lob(9, "Michael Selvaggio", "mike@ridgelark.com"),
    _lob(10, "Louis De Sitter", "louis@desitterpa.com"),
    _lob(11, "Eliza Walton", "eliza@olcv.org"),
    _lob(12, "Eliza Walton", "elizaw@oeconline.org"),
    _lob(20, "Tonkon Torp", None, kind="firm"),
]


@pytest.mark.parametrize(("label", "ids"), [
    ("ADAMS, KRISTEN", {1}),              # first-name spelling differs
    ("DEMSEY, JACK", {3}),                # surname typo
    ("LOVING, DAN", {4}),                 # unique surname, same initial
    ("PALMATEER, NICOLE", {5}),           # hyphenated surname
    ("PENN, DALE", {6}),                  # "ll" suffix
    ("Selvaggio, Mike", {9}),             # nickname
    ("Louis Desitter", {10}),             # spacing inside the surname
    ("Walton, Eliza", {11, 12}),          # one person listed twice
    ("JEFF", set()),                      # too thin to name anyone
])
def test_match_person(label, ids):
    assert {l["lobbyist_id"] for l in ml.match_person(label, LOBBYISTS)} == ids


def test_same_named_lobbyists_resolved_by_2024_list():
    assert {l["lobbyist_id"] for l in ml.match_person("POWELL, JOHN", LOBBYISTS)} == {7, 8}
    got = ml.match_person("POWELL, JOHN", LOBBYISTS, prefer_emails={"jcp@johnpowell.us"})
    assert {l["lobbyist_id"] for l in got} in ({7}, {7, 8})


def test_firm_labels():
    kind, found = ml.resolve_label("TONKON TORP S1", LOBBYISTS)
    assert kind == "firm" and [l["lobbyist_id"] for l in found] == [20]

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
    client_alternatives, core_org, first_last, is_private_domain, is_public_client, names_same_org,
    norm_org, norm_person,
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
                 "Salem-Keizer School District 24J", "Redmond", "Sisters", "Tualatin Valley Fire & Rescue"):
        assert is_public_client(name), name
    for name in ("Oregon Business & Industry", "Oregon Association of Nurseries", "Kroger",
                 "Tillamook County Creamery Association"):
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
    "Oregon Association of Nurseries", "Regence BlueCross BlueShield of OR (Regence)",
    "Williams & Russell CDC",
]


def _pool(*names, prefix="d"):
    return [{"donor_id": f"{prefix}{i}", "display_name": n, "names": [n.lower()]} for i, n in enumerate(names)]


_COMMON = ["safety", "gun", "health", "healthcare", "care", "partners", "services", "group", "fund",
           "action", "auto", "body", "city", "power", "insurance", "society", "education", "industries",
           "williams"]
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
    ("Regence", "Regence BlueCross BlueShield of OR (Regence)"),
    ("Regence Blue Cross Blue Shield", "Regence BlueCross BlueShield of OR (Regence)"),
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
    "The Williams Companies",                    # not Williams & Russell CDC
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


# ── Firm contacts and client leads ───────────────────────────────────────────

@pytest.mark.parametrize(("note", "firm", "people"), [
    ("THORN RUN - Dan Bates S3", "THORN RUN", ["Dan Bates"]),
    ("OXLEY & ASSOCIATES (Evyan) S2", "OXLEY & ASSOCIATES", ["Evyan"]),
    ("CFM - Dale Penn 503-510-2200 S2", "CFM", ["Dale Penn"]),
    ("SUMMIT STRATEGIES - Kristine Evertz/Michelle Giguere S1", "SUMMIT STRATEGIES",
     ["Kristine Evertz", "Michelle Giguere"]),
    ("PAC WEST S3", "PAC WEST", []),
])
def test_tracker_firm_notes(note, firm, people):
    assert ml.parse_firm_note(note) == (firm, people)


def test_additional_lobbyists_cell():
    assert ml._names_in("Drew Hagedorn 503-380-1075 Katy McDowell 541-261-9112") == [
        "Drew Hagedorn", "Katy McDowell"]


def test_nicknames_and_initials():
    people = [_lob(1, "James L. (J.L.) Wilson", "jlwilson@pacounsel.com"),
              _lob(2, "Kelsey Wilson", "kelsey@block84ga.com"),
              _lob(3, "Michael C. (Mike) Freese", "mfreese@rflawlobby.com")]
    assert [l["lobbyist_id"] for l in ml.match_person("JL Wilson", people)] == [1]
    assert [l["lobbyist_id"] for l in ml.match_person("JL", people)] == [1]
    assert [l["lobbyist_id"] for l in ml.match_person("Mike Freese", people)] == [3]


def test_dot_us_is_not_automatically_government():
    assert is_private_domain("summitstrategies.us")
    assert is_private_domain("johnpowell.us")
    assert not is_private_domain("co.washington.or.us")
    assert not is_private_domain("clackamas.us")


class _Cur:
    """Just enough cursor for the seeders: canned SELECTs, recorded UPDATEs."""

    def __init__(self, tables):
        self.tables, self.updates, self.description, self._rows = tables, [], None, []

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        if sql.startswith("update"):
            self.updates.append((sql, params))
            self.rowcount = 1
            return
        if "from lobbyist_clients where active" in sql and "client_key" in sql:
            rows = [(c["client_key"], c["lobbyist_id"], c["is_lead"], c["client_name"])
                    for c in self.tables["lobbyist_clients"] if c["active"]]
            self.description = [("client_key",), ("lobbyist_id",), ("is_lead",), ("client_name",)]
        elif "from lobbyist_clients" in sql:
            rows = [(c["lobbyist_id"],) for c in self.tables["lobbyist_clients"] if c["active"]]
            self.description = [("lobbyist_id",)]
        else:
            cols = list(self.tables["lobbyists"][0])
            rows = [tuple(l[c] for c in cols) for l in self.tables["lobbyists"]]
            self.description = [(c,) for c in cols]
        self._rows = rows

    def fetchall(self):
        return self._rows


def _person(i, name, email, affiliation="", on_cc=True, firm=None):
    return {"lobbyist_id": i, "kind": "person", "name": name, "email": email, "affiliation": affiliation,
            "firm": firm, "on_capitol_club": on_cc, "aliases": [], "firm_primary_id": None,
            "firm_member_ids": []}


def test_firm_primary_comes_from_the_sheets_among_current_members():
    lobbyists = [
        {**_person(100, "Tonkon Torp", None), "kind": "firm", "aliases": ["TONKON TORP"]},
        {**_person(101, "Oxley & Associates", None), "kind": "firm", "aliases": ["OXLEY & ASSOCIATES"]},
        _person(1, "Rocky Dallum", "rocky@oregonga.com", "Oregon Government Affairs Advisors, LLC"),
        _person(2, "Maureen McGee", "maureen.mcgee@tonkon.com", "Tonkon Torp LLP"),
        _person(3, "Gary Oxley", "gary@oxleyandassociates.com"),
        _person(4, "Evyan Jarvis Andries", "evyan@oxleyandassociates.com"),
        _person(5, "Deborah Imse", "deborah@multifamilynw.org"),
    ]
    cur = _Cur({"lobbyists": lobbyists, "lobbyist_clients": []})
    tracker = [("Kroger", "", "OXLEY & ASSOCIATES", "JARVIS ANDRIES, EVYAN")]
    notes = ["OXLEY & ASSOCIATES (Evyan) S2"]
    sheet = [{"first": "Rocky", "last": "Dallum", "firm": "Tonkon Torp",
              "addl_lobbyists": "Maureen McGee 503-802-5726"},
             {"first": "Gary", "last": "Oxley", "firm": "Oxley and Associates",
              "addl_lobbyists": "Evyan Jarvis Andries (503) 320-7127"}]
    ml.seed_firm_contacts(cur, tracker, notes, sheet)
    got = {params[2]: (params[0], params[1]) for _, params in cur.updates}
    # Rocky Dallum led Tonkon Torp in 2024 but has since moved firms.
    assert got[100] == (2, [2])
    # The 2024 list's lead stays primary; the tracker's contact comes next.
    assert got[101] == (3, [3, 4])


def test_client_lead_follows_the_2024_list():
    lobbyists = [_person(1, "Dan Bates", "dbates@thornrun.com"),
                 _person(2, "Madeline Do", "mdo@thornrun.com")]
    clients = [{"lobbyist_id": i, "client_key": "microsoft", "client_name": "Microsoft",
                "is_lead": False, "active": True} for i in (1, 2)]
    cur = _Cur({"lobbyists": lobbyists, "lobbyist_clients": clients})
    ml.seed_client_leads(cur, [{"first": "Dan", "last": "Bates", "clients": "Microsoft; 211info",
                                "addl_lobbyists": "Madeline Do 503-830-8077"}])
    assert [p for _, p in cur.updates] == [(1, "microsoft")]



@pytest.mark.parametrize(("committee", "org"), [
    ("Dairy PAC", "Oregon Dairy Farmers Association"),
    ("ORLAPAC", "Oregon Restaurant & Lodging Association"),
    ("OCBH Policy Action Committee", "Oregon Council for Behavioral Health"),
    ("National Federation of Independent Business", "NFIB"),
    ("Oregon Pharmacists Fund", "Oregon State Pharmacy Assn."),
    ("Dentists of Oregon PAC", "Oregon Dental Association"),
    ("2024 Our Oregon Voter Guide", "Our Oregon"),
])
def test_committee_named_for_its_sponsor(committee, org):
    assert names_same_org(committee, org)


@pytest.mark.parametrize(("committee", "org"), [
    ("Washington County Chamber PAC", "Nike"),                       # a board member's employer
    ("Oregon Hospital Political Action Committee", "PeaceHealth"),
    ("Oregon Business & Industry Candidate PAC", "The Standard"),
    ("Care for our Seniors", "Oregon Health Care Association"),
])
def test_board_members_employer_is_not_the_sponsor(committee, org):
    assert not names_same_org(committee, org)


def test_an_organizations_own_row_leads_over_a_contract_lobbyist():
    lobbyists = [_person(1, "Debbie Koreski", "debbie@mahoniapublicaffairs.com"),
                 _person(2, "Courtney Graham", "grahamc@seiu503.org"),
                 _person(3, "Melissa Unger", "ungerm@seiu503.org", on_cc=False)]
    clients = [{"lobbyist_id": i, "client_key": "seiu local 503 opeu", "client_name": "SEIU Local 503-OPEU",
                "is_lead": False, "active": True} for i in (1, 2)]
    cur = _Cur({"lobbyists": lobbyists, "lobbyist_clients": clients})
    ml.seed_client_leads(cur, [
        {"first": "Debbie", "last": "Koreski", "firm": "Mahonia Public Affairs",
         "clients": "Mahonia Public Affairs; SEIU 503; SEIU Local 503", "addl_lobbyists": ""},
        {"first": "Melissa", "last": "Unger", "firm": "SEIU Local 503", "clients": "SEIU Local 503",
         "addl_lobbyists": "Len Norwitz 503-708-8594 Courtney Graham 503-330-8422"},
    ])
    # Melissa Unger is off Capitol Club, so her row's next person leads.
    assert [p for _, p in cur.updates] == [(2, "seiu local 503 opeu")]


# ── Capitol Club refresh vs. hand edits ──────────────────────────────────────

def test_a_hand_edited_field_survives_the_weekly_refresh():
    clause = cc._refresh_set_clause()
    # Every field Capitol Club supplies is guarded by manual_fields.
    for field in cc.CC_FIELDS:
        assert f"{field} = case when " in clause
    assert "phone = case when 'phone' = any(l.manual_fields) then l.phone else v.phone end" in clause
    # first/last name are derived from the name, so they follow its pin.
    assert "first_name = case when 'name' = any(l.manual_fields)" in clause
    assert "last_name = case when 'name' = any(l.manual_fields)" in clause
    # Nothing outside the card's own fields is touched here.
    for column in ("cc_id", "on_capitol_club", "cc_last_seen", "notes", "aliases", "manual_fields"):
        assert f"{column} = case" not in clause

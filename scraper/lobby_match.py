"""
lobby_match.py — name/email normalization shared by the lobbyist scrapers and
the attribution matcher.

Two levels of organization key:
  norm_org(name)  — a stable storage key: case, punctuation, "&"/"and" and a
                    leading "The" are ignored. "Kroger, The" and "The Kroger"
                    differ; that is fine, the matcher compares core_org.
  core_org(name)  — the comparison key: also drops legal suffixes, committee
                    ids and PAC wording, and expands common abbreviations, so
                    "Oregon Beverage PAC (126)" and "Oregon Beverage" meet.
"""

from __future__ import annotations

import re
import unicodedata

# Mail providers, ISPs and campaign-compliance vendors. A shared domain from
# this list says nothing about who someone works for.
GENERIC_EMAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
    "me.com", "mac.com", "msn.com", "live.com", "comcast.net", "earthlink.net",
    "q.com", "centurylink.net", "frontier.com", "hotmail.net", "protonmail.com",
    "proton.me", "ymail.com", "att.net", "sbcglobal.net", "charter.net", "teleport.com",
    "juno.com", "peak.org", "bendbroadband.com", "gci.net", "cox.net", "verizon.net",
    "mail.com", "pacifier.com", "embarqmail.com", "yahoo.co", "googlemail.com",
}

# Oregon public bodies on bare .us domains.
PUBLIC_US_DOMAINS = {"clackamas.us", "multco.us", "lanecounty.us", "co.lane.or.us"}

# Treasurer / compliance firms that serve many unrelated committees. Matching on
# their domain would tie every client committee to each other.
SERVICE_DOMAIN_HINTS = ("c-esystems.com", "politicalcompliance", "campaigncompliance",
                        "electionlaw", "treasurer", "nwpolitical", "pacfiling")

_LEGAL = (r"(incorporated|inc|llc|l\.l\.c|llp|lp|ltd|corp|corporation|co|cos|company|companies|"
          r"pc|plc|pllc|na|n\.a)")
_PAC_WORDS = (
    r"\b(political action committee|political action fund|political fund|"
    r"political committee|state political|state pac|candidate pac|issue pac|"
    r"employees? pac|employee political action committee|pac|committee)\b"
)
_ABBR = {
    "assn": "association", "assoc": "association", "asso": "association",
    "ass'n": "association", "natl": "national", "intl": "international",
    "dept": "department", "svcs": "services", "svc": "services", "mgmt": "management",
    "govt": "government", "cty": "county", "univ": "university", "ctr": "center",
    "hosp": "hospital", "nw": "northwest", "or": "oregon", "ore": "oregon",
    "us": "united states", "amer": "american", "am": "american", "mfg": "manufacturing",
    "cmte": "committee", "comm": "committee", "cncl": "council", "fed": "federation",
}


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()


def norm_org(name: str) -> str:
    s = _ascii(name).lower().replace("&", " and ")
    s = re.sub(r"[®™]", "", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^the ", "", s)
    return s


def core_org(name: str) -> str:
    s = _ascii(name).lower()
    s = re.sub(r"\bc/o\b.*$", " ", s)                # "... c/o Multistate Associates"
    s = re.sub(r"\b(fec|fed)\s*id\b.*$", " ", s)      # "(FEC ID #C00043489)"
    s = re.sub(r"[,&]?\s*\b(and|&)?\s*(its|all)?\s*(affiliates|subsidiaries)\b", " ", s)
    s = re.sub(r"\(\s*\d+\s*\)", " ", s)             # "(126)" committee id
    s = re.sub(r"\([^)]*\)", " ", s)                 # other parentheticals: "(OBRC)"
    s = s.replace("&", " and ")
    s = re.sub(r"\bd/?b/?a\b.*$", " ", s)            # "Activehours Inc. dba Earnin" → before dba
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    s = re.sub(r"\bblue (cross|shield)\b", r"blue\1", s)     # "Blue Cross" = "BlueCross"
    words = [_ABBR.get(w, w) for w in s.split()]
    s = " ".join(words)
    s = re.sub(_PAC_WORDS, " ", s)
    s = re.sub(rf"\b{_LEGAL}\b\.?", " ", s)
    s = re.sub(r"\b(the|of|and|for|a)\b", " ", s)
    s = s.replace("'", "")
    return re.sub(r"\s+", " ", s).strip()


# Public bodies lobby but cannot make campaign contributions from public funds,
# so a donor that shares their name is someone else: "Benton County Democrats"
# is not Benton County, and "Oregon Business & Industry" is not the state
# agency Business Oregon.
_PUBLIC_CLIENT = re.compile(
    r"^(city|town|port|county|state|university|office|department|dept) of\b|"
    # "Clackamas County" is the county; "Tillamook County Creamery" is not.
    r"\b(county|counties)\s*$|"
    r"\b(school district|community college|"
    r"transit|water district|water services|sanitary|fire district|fire and rescue|"
    r"library|department|commission|board of|authority|council of governments|"
    r"service district|parks and recreation|school board|education service district|"
    r"regional government|special districts|public schools|school district)\b|"
    r"^(business oregon|trimet|metro|oregon state university|portland state university|"
    r"university of oregon|portland public schools|"
    r"oregon health (and|&) science university|ohsu|league of oregon cities|"
    r"association of oregon counties|oregon school boards association)\b",
    re.I)


# Oregon places. A client named just for a place ("Redmond", "Sisters") is the
# city, and a donor carrying a place its client lacks ("Toyota of Portland",
# "Southern Oregon Humane Society") is a local outfit, not the client.
OREGON_PLACES = {
    "albany", "ashland", "astoria", "baker city", "beaverton", "bend", "boardman",
    "brookings", "canby", "central point", "coos bay", "corvallis", "cottage grove",
    "culver", "dallas", "eagle point", "estacada", "eugene", "florence", "forest grove",
    "gladstone", "grants pass", "gresham", "happy valley", "hermiston", "hillsboro",
    "hood river", "independence", "john day", "keizer", "klamath falls", "la grande",
    "la pine", "lake oswego", "lebanon", "lincoln city", "madras", "mcminnville",
    "medford", "milwaukie", "molalla", "monmouth", "newberg", "newport", "north bend",
    "nyssa", "ontario", "oregon city", "pendleton", "philomath", "portland",
    "prineville", "redmond", "roseburg", "salem", "sandy", "scappoose", "seaside",
    "sherwood", "silverton", "sisters", "springfield", "st helens", "stayton",
    "sutherlin", "sweet home", "talent", "the dalles", "tigard", "tillamook",
    "troutdale", "tualatin", "umatilla", "west linn", "wilsonville", "woodburn",
}
REGION_WORDS = {"southern", "eastern", "central", "northern", "north", "south", "east",
                "west", "coast", "coastal", "metro", "city", "county", "valley"}


def is_public_client(name: str) -> bool:
    text = _ascii(name).replace("&", " and ")
    plain = re.sub(r"\s+", " ", re.sub(r"[^a-z ]+", " ", text.lower())).strip()
    return bool(_PUBLIC_CLIENT.search(re.sub(r"\s+", " ", text))) or plain in OREGON_PLACES


def place_tokens(core: str) -> set[str]:
    """Place and region words in a core name ("toyota portland" → {"portland"})."""
    toks = re.sub(r"\b(north|south|latin) america\b", "america", core).split()
    found = {t for t in toks if t in REGION_WORDS or t in OREGON_PLACES}
    for i in range(len(toks) - 1):
        if f"{toks[i]} {toks[i + 1]}" in OREGON_PLACES:
            found.add(f"{toks[i]} {toks[i + 1]}")
    return found


_STATES = {"oregon", "idaho", "washington", "california", "nevada", "alaska", "montana",
           "northwest", "nw", "pacific northwest", "or", "wa", "id"}


def client_alternatives(name: str) -> list[str]:
    """"Albertsons/Safeway" → ["Albertsons/Safeway", "Albertsons", "Safeway"].

    A side that is only a state ("AAA Oregon/Idaho" → "Idaho") is a service
    area, not a second company, and would match every Idaho donor.
    """
    out = [name]
    stripped = re.sub(r"\([^)]*\)", " ", name)
    if "/" in stripped:
        for p in stripped.split("/"):
            p = p.strip()
            if len(p) > 2 and p.lower() not in _STATES:
                out.append(p)
    return out


def dba_names(name: str) -> list[str]:
    """Every name a donor string claims: "Activehours Inc. dba Earnin" → both."""
    parts = re.split(r"\b(?:d/?b/?a|doing business as|aka|a/k/a|fka)\b", name, flags=re.I)
    return [p.strip(" ,.-") for p in parts if p.strip(" ,.-")]


def email_domain(email: str) -> str:
    email = (email or "").strip().lower()
    return email.rsplit("@", 1)[1] if "@" in email else ""


def is_private_domain(domain: str) -> bool:
    if not domain or domain in GENERIC_EMAIL_DOMAINS:
        return False
    if any(h in domain for h in SERVICE_DOMAIN_HINTS):
        return False
    # Government and school addresses are shared by thousands of unrelated
    # people; the Capitol Club scraper excluded them for the same reason.
    # ".us" alone is not government (summitstrategies.us, johnpowell.us);
    # state, county and school forms of it are.
    if domain.endswith((".gov", ".edu", ".mil")) or domain in PUBLIC_US_DOMAINS:
        return False
    return not re.search(r"\.(k12|state|co|ci|[a-z]{2})\.[a-z]{2}\.us$|\.[a-z]{2}\.us$", domain)


def norm_person(name: str) -> str:
    """'KOLMER, SEAN' / 'Sean M Kolmer' / 'Sean Kolmer Jr.' → 'sean kolmer'."""
    s = _ascii(name).lower().strip()
    if "," in s:
        last, _, first = s.partition(",")
        s = f"{first} {last}"
    s = re.sub(r"[^a-z ]+", " ", s)
    # "ll" is how "II" often arrives when typed ("Dale Penn ll").
    parts = [p for p in s.split()
             if p not in {"jr", "sr", "ii", "ll", "iii", "iv", "dr", "mr", "ms", "mrs"}]
    if len(parts) >= 3:
        # Drop single-letter middle initials: "jef a green" → "jef green".
        parts = [parts[0]] + [p for p in parts[1:-1] if len(p) > 1] + [parts[-1]]
    return " ".join(parts)


def first_last(name: str) -> tuple[str, str]:
    parts = norm_person(name).split()
    if not parts:
        return "", ""
    return parts[0], parts[-1]


_NICKNAMES = [
    {"michael", "mike"}, {"william", "bill", "will"}, {"robert", "bob", "rob"},
    {"daniel", "dan", "danny"}, {"james", "jim", "jimmy"}, {"thomas", "tom"},
    {"richard", "rick", "rich", "dick"}, {"joshua", "josh"}, {"philip", "phillip", "phil"},
    {"nicole", "nikki", "niki"}, {"elizabeth", "liz", "libby", "beth"}, {"kristen", "kirsten"},
    {"jeffrey", "jeff"}, {"gregory", "greg"}, {"anthony", "tony"}, {"joseph", "joe"},
    {"christopher", "chris"}, {"katherine", "kathryn", "kate", "katie"}, {"patricia", "trish"},
    {"deborah", "debbie", "deb"}, {"douglas", "doug"}, {"timothy", "tim"}, {"john", "jon"},
]


def first_names_compatible(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b or (len(a) >= 3 and len(b) >= 3 and (a.startswith(b) or b.startswith(a))):
        return True
    return any(a in group and b in group for group in _NICKNAMES)


def person_label(label: str) -> tuple[str, list[str]]:
    """'MILLER KUDSZUS, ELLEN' → ('ellen', ['miller', 'kudszus']);
    'Sean Kolmer' → ('sean', ['kolmer'])."""
    raw = _ascii(label).lower()
    if "," in raw:
        last, _, first = raw.partition(",")
        firsts = norm_person(first).split()
        lasts = norm_person(last).replace("-", " ").split()
        return (firsts[0] if firsts else ""), lasts
    toks = norm_person(raw).replace("-", " ").split()
    if len(toks) <= 1:
        return "", toks
    return toks[0], toks[-1:]


def person_tokens(name: str) -> list[str]:
    return norm_person(name).replace("-", " ").split()


def nicknames(name: str) -> set[str]:
    """What a name says to call them: "James L. (J.L.) Wilson" → {"jl"},
    "Michael C. (Mike) Freese" → {"mike"}."""
    return {re.sub(r"[^a-z]", "", n.lower()) for n in re.findall(r"\(([^)]*)\)", _ascii(name))} - {""}


# Words too common in committee and organization names to tie one to another.
_GENERIC = {"oregon", "oregonians", "association", "committee", "political", "action", "pac", "fund",
            "people", "citizens", "community", "communities", "coalition", "council", "united", "yes",
            "no", "vote", "friends", "network", "group", "state", "national", "american", "america",
            "americas", "northwest", "portland", "our", "better", "future", "local", "professional",
            "oregons", "issues", "candidate", "legislative", "policy", "employees", "inc", "llc",
            "care", "health", "services", "business", "workers", "public", "safety", "support"}


def names_same_org(committee: str, org: str) -> bool:
    """Does a committee's name point at this organization?

    "Dairy PAC" → Oregon Dairy Farmers Association (shared word), "Oregon
    Pharmacists Fund" → Oregon State Pharmacy Assn. (stem), "ORLAPAC" /
    "OCBH Policy Action Committee" / "OR ASCA PAC" → their association
    (acronym), "2024 Our Oregon Voter Guide" → Our Oregon (containment).
    "Washington County Chamber PAC" does not point at Nike, whose employee
    merely sits on its board.
    """
    c_toks = [t for t in core_org(committee).split() if t not in _GENERIC]
    o_all = core_org(org).split()
    o_toks = [t for t in o_all if t not in _GENERIC]
    for a in c_toks:
        for b in o_toks:
            if a == b:
                return True
            # A shared stem: "pharmacists"/"pharmacy", "dentists"/"dental".
            n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            if n >= 4 and n >= 0.6 * min(len(a), len(b)):
                return True
    for one, other in ((committee, org), (org, committee)):
        initials = "".join(t[0] for t in core_org(other).split())
        for a in core_org(one).split():
            a = a[:-3] if a.endswith("pac") and len(a) > 5 else a
            if len(a) >= 3 and len(initials) >= 3 and a in (initials, initials.removeprefix("o")):
                return True
    flat_c = core_org(committee).replace(" ", "")
    flat_o = core_org(org).replace(" ", "")
    if len(flat_o) >= 8 and flat_o in flat_c:
        return True
    stem = flat_c[:-3] if flat_c.endswith("pac") else flat_c
    return len(stem) >= 6 and flat_o.startswith(stem)

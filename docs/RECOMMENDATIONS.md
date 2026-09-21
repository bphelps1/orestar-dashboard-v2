# How the Recommend tab works

A reference for what the recommendation engine does, what every weight is, and
where each number comes from. Source: [`docs/recommend.js`](recommend.js).

The engine answers one question: **given a committee, which donors should it
ask, and for how much?** It never invents donors — every suggestion is someone
who already gave to a *comparable* committee.

---

## The pipeline

```
1. Load the target committee's profile          (filer_detail)
2. Find comparable committees                   → similarity score, top 50
3. Pull every donor who gave to those           (their filer_detail records)
4. Score each donor 0–100                       → ranked list
5. Compute a target ask per donor               → benchmarked against giving
                                                  in seats as close as this one
```

**Donor Targets** includes both prior donors and first-time prospects.
**New Donor Prospects** remains a separate view of the first-time subset.
Lobbyist Plan uses the same recommendations, restricted to organizations.
The Donor Targets export includes both groups as well.

---

## Step 2 — Comparable committees

Every other committee is scored for similarity. Anything scoring **≤ 20 is
discarded**; the top **50** survive.

| Signal | Weight |
|---|---|
| Same office | **+40** |
| Related office (State Rep ↔ State Senate, legislative → statewide) | **+30** |
| Same party | **+15** |
| Similar fundraising size | **+0 … 15** (ratio of the smaller total to the larger, × 15) |
| Both in leadership | **+25** |
| …and same leadership tier | **+10** (adjacent tier: +5) |
| Target is *not* leadership but the comparable is | **−15** |
| Same seat competitiveness band | **+12** |
| Opposite competitiveness bands (or either unopposed) | **−8** |
| Tagged `prolific` in admin (non-leadership target) | **−10** |
| Tagged `exclude` in admin | **removed entirely** |

**Hard filter:** if the target has a known party, committees of a *different*
party are dropped before scoring. Committees with no party (PACs) stay
eligible.

**Leadership tiers** come from `data/leadership_roles.json`, refreshed weekly:
tier 1 Speaker / Senate President · tier 2 Majority Leaders, Ways & Means
co-chairs · tier 3 other leadership.

---

## Step 4 — Donor score (0–100)

Each donor starts at 0, accumulates the factors below, and is clamped to
0–100.

| # | Factor | Range | Rule |
|---|---|---|---|
| 1 | **Breadth** — distinct comparable committees supported | 3 … **35** | `7 × committees`, capped at 35. Only one committee scores just **3** — this is the heaviest single signal. |
| 2 | **Total given** to comparables | 0 … **15** | `total ÷ 500`, capped |
| 3 | **Similarity-weighted giving** | 0 … **15** | gifts weighted by how comparable the recipient was, `÷ 300`, capped |
| 4 | **Headroom** — gap between the target ask and what they've already given here | 0 … **15** | `gap ÷ 200`, capped; 0 if no gap |
| 5 | **Recency** | **−10 … +20** | gave within 1 year **+20**; within 3 **+10**; more than 5 years ago **−10** |
| 6 | **Leadership donor** — gave to ≥ 2 leadership members | 0 … **20** | `5 × members`, capped |
| 7 | **One-time donor** (1 committee, 1 year) | **−5** | |
| 8 | **Single-cycle donor** — all giving inside one election cycle | **−25** | the largest penalty: a donor who appeared once is weak evidence of habit |

Prospects whose computed ask lands **below $500** are dropped from the list.

---

## Step 5 — The target ask

Start from what this donor gave to comparable committees:

```
peers = their gifts to seats whose last general finished within N points
        of this one  (N widens 5 → 10 → 20 until 3 gifts qualify)
base  = midpoint(median, 75th percentile) of peers   ← all their giving if
                                                       too few peer gifts
ask   = min(base, largest single gift)   ← never above what they have ever given
```

### First-time asks

For someone who has never given to the selected candidate, the ask is the
smaller of (a) the median first observed cash contribution to comparable
candidates and (b) **50% of the established-giving benchmark** above. The 50%
cap is an explicit conservative policy for a new relationship, not an
empirically fitted coefficient. It can be tuned independently of seat matching.
The same seat-margin selection applies when there are at least three first
gifts to nearby seats. One observation per recipient is used, and future
contributions are excluded.

Migration `019_recommendation_first_gifts.sql` supplies actual first observed
positive cash transactions, excluding in-kind contributions. If that endpoint
is unavailable, the engine uses earliest observed **annual totals** and says
so in the calculation details. Neither source proves a first-ever gift outside
our dataset. Details are also included in the workbook. The prospect floor is
$500 so the introductory reduction does not retain the old $1,000 cutoff.

### Competitiveness is a benchmark, not a multiplier

A close race draws larger gifts than a safe one. The engine used to express
that by multiplying the ask (×1.25 for a competitive seat, ×0.85 for a safe
one) — a number invented by the rule rather than observed.

It now answers the question with evidence instead: **what did this donor give
candidates in seats about as close as this one?** Those gifts, and only those,
set the ask. A donor who gives $1,000 in safe seats and $5,000 in toss-ups is
asked for $5,000 in a toss-up because that is what they do, not because a
coefficient said so.

- The window starts at **±5 points** and widens to ±10, then ±20, stopping at
  the first width holding at least **3 gifts**. Narrow beats wide, so a
  0.8-point seat is benchmarked on other knife-edge races where possible.
- With fewer than 3 qualifying gifts even at ±20, the donor's whole comparable
  history is used and the row says so: *"Ask set by all comparable giving —
  under 3 gifts to seats within 20 pts of this safe (>20 pt margin) seat."*
- Unopposed seats are not a special case. They sit near a 100-point margin and
  find each other naturally.
- The gifts behind an ask are listed in the donor's "why", each with the margin
  of the seat it was given in, so the figure can be traced to real
  contributions.

Seat competitiveness still shapes **which committees are comparable** at all
(§2), which is where a band label earns its keep.

### The committee's own benchmark

The results page carries a **Similar-margin seats** card: the median raised
this cycle by comparable committees whose last general finished within the
same window. Leadership is compared with leadership — a Majority Leader's
haul is no guide for a back-bencher and vice versa — falling back to every
seat when that leaves fewer than three peers.

It answers "is this committee raising what a seat this close raises?" and is
context, not a target: nothing in the engine scales an ask by it. The
**Method** sheet of the export names every peer seat, its margin and what it
raised.

### Where margins come from

The `race_margins` view, built from official Secretary of State results
(`election_results`, 2008–2026).

- **General elections only.** Primary margins are far more variable —
  unopposed incumbents, multi-way fields — and say little about how contested
  a seat actually is.
- **Current district era only.** Oregon redraws maps two years after each
  census (2012, 2022), so a pre-2022 margin describes a different electorate
  under the same district number. The engine reads only the `2022–` era.
- **Unopposed races are kept**, flagged rather than dropped — that is the
  extreme of "safe", not missing data.

---

## Lobbyist Plan — who asks each donor

The results open on the **Lobbyist Plan** tab: every donor target and new
prospect grouped under the lobbyist who handles that donor, with their tier,
contact details and subtotals — the layout of the fundraising PLAN sheet.

A donor is listed under one lobbyist. Order of preference:

1. **filed under** — an admin's choice at `/admin/lobbyists`; it beats
   everything below, so a donor never appears under two people;
2. a link marked primary — the Fundraising Tracker's "Lobbyist 1", or the
   client's lead (below);
3. a confirmed link over an unreviewed one;
4. the stronger match.

Anyone else attached to the donor appears as "also: …". Unreviewed matches are
marked **?** and can be hidden with *Include unreviewed matches*.

Contact details are each lobbyist's **email and primary phone**. A donor filed
under a **firm** (Thorn Run, Oxley & Associates) shows the firm's primary
contact first and its other members in an expanded list. A donor can also carry
**its own contacts** — a government-affairs director who is on nobody's Capitol
Club card — added at `/admin/lobbyists`; the primary one sits under the donor's
name, the rest follow as "also".

### Tiers

Lobbyists are worked in the order of the 2024 lobby list: **PARTNER → Tier 1 →
Tier 4**. A tier is a claim about likelihood to give, and rests on what can be
observed:

| Component | Points |
|---|---|
| Donors they carry in this plan | `6 × donors`, max **30** |
| Like candidates their donors support — the comparables are already filtered to this committee's party and office, so these are like-members | `2 × candidates`, max **30** |
| What those donors gave them | `total ÷ 5,000`, max **20** |
| Has given to this committee before | **+15** |
| …and already this cycle | **+5** |

Tier 1 ≥ 70 · Tier 2 ≥ 45 · Tier 3 ≥ 20 · Tier 4 below that. The reasoning
shows on the row and in the export ("6 donors in this plan · 35 like candidates
supported ($89,100) · $20,500 to this committee to date").

**PARTNER is never computed.** It is a standing relationship with one caucus,
set by hand per **chamber and party** — a firm can be a partner of the House
Democrats and nothing to the Senate Republicans — and it applies only when the
plan is for that chamber and party.

### Who is in the plan

Only organizations. ORESTAR files every contributor under a category
(`book_type`), and the plan drops **Individual**, **Candidate & Immediate
Family** and **Candidate's Immediate Family** rather than guessing from the
shape of a name. Individual donors stay in *Donor Targets* and *New Donor
Prospects*, which is where a person belongs. A donor whose category cannot be
found is kept: dropping a real PAC is worse than listing one person.

### One donor, however it is spelled

If a cached profile has name-only rows, Recommend reloads its scoped donor
history through `donor_leaderboard` before scoring. That prevents a raw-label
cache rebuild from splitting repeat donors and export history. The explicitly
confirmed Amazon/Amazon.com/Services and Genentech/Genentech USA families share
one planning ask, including all member identities' contact evidence and giving
history; their legal entities and transactions remain separate. Other recorded
entity merges flow through the resolver's identity keys.

Everything here keys on the **donor's identity** (`donor_key`, the resolver's
id), never on the label. ORESTAR records the same company under many spellings
— "FamilyCare", "FamilyCare, Inc", "Familycare, Inc." — and a merge recorded at
`/admin/donors` collapses them into one identity. Keying on the label split one
donor into several and quietly ignored those merges.

The attribution lookup matches on the same id. It used to match the donor's
name against the variants stored in `lobby_donor_pool`, which held only the raw
transaction labels: a committee files as "Oregon Health Care Association PAC
(275)" while the dashboard shows it without the ORESTAR id, so **253 attributed
donors — $62.9M of giving, including most of the large PACs — showed "no
lobbyist on file"** despite being attributed and confirmed. The pool now stores
the resolved name alongside the raw labels, and the plan asks by id first.

Name-only attribution prefers an exact canonical name over another donor's
raw alias. Ambiguous alias-only matches are left unattributed. This matters for
OBRC: the pool also contains its name under Oregon Beverage PAC (126), whose
lobbyists are Romain and Freese. Taking the first pool hit attributed the wrong
organization. The canonical OBRC records lead to Thorn Run and Dan Bates.

Display labels normalize whitespace, all-upper/all-lower labels, common
acronyms, and Cooperative's casing without using spelling changes as identity
merges.

Lobbyist Plan groups start expanded with an accessible collapse button. The
Excel Call list starts collapsed, retaining outline controls for expanding.

### The Excel export

**Lobbyist Plan Excel** is written with ExcelJS rather than the SheetJS build
the other exports use, because this one is opened by people who did not make
it: it needs frozen headers, shaded tiers and currency formatting, none of
which the community SheetJS build can write. The formatter loads only when the
button is pressed.

| Sheet | What it is |
|---|---|
| **Start here** | What the file is, the headline numbers, and how to read the call list — for someone opening it cold. |
| **Call list** | One block per lobbyist in call order, their donors collapsible underneath (Excel's outline arrows), with the ask and what has come in this cycle, then what those same donors gave this candidate **and the five comparable candidates they gave most to** in each of the two previous cycles. Headers frozen, partners and Tier 1 shaded, money formatted as money. |
| **Lobbyists** | One line per lobbyist, filterable: tier, firm, contact, donors, suggested ask, giving to this committee to date, like-candidate giving, clients, and why that tier. |
| **Donors** | The flat table, one row per donor — the sheet to pivot. |
| **How these numbers were set** | The seat, its margin, the peer seats and what they raised, the ask rule and the tier rule. |

Column headings are plain English — *Ask*, *Given*, *Who to call*, *Why them* —
and the "why" is spelled out ("Lobbies for Oregon Health Care Association ·
donor name matches a client of theirs") rather than left as a method name.

Who leads is seeded from the fundraising sheets and editable at
`/admin/lobbyists`:

- **Firm primary** — the person the 2024 lobby list names for the firm (Gary
  Oxley), provided Capitol Club still lists them there; otherwise the person
  the Fundraising Tracker names. Members are the people Capitol Club places at
  the firm (affiliation or email domain), so someone who has moved firms since
  2024 is dropped rather than listed.
- **Client lead** — for a client several lobbyists list, the one the 2024 list
  names (then its "Additional Lobbyists", in order). Donors reached through
  that client are filed under the lead.

### Where attributions come from

ORESTAR never records who lobbies for a donor, so the link is assembled from
three sources and confirmed by a person at **/admin/lobbyists**:

| Source | What it gives | Refreshed by |
|---|---|---|
| [Capitol Club](https://oregoncapitolclub.org/user/) | every member lobbyist's card (title/firm, address, email, phones) and the clients they list | `scraper/fetch_capitol_club.py` |
| ORESTAR *Persons Associated with Committee* | treasurer, correspondence recipient and directors of each donor committee | `scraper/fetch_committee_persons.py` |
| ORESTAR donors since 2021 | the pool of 15k non-individual donors to match (`lobby_donor_pool`) | `scraper/match_lobbyists.py --refresh-pool` |

`scraper/match_lobbyists.py` turns those into suggestions:

| Evidence | Example | Score |
|---|---|---|
| A committee contact's **email** is the lobbyist's | OHPAC (161) correspondent skolmer@oregonhospitals.org → Sean Kolmer | 98 |
| A committee contact has the lobbyist's **name** | treasurer/correspondent 90, director 80 | 80–90 |
| A committee contact shares a private **email domain** | CAPE (33) correspondent freelandern@seiu503.org → Courtney Graham (grahamc@seiu503.org) | 55–70 |
| A committee **director works for** a lobbyist's client | | 75 |
| Donor name **equals** a client name (legal suffixes, "PAC", committee ids ignored) | "The Kroger Co." → Kroger | 95 |
| Donor name **resembles** a client name | "Oregon Nurseries PAC" → Oregon Association of Nurseries | 50–90 |

Mail providers, `.gov`/`.us`/`.edu` addresses and treasurer-service firms never
count as a shared domain. Name matching never pairs a donor with a public body
(cities, counties, ports, colleges — they cannot contribute), requires the
client's most distinctive word, and refuses a donor that adds a place the
client lacks ("Toyota of Portland" is a dealership, not Toyota).

A **client** link attributes the donor to every lobbyist currently listing that
client. The client's **lead** is whichever of those lobbyists a confirmed
direct link already chose for another donor of the same client — so once one
UFCW 555 donor record is filed under a lobbyist, the union's other donor
records follow rather than landing under whichever lobbyist sorts first.

Two seeds were loaded once from local files (never committed; the repo is
public): the Fundraising Tracker's *Lobbyist Key* (stored as confirmed — it was
curated by hand) and the 2024 FuturePAC lobby list (adds lobbyists missing from
Capitol Club; its client pairs count only where no current Capitol Club
lobbyist claims the client, since the list is dated).

### Reviewing

`/admin/lobbyists` (admins and reviewers):

- **Review queue** — confirm or reject each suggestion; filter by kind; bulk
  confirm what is shown.
- **Lobbyists** — every lobbyist with contact details, clients and attributed
  donors. Add a lobbyist or firm not on Capitol Club, add clients, link a donor
  directly, or mark a donor "not theirs". Each entry also carries its **Partner**
  standing (House D / House R / Senate D / Senate R) and its **firms**: add a
  person to a firm, or make them its primary contact, from either side.
  A contact field edited here is **pinned** — the weekly Capitol Club refresh
  leaves it alone until *Revert to Capitol Club* hands it back.
- **Donors** — one entry per donor: which lobbyist or **firm** it is filed under
  in a plan, and the people to call for it (a primary and any number of others,
  each optionally an existing lobbyist).
- **Unmatched donors** — the largest donors since 2021 with nothing attributed;
  assign a lobbyist or a client.
- **Decisions** — everything confirmed or rejected. **Edit** changes one in
  place: flip it, move the donor to a different lobbyist or client, file the
  donor under them, or leave a note that stays with the decision. Moving a
  donor rejects the old pair — so the matcher does not suggest it again — and
  records the new one as confirmed, both carrying the reason. **Undo** returns
  a pair to the queue (a manual link is removed instead).

The weekly *Lobbyist Attribution* workflow re-reads Capitol Club, re-reads the
contacts of up to 400 committees whose data is over 30 days old, and refreshes
suggestions. A confirmed or rejected row is never changed by a re-run.

Every workflow that runs `scraper/process.py` must follow it with
`scraper/refresh_donor_aggregates.py`: process.py rebuilds each committee's
donor table from the raw transaction labels, and the re-key step puts the
resolved identities — and the merges recorded at `/admin/donors` — back. The
account-balance sweep was missing that step, so a merge survived only until the
next sweep finished.

## What it deliberately does not do

- **No cross-party suggestions** when the target's party is known.
- **No donor invented from nothing** — every suggestion has a giving history
  with a comparable committee.
- **No ask above a donor's largest observed gift.**
- **No competitiveness multiplier** — seat matching selects the evidence.
  First-time asks have the explicit 50% introductory cap described above.
- **No primary-margin influence**, by design.

## Tuning it

| Change | Where |
|---|---|
| Similarity weights, the ≤ 20 cutoff, top-50 | `findComparables()` |
| Score factors 1–8 | `buildRepeatDonorTargets()` / `scoreDonors()` |
| Competitiveness bands (comparability and labels) | `MARGIN_BANDS` / `UNOPPOSED` |
| Peer-margin windows and the 3-gift minimum | `PEER_WINDOWS` / `MIN_PEER_GIFTS` |
| Lobbyist tier thresholds and weights | `TIER_RULES` / `lobbyistTier()` |
| The export's sheets and columns | `planSheetAoa()` / `lobbyistSheetRows()` |
| $500 prospect floor | end of `scoreDonors()` |
| Exclude or flag a committee | `/admin` tags (`exclude`, `prolific`) |
| Lobbyist attribution | `/admin/lobbyists`; matching rules in `scraper/match_lobbyists.py` |

All weights are plain constants — there is no trained model and no hidden
state, so a change here is fully predictable in the output.

## Entity merge admin

Entity A is the destination group. Entity B supports multiple selections across
searches in a scrollable list (up to 50 matches; refine the search for more).
Selected entities remain visible and individually removable. One atomic upsert
records all pairs, with each human label attached to its sorted alias key.
A failed save retains the selection; duplicate submissions and self merges are
blocked. Saved merges take effect immediately on database reads after migration 021. Refresh other open pages to load the new identity. Entity A supplies the combined display name; search, donor profiles, rankings, recommendation evidence, lobbyist attribution, and exports use the combined group without waiting for the weekly resolver.


### Immediate entity merge rollout

Merge the Top Recipients PR first and apply migrations `020_donor_profile_recipients.sql`
and `021_immediate_entity_merges.sql` before deploying the associated frontend.
Both are registered in `scraper/db_admin.py`. No resolver or cache rebuild is needed
when an admin subsequently saves a merge. Existing open pages refresh their cached
identity mapping when reloaded.

Raw transaction identities remain intact until normal resolution. Stable alias
anchors retain access to reviewed lobbyist links and contacts when that resolution
changes donor IDs. The resolver now also replaces stale non-null transaction IDs,
while preserving authoritative ORESTAR committee IDs. Removing a merge decision
splits read-through groups immediately before physical resolution; undoing a group
already physically consolidated requires a resolver run to split its source IDs.
Cached chart tooltip lists combine the entries already present in each cached list;
full donor rankings and affected candidate donor histories are queried live.


### Lobbyist plan follow-up (September 2026)

The app opens donor groups and firm members expanded. Excel Call list donor
rows use outline level 1, hidden and collapsed by default. Lobbyist summary
rows include the sum of their donors' giving in the immediately preceding
cycle, including an explicit zero. Comparable Max identifies the actual filer
(or tied filers) whose gift sets that reference, including outlier discounting.

Before scoring, recommendations group exact display-name matches only when
both donor identities are known organizations. This fixes split address-based
IDs such as State Farm Federal PAC without merging same-name individuals.
Underlying IDs remain available for contacts and first-gift evidence.

A member's represented donors roll up under their recorded firm and its lead;
the admin firm view includes members' primary donor relationships. Ambiguous
firm membership is not guessed, and explicit rejected relationships remain
vetoes. This derives presentation from existing reviewed records; it does not
change client leads or overwrite contact records.

Migration 022 publishes only adopted display spellings from name-merge decisions.
A shared display helper uses those choices across dashboard caches, Donor Lookup,
Explore, Recommendations, admin donor displays and exports, and restores AT&T
and known acronyms. Raw transaction fields and SQL-query results retain source
values. Apply migrations 021 and 022 before deploying this frontend. PR 31 was
merged into the earlier dependency branch after main received PR 30, so the
follow-up PR carries the missing immediate-merge changes into main as well.

The supplied 2026 Future PAC workbook is reviewed separately from code changes.
Its contact ordering does not change leads: preserve current leads unless the
user explicitly selects a replacement. Missing contacts are proposed removals,
not automatic deletions; ambiguous identities and unequal contact-column lengths
require review. No spreadsheet-derived changes are included in this migration.

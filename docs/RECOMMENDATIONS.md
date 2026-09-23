# How the Recommend tab works

A reference for what the recommendation engine does, what every weight is, and
where each number comes from. Source: [`docs/recommend.js`](recommend.js).

The engine answers two questions, one per mode:

- **For a candidate** — given a committee, which donors should it ask, and for
  how much? It never invents donors: every suggestion is someone who already
  gave to a *comparable* committee.
- **[Top donors by chamber & party](#top-donors-by-chamber--party)** — who
  gives to candidates of this kind at all, and how much does one of them get?
  A standing call list, with no seat, margin or existing relationship in it.

Everything below describes the candidate mode until the chamber-and-party
section.

---

## Recency — an ask is argued from what a donor does now

A gift is evidence of what a donor will give **today** only while the
relationship it describes still holds. Oregon Nurses gave Susan McLain
$25,000 in the 2013–14 cycle and $1,000–$2,000 in each of the last three;
taking a comparable's lifetime maximum asked every candidate for $25,000 on
the strength of a relationship that had ended a decade earlier.

Each comparable committee therefore contributes **one** benchmark gift, chosen
by window:

| Window | Cycles | Which gift | Why |
|---|---|---|---|
| **Recent** | the two completed cycles before this one (`RECENT_BENCHMARK_CYCLES`) | the **larger** of them | both describe a live relationship, so the larger is what the donor is good for |
| **Stale** | up to five cycles further back (`STALE_BENCHMARK_CYCLES`) | the **most recent** | the last thing known about a relationship that has lapsed — reaching back for a maximum is how one decade-old gift priced every ask |
| Older | beyond that | none | history, shown on the row but never a benchmark |

The cycle being planned is deliberately excluded: a peer's part-cycle total is
not a benchmark. This is the window the engine already used for members with
limited incumbent history, now applied to everyone.

Recency is applied **before** seat closeness. A gift counts only while it is
current; among current gifts, those given in seats about as close as this one
set the number. When every gift a donor has to a comparable is stale, the ask
is still priced on them and the row says *"Nothing in 2021–2022 and 2023–2024
— benchmarked on older giving instead."*

Where a figure blends many gifts rather than choosing one — the generic asks
in the chamber list — the graded form of the same window applies:
`CYCLE_WEIGHTS = [1, 1, 1, 0.5, 0.25, 0.1]`, indexed by cycles ago, with the
median taken against those weights.

## Every ask is a blend, and the blend is shown

A comparable's giving **pulls** an ask toward it; it never replaces it.

The same-tier leadership reference used to be assigned to the target outright,
so a single peer's gift became the whole ask: a donor giving this committee
$2,000 a cycle was asked for $25,000 because it had once given another member
of the same tier that much. That reference is now one candidate among others,
and every uplifted ask is a stated blend of the donor's own giving here with
whichever reference is larger. The donor row carries the arithmetic:

```
Ask = 95% × $2,100 (own giving here, +5%)
    +  5% × $20,000 (Friends of Rob Nosse, 2023–2024)
    = $2,995 → $3,000 rounded
```

The weight comes from the existing inverse-gap rule — a small gap means the
comparable amount is realistic for this donor, a large one means the
relationship is not there — so an ask always sits between what the donor
actually does and what the evidence suggests is possible.

---

## The pipeline

```
1. Load the target committee's profile          (filer_detail)
2. Find comparable committees                   → similarity score, top 20
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

Only candidate committees with a known election in the selected cycle or previous cycle are scored. Senate and statewide executive committees get a four-year lookback. Future elections, missing election metadata, noncandidate committees, and closed committees are excluded. Closed flags from detail profiles are checked before any scoring or export.

Ordinary legislative peers must be current members of the **same chamber**: House
compares with House, and Senate with Senate. Senior leadership has the explicit
cross-chamber exception below. The official Legislature rosters
in `assets/current_legislators.json` establish membership, not an open committee
or a recent election date. Whole-name tokens match candidate or committee names
(accent and middle-initial tolerant); unverified names are excluded. This also
excludes challengers who have not served yet. Membership reflects today's roster,
including when an older fundraising cycle is selected.

`scraper/refresh_legislators.py` refreshes both rosters together. The weekly
Current Legislator Roster workflow proposes changes by PR when pipeline schedules
are enabled; membership updates take effect after that PR is merged and deployed.
A missing or unreadable roster stops recommendations rather than silently allowing
former members. The existing recent-election and closed-committee checks still apply.

Every eligible committee is scored for similarity. Anything scoring **≤ 20 is
discarded**; the top **20** survive.

Senior leadership uses the House Speaker, Senate President, House and Senate
Majority Leaders, and Ways and Means Co-Chairs as its **primary** pool across
chambers. These roles are excluded from ordinary candidates' comparisons. Exact
role titles use live leadership metadata first, then cached filer metadata;
assistants, deputies, Pro Tems, and subcommittee co-chairs do not qualify.

Automatic fundraising outliers among current same-party non-primary legislators
are **secondary** references across chambers. For each member, use their highest
cash-contribution total in the previous two completed two-year cycles (allowing
for staggered Senate elections). An outlier exceeds Q3 + 1.5 × IQR among at least
eight members with positive observed receipts. Closed profiles are excluded.
Current-cycle and lifetime totals do not establish outlier status. Only timeline
projections are loaded in one request, not every member's donor profile. Primary members sort first
before the 20-comparison cap. Party, current-membership, election recency, and
admin exclusion filters still apply; seat margins do not restrict leadership
references. Each donor's primary leadership giving sets repeat and first-time
benchmarks; secondary gifts are used only when no primary giving is available.
The same priority applies to observed first-gift amounts. Secondary giving remains
visible in history and can inform prospect discovery and ranking, but does not
raise an ask when primary giving exists. A single primary recipient can support
a prospect; secondary-only prospects still require more than one recipient.

Speaker giving receives the existing 10% discount for a House Majority Leader
target. Other role pairings have no new multiplier. Actual contribution amounts
remain unchanged. App summaries identify primary and secondary filers; row
explanations and workbook methodology state which reference group sets asks.

Other leadership members (assistants, deputies, whips, Pro Tems, floor managers,
minority leaders) and current committee chairs form a separate role group within
the **same chamber**. Ordinary members compare to ordinary members. Primary senior
leaders remain in their separate cross-chamber pool. Chairs and co-chairs come
from the official OLIS assignments asset, refreshed by the existing weekly roster
PR workflow; vice chairs alone do not qualify. Effective leadership tiers reflect
these verified assignments even when cached filer tiers are zero.

For everyone else with known seat competitiveness, peers must have known seat
competitiveness too. Unopposed seats only compare with unopposed seats; contested
seats must be within 20 margin points. These are eligibility restrictions, so a
thin donor sample cannot bring excluded leaders or mismatched seats back through
the fallback. The narrower 5/10/20-point donor benchmark selection still applies
within this eligible pool. Smaller pools are retained rather than filled with
incompatible candidates just to reach the 20-comparable cap.

| Signal | Weight |
|---|---|
| Same office | **+40** |
| Related office (legislative → statewide) | **+30** |
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

Start from what this donor gave to comparable committees — recently:

```
evidence = one gift per comparable committee, chosen by the recency window
           above (stale gifts only when nothing current exists, and flagged)
peers    = the evidence given in seats whose last general finished within N
           points of this one  (N widens 5 → 10 → 20 until 3 gifts qualify)
base     = midpoint(median, 75th percentile) of peers   ← all the evidence if
                                                          too few peer gifts
ask      = min(base, largest single gift)   ← never above what they have given
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
- Unopposed seats form a separate category, never a numeric 100-point margin.
  They benchmark against at least three gifts to other unopposed seats; contested
  seats exclude unopposed seats from every margin window. When that sample is too
  small, the explicitly labeled fallback uses only the eligible comparison pool. The app
  and workbook label these comparisons as unopposed-seat peers.
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

Lobbyists are worked **Tier 1 → Tier 4**. A tier is a claim about likelihood
to give, and rests entirely on what can be observed:

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

**Every lobbyist is scored.** There used to be a hand-set `PARTNER` rank above
Tier 1 — a standing relationship with one caucus, recorded per chamber and
party at `/admin/lobbyists`. It has been removed everywhere: from both plans,
from the admin page and from the exports. A designation that outranks the
score tells you who someone knows, not what their book is worth to the
committee in front of you, and the score already says the second thing. Four
lobbyists carried the label; they now sit at the tier their book earns.

The `lobbyist_partners` table is left in place and is no longer read or
written. Nothing in the app depends on it, and dropping it would throw away
the only record of who was designated, so it is dormant rather than deleted.

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

### Lobbyist-level targets

A lobbyist or firm target is the greater of its summed client asks and the
previous cycle's giving to this candidate from its currently attributed clients.
Clients omitted by individual recommendation thresholds still count toward this
floor and current-cycle credit. Historical client rows do not create new
individual donor recommendations. This describes the current client book, not
verified historical representation.

The floor rounds upward to a $250 increment when nearest-$250 rounding would
fall below actual prior giving. Remaining is `max(0, lobbyist target - current
client giving)`, so one client's contribution can satisfy the overall lobbyist
goal. Any amount above summed donor asks stays unallocated at the lobbyist level;
the Call List and flat export include a clearly labeled additional lobbyist ask
so target totals reconcile. Searching a client retains the whole matching group
and its budget. Unattributed donors retain their individual asks.

### The fundraising ladder — which comparables get columns

The export's earlier-cycle columns exist to answer *what does this donor give
someone like my candidate?* Filling all five with the biggest recipients
answers a different question — it lists the five biggest fundraisers, the same
handful of leaders on every plan, and a back-bencher's sheet ends up
benchmarked entirely against the Speaker.

The columns span the ladder instead: **one candidate per rung**.

| Rung | Who is on it | How it is decided |
|---|---|---|
| 1 | **Caucus leadership** — Speaker, Senate President, Majority Leader | leadership tier 1 or 2 |
| 2 | **Senior safe-seat** — top of the pack, no election pressure, several cycles in | safe seat, top third of career fundraising |
| 3 | **Established mid** — middle of the pack in a seat that is not close | safe seat, middle third |
| 4 | **Competitive seat** — raising under election pressure | last general finished inside 20 points |
| 5 | **Back bench** — no leadership, no close race, least raised | safe seat, bottom third, no leadership |

Two things about where the rungs come from:

- **The pool is the whole chamber, not the comparables.** Comparables are
  deliberately *alike* — a back-bencher's comparables hold no Speaker, so a
  plan built from them could never show what a donor gives a Speaker, which is
  exactly the comparison the columns exist to make. The ladder is every
  committee of the target's chamber and party still standing for election
  (`election` year ≥ the previous cycle), minus the target itself. The top few
  raisers on each rung have their per-year donor tables loaded on top of the
  comparables — the one jsonb path, not the whole blob.
- **"How much they raise" is career total**, the only per-committee figure the
  index carries. It blends how big a fundraiser someone is with how long they
  have been one, which is what the rungs describe — a long-serving chair
  sitting above a first-term member in the same kind of seat.

**Committee chairmanships are not in ORESTAR**, and neither is legislative
tenure, so a long-serving chair in a safe seat can read as rung 3 rather than
rung 2. Pin a committee where it belongs with an `archetype` admin tag on its
slug (value `1`–`5`, in `admin_tags`); a pin always wins. The **How these
numbers were set** sheet names every rung, the committee chosen for its column
and the others on it.

Within a rung the column goes to the committee **this plan's donors actually
gave the most to**, so it holds evidence rather than blanks. A rung with no
committee gives its slot back to the next-largest recipient.

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
  directly, or mark a donor "not theirs". Each entry also carries its **firms**:
  add a person to a firm, or make them its primary contact, from either side.
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

## Top donors by chamber & party

The second mode on the Recommend tab. The candidate mode asks *who should this
candidate call?*; this one asks the question a caucus asks before any candidate
is in the room: **who gives to House Democrats, and how much does one of them
get?**

Pick a chamber, a party and a cycle to count back from, and it returns the top
**125 organizations**, each with a suggested ask, sorted under the lobbyist who
carries them.

### Who sets the ask

The median is what this donor gives an **ordinary member** of the caucus.
Three kinds of recipient come out of it:

| Out of the median | Why |
|---|---|
| Speaker, Senate President, Majority Leader, **Minority Leader** | given money on a scale a first call will not match |
| The full **Ways and Means** Co-Chairs | the same — they sit alongside the floor leaders |
| A **senior** member who also holds a leadership post or a committee gavel **and** raises far above the caucus | seniority and a gavel are common; only the combination distorts a median |

Senior means three or more completed cycles of giving — more than two terms.
"Raises far above" is Q3 + 1.5 × IQR of what **sitting members** raised in the
two completed cycles, the same outlier rule the candidate plan uses. Measuring
that against the whole cohort does not work: it holds decades of dormant
committees, which drags Q1 to almost nothing and puts the bar at $424,000,
where only the Speaker and the Majority Leader clear it. Against sitting
members it lands near $377,000.

Everyone excluded **keeps everything else**: their place in the giving
columns, and their weight in a donor's breadth, consistency and size. Only the
median leaves them out. A donor that gives nobody but leaders is priced on its
whole history, and its row says so.

#### Co-chairships are not chairships

OLIS lists 34 chairs and 62 co-chairs, because the full Ways and Means, every
one of its subcommittees and the Emergency Board's all have two. Counting
co-chairs as chairs put **Emerson Levy** in the roster as chair of Natural
Resources and **Paul Evans** as chair of Public Safety, when what they
co-chair is a Ways and Means subcommittee.

`scraper/refresh_legislators.py` now counts a co-chairship only for the full
Ways and Means (`JWM`), whose co-chairs really do sit with the floor leaders.
The roster went from 51 names to 35. This feeds the candidate plan's leadership
tiers as well, so it was mis-tiering comparables there too.

### The suggested ask

The recency-weighted median of what that donor gives **one candidate of this
kind across a whole cycle**, rounded — a call list asks for round numbers, but
a small ask has to stay small:

| Ask | Rounded to | Floor |
|---|---|---|
| under $1,000 | nearest **$250** | **$250** |
| $1,000 and over | nearest **$500** | — |

A donor whose giving sits at $250 is asked $250, not rounded up to $500 for
tidiness.

Contributions to the same candidate inside a cycle are added up first, so a
$1,000 primary cheque and a $1,000 general cheque read as one $2,000
relationship — which is what you ask for, not two separate $1,000 asks. The
median is then taken across those relationships, weighted by `CYCLE_WEIGHTS`,
so a donor's habits now outweigh a cheque it wrote a decade ago.

### Sorted into the people who carry them

The list is not a ranking to read top to bottom; it is a **call list**. So it
is laid out the way the fundraising team's lobby list is laid out: **one row
per lobbyist**, and the donors sorted underneath the person who carries them,
so a candidate reads down the *Suggested ask(s)* column and makes the calls.

| Column | What is in it |
|---|---|
| **Tier** | Tier 1–4, all computed |
| **Who to call** | portrait, name, firm and contact details, and anyone else attached to those donors |
| **Suggested ask ⟨cycle⟩ by client** | one line per donor — *donor: $2,500* |
| **Donor clients** | the donors this lobbyist carries, as a list |
| **⟨cycle⟩ giving** | one line per donor: *donor: $20,000 Fahey, $15,000 Levy E …*, for each of the three most recent cycles |
| **Also lobbied by** | anyone else attached to those donors: the name, the clients they are an additional contact for in brackets, then firm, email and phone |

Tiers are colour-coded — green, amber, blue, and nothing for Tier 4 — the same
on screen and in the workbook.

Donor names are **bold** in the ask breakdown and the giving columns, so a
column of them can be read down rather than across.

A donor appears under **one** lobbyist, chosen exactly as the candidate plan
chooses: an admin's filing at `/admin/lobbyists` first, then a link marked
primary, then a confirmed link over an unreviewed one, then the stronger
match. Everyone else attached to the donor is listed as *also*.

### The order lobbyists are worked in

**Tier first, then combined client likelihood.** Rows are grouped by tier, so
each colour band runs together down the page and in the workbook rather than
alternating with the others.

Inside a tier the order is the donor scores of everyone that lobbyist carries,
added up. Who to call first is a question about the donors, so it is answered
with the same score that ranked them: consistency, breadth and per-cycle size
through the recency window. Six likely donors are a better morning than one,
so the total rather than the average.

### Clients below the cut

A lobbyist already on the list often carries donors ranked just below the top
125. Those appear in that lobbyist's **giving columns**, and in **Donor
clients** under *also represents* — they are part of the call you are about to
make even though they are not part of the ask. Nothing marks them *(no ask)*:
*also represents* already says it, and the marker only cluttered a column read
by eye.

They carry **no suggested ask**, and they count toward neither the lobbyist's
tier nor their place in the order, which stay on the clients that do. The band
runs to rank `LIST_CONTEXT_SIZE` (250); a lobbyist with *only* clients from it
does not appear at all.

### Donors nobody carries

A donor with no lobbyist attached has nobody to call, so it is **left out of
the ranking** rather than sorted to the bottom. Those donors are listed under
the table — named, with their asks, not ranked — and recorded for
`/admin/lobbyists`, where the **Unmatched donors** tab pulls them to the top
with a badge naming the list, the rank they would have had and the ask.

That hand-off is per-browser: the list writes it when you build it, and the
admin banner says when that was. It is a note to the person building the
list, not a record anything depends on.

### Who the giving history names

The giving columns name **only members who currently hold the seat**, checked
against the chamber roster in `docs/assets/current_legislators.json`. Money
given to someone who lost or retired is no guide to who to ring now — Brian
Clem and RJ Navarro were turning up in call lists years after leaving.

That giving still counts toward the donor's ask: what it gave a member of this
chamber is evidence of what it gives a candidate of this kind, whoever holds
the seat today. It is the *history column* that is restricted to people you
can actually call.

Candidates read as a **surname** — *Fahey*, *Nosse* — and as a surname plus a
first initial where the chamber seats two of them. Bobby Levy and Emerson Levy
both sit in the House, so both read *Levy B* and *Levy E*. The collision is
detected from the roster, not hand-maintained.

### Tier

`6 × donors carried` (max 30) + `2 × like candidates their donors support`
(max 30) + `what those donors gave them ÷ 5,000` (max 20) — the candidate
plan's rule minus the two bonuses that need a single committee to have given
to, which a chamber list does not have.

Every lobbyist is scored; there is no designation above the tiers. (There was
one, `PARTNER`, and it has been removed from both plans — see
[Tiers](#tiers).)

### The score (0–100)

The three things that make a name worth putting on a standing call list, each
measured through the recency window:

| Component | Points | Measure |
|---|---|---|
| **Consistency** | 0 … **40** | the weighted share of the six cycles in the window in which they gave at all |
| **Breadth** | 0 … **35** | campaigns supported per cycle, weighted; full marks at `LIST_BREADTH_FULL` (35 a cycle) |
| **Magnitude** | 0 … **25** | put into the chamber per cycle, weighted; full marks at `LIST_MAGNITUDE_FULL` ($150,000 a cycle) |

Breadth and magnitude are logarithmic: the step from 2 campaigns to 6 says far
more about a donor than the step from 26 to 30.

### Who is on it, and who is not

- **Organizations only.** ORESTAR's own contributor category decides it, never
  the shape of a name — `Individual`, `Candidate & Immediate Family` and
  `Candidate's Immediate Family` are dropped, as in the Lobbyist Plan. A donor
  the resolver never gave an id has no category to read, so it cannot be shown
  to be an organization and is left out.
- **At least two cycles** of giving (`LIST_MIN_CYCLES`): one cycle is an event,
  not a habit.
- Candidate committees giving to each other are dropped, as everywhere else.

### Where the numbers come from

Every candidate committee of that chamber and party that ever raised at least
$5,000 (`LIST_MIN_RAISED`) — 230 committees for House Democrats, 86 for Senate
Democrats — read through `filer_detail`, selecting only the
`top_donors_by_year` path. A whole chamber is a megabyte or so on the wire
instead of forty, and the four lists build in seconds against the live
database with no new tables, views or indexes.

Merges saved at `/admin/donors` are applied to those tables as they are read
(`ID.rekeyDonorYears`). The whole-blob path re-queries merged totals one filer
at a time, which a chamber of 230 committees cannot afford, so the by-year
tables are merged in memory from the one identity map instead. Without it an
organization filed under two mailing addresses ranked, and was asked for
money, twice: Oregon Beverage Recycling Cooperative appeared at 58 asking
$1,500 and again at 96 asking $1,000, and Union Pacific took four places under
two spellings. Merged, OBRC is one row at 20.

Ranking comes first and contributor categories second. Reading the category
for all 11,000 donors to a chamber is seventy-odd round trips for a list of
125, so every donor is scored, then categories are resolved down the ranking,
300 at a time, until the list is full. In practice the top ~131 donors yield
all 125 organizations. The **How these were set** sheet reports how many were
scored, how many were checked, and what was dropped.

### What it is not

No seat, no margin and no relationship with a particular committee is in these
numbers — that is the point of a generic ask, and the reason the candidate
mode exists alongside it. Nothing here subtracts what a donor has already
given, benchmarks against comparable seats, or applies the first-time 50% cap.

### The files

The **Excel** file is the lobby list, column for column: tier, portrait, first
and last name, the ask by client, the donors, a column of giving per cycle,
then how to reach them. Headers frozen, the identity columns
frozen at the left, Tier 1 shaded, one row per lobbyist with the portrait
drawn into it, donor names bold inside the multi-line cells. Built with
ExcelJS — the community SheetJS build cannot write frozen panes, fills, rich
text or embedded images.

The writer takes its column numbers from its own header labels rather than
counting them by hand; counting them by hand put the bolded donor lists one
column to the left, over the ask and over Donors.

Alongside it: a **donors** sheet, one flat row per donor for pivoting, and
**How these were set**. **Excel — all four lists** builds House D, House R,
Senate D and Senate R for the same cycle into one workbook, a lobby-list sheet
each. **CSV** is the flat donor table.

---

## What it deliberately does not do

- **No cross-party suggestions** when the target's party is known.
- **No donor invented from nothing** — every suggestion has a giving history
  with a comparable committee.
- **No ask above a donor's largest observed gift.**
- **No ask priced by a relationship that has lapsed** — giving more than five
  cycles back is history on the row, never a benchmark.
- **No ask set outright by one comparable's gift** — a reference can only pull
  an ask toward it, through a blend the row spells out.
- **No competitiveness multiplier** — seat matching selects the evidence.
  First-time asks have the explicit 50% introductory cap described above.
- **No primary-margin influence**, by design.

## Tuning it

| Change | Where |
|---|---|
| Similarity weights, the ≤ 20 cutoff, top-20 | `findComparables()` |
| Score factors 1–8 | `buildRepeatDonorTargets()` / `scoreDonors()` |
| Competitiveness bands (comparability and labels) | `MARGIN_BANDS` / `UNOPPOSED` |
| Peer-margin windows and the 3-gift minimum | `PEER_WINDOWS` / `MIN_PEER_GIFTS` |
| How far back evidence reaches | `RECENT_BENCHMARK_CYCLES` / `STALE_BENCHMARK_CYCLES` / `CYCLE_WEIGHTS` |
| Rungs of the fundraising ladder | `FUNDRAISER_LEVELS` / `fundraiserLadder()` |
| Pin one committee to a rung | `archetype` admin tag on its slug, value 1–5 |
| The standing list's size, floors and weights | `LIST_SIZE` / `LIST_MIN_*` / `LIST_WEIGHTS` |
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


### Stored canonical donor IDs (migrations 026–027)

Apply `026_donor_filer_index.sql` first using `scraper/db_admin.py apply`; its
runner builds the covering transaction index concurrently and repairs an invalid
index left by an interrupted build. Then apply `027_stored_donor_identities.sql`
before deploying the matching frontend. Migration 027 backfills existing saved
merges; it does not rewrite transaction identities or require a full resolver run.

`donors.canonical_entity_id` stores the effective donor identity. Unmerged donors
point to themselves. Entity Merges saves still record reviewed alias pairs, but
triggers now resolve those decisions once before commit, updating the column and
preserving historical ID redirects. The existing shared `donor_identity_map`
interface reads stored assignments, so donor search, profiles, rankings, first
gifts, and lobbyist attribution retain the same grouping semantics without
running the recursive graph during page loads.

The affected-committee list is also stored and indexed. Refresh only examines
transaction history for newly added or changed merge members; new transaction
imports maintain the list from their inserted/updated rows. Recommendations
check this small list instead of probing statewide transaction history. Undo or
deletions can leave conservative extra flags until all merges are removed; these
cause a fresh donor query, never an incorrectly unmerged cached result.

Alias changes, new donors, historical anchors, and full resolver rebuilds queue
one identity refresh per transaction. Identity maintenance and transaction-cache
maintenance serialize with a transaction-scoped advisory lock. A failed refresh
rolls back the save/import, so readers cannot see partially applied merges.
Normal donor-name edits are reflected by the stored map's join to the current
canonical donor label. Existing open browser pages still require a refresh.

After migration 027, the resolver no longer physically applies Entity Merges
must-link decisions; canonical assignments handle them. It continues honoring
explicit separate decisions and normal automatic entity resolution. Legacy
physical consolidations can still require a resolver run to recover distinct
source IDs before an undo can separate them. Other recommendation queries and
large initial migration work can still be expensive: this removes the merge
check's transaction scans, not all database work.

### Stored name-only labels (migrations 028–029)

Migration 027 stores canonical IDs, but older chart blobs also need label-only
identity matching. The original `donor_identity_labels` view normalized every
donor/alias during reads and could still exceed the API timeout. Migration 028
adds expression indexes (built separately and concurrently by `db_admin.py`),
and 029 stores the unambiguous labels at the same commit boundary as donor IDs.
Checks include unrelated donors that share a normalized name; ambiguous labels
are never merged automatically. Alias imports, undo, and donor display-name
edits refresh the stored labels atomically. Public reads only join this small
label cache to the canonical donor's current display name.

Deploy 028 then 029. The frontend additionally skips label reads for ID-bearing
chart rows and loads statewide contributor-type charts only for the statewide
overview. Candidate and multi-candidate overviews use their own profile data.

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

### Editing a lobbyist's clients

The Clients box provides Remove client for every source, including Capitol Club.
Each client appears once even if several sources list the relationship. Removal
is atomic across its sources and clears that lobbyist's client lead designation.
A persistent exclusion prevents imports from reactivating the relationship.
Removed and inactive clients appear in a collapsed section with Restore client;
restoration creates an active manual relationship without selecting a new lead.
Other lobbyists representing the client are unaffected. Admin/reviewer access is
required. Apply migration 023 before deploying the client editor frontend.


## First legislative campaign and incumbent baselines

For future cycles, fundraising through a legislator's first legislative primary
is excluded from ask baselines. The first general-election win is matched across
both House and Senate histories, with an earlier different winner in that seat
required as evidence of entry. Moving from House to Senate does not create a new
first-campaign cutoff. The first year of available results is not assumed to be
the first term. Missing or unmatched history leaves the existing baseline in
place rather than inventing a cutoff; available general-election winners currently
start in 2012. Appointed service and name changes may require additional history
before a cutoff can be verified.

The regular primary is the third Tuesday in May; eligible giving begins the next
day. The cutoff applies only to cycles after the first successful legislative
election, not to that campaign itself. For Lisa Fragala, the first election was
2024 and the cutoff starts May 22, 2024. Sources: [official biography](https://www.oregonlegislature.gov/fragala/Pages/biography.aspx)
and [Secretary of State primary announcement](https://apps.oregon.gov/oregon-newsroom/OR/SOS/Posts/Post/april-30-deadline-registration-may-primary-election).

The app queries dated, merge-aware contributions for the post-primary part of the
entry year and combines those with later annual totals. Earlier fundraising is
excluded from the separate ask history. It is still present in original history,
Last Cycle, and exported actual contribution columns. The adjustment applies to
repeat asks, comparable benchmarks, first-gift evidence, and lobbyist-group
minimums, including clients omitted from individual recommendations. A donor who
only gave before the cutoff has no incumbent baseline; an eligible peer benchmark
supports the limited-history weighting below, rounded to $250. The primary gift
is not reinstated as a floor. The 50% introductory cap continues to apply to new
donors, not repeat donors with an existing relationship.

An actual first contribution before the cutoff is not used as first-gift evidence;
a later gift is not relabeled as the first. If exact eligible first-gift evidence
is unavailable, the existing explicitly labeled annual proxy uses eligible giving.
Automatic fundraising outlier detection uses only complete cycles after verified
entry, so the initial primary cannot establish outlier status either. Bounded
four-at-a-time entry-year queries are cached by the existing donor data loader.
No source transactions are changed and no migration is required.


## Repeat asks for members with limited incumbent history

For legislative candidates, count completed two-year cycles with positive eligible
giving across the candidate's whole history, not just the individual donor. Ignore
the current cycle and the verified entry cycle, which contains only a partial
post-primary period. Repeat-donor asks blend the candidate's eligible baseline
(with 5% growth) with the donor's outlier-adjusted comparable benchmark:

| Completed eligible cycles | Comparable weight | Own baseline weight |
|---|---:|---:|
| None | 75% | 25% |
| One | 60% | 40% |
| Two or more | Existing history-led calculation | Existing calculation |

The blend can move an ask up or down. With no comparable giving for a donor, only
the candidate's own eligible baseline is used. The same-tier leadership floor is
retained only for established histories; it does not override the limited-history
blend. These are explicit policy weights, not fitted statistical estimates.

Example: a member with only a partial entry cycle, a $1,000 post-primary donor
baseline, and a $10,000 comparable benchmark gets
`25% × $1,050 + 75% × $10,000 = $7,762.50`, rounded to **$7,750**. With one completed
eligible cycle, the same example rounds to **$6,500**. First-time donor limits,
actual giving, and the existing eligible lobbyist-group floor remain unchanged.
Non-legislative candidates retain their existing weighting. App explanations and
the workbook Method sheet show the history count and policy.

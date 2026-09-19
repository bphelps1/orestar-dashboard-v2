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
5. Compute a target ask per donor               → scaled by seat competitiveness
```

Two lists come out: **Donor Targets** (people who already gave to this
committee and could give more) and **New Donor Prospects** (people who gave to
comparables but not to this committee).

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

Prospects whose computed ask lands **below $1,000** are dropped from the list.

---

## Step 5 — The target ask

Start from what this donor gave to comparable committees:

```
base = midpoint(median, 75th percentile)   ← of their gifts to comparables
base = min(base, largest single gift)      ← never suggest more than they've ever given
ask  = base × competitiveness multiplier
```

### Competitiveness multiplier

Closer races draw larger gifts, so a safe-seat donor history understates a
swing seat — and vice versa. The multiplier is **bounded**, so it tilts the
number rather than inventing one.

| Seat (last general, current district map) | Multiplier |
|---|---|
| **Competitive** — under 10-point margin | **× 1.25** |
| **Lean** — 10–20 points | **× 1.05** |
| **Safe** — over 20 points | **× 0.85** |
| **Unopposed** | **× 0.75** |
| No margin on record | × 1.00 |

Worked example — the two extremes of 2024, on a $1,000 base:

| Seat | 2024 margin | Ask |
|---|---|---|
| House District 22 | 0.77 pts | **$1,250** |
| House District 43 | 84.67 pts | **$850** |

Whenever the multiplier moves the number, the reason appears in the donor's
"why" list — e.g. *"Ask raised 25% — seat is competitive (<10 pt margin)
(2024)"* — so a scaled figure is never unexplained.

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
prospect grouped under the lobbyist who handles that donor, with the lobbyist's
contact details and subtotals — the layout of the fundraising PLAN sheet. The
**Lobbyist Plan Excel** export writes the same thing: a lobbyist row carrying
the subtotals, then one row per donor with the lobbyist repeated in column A.

A donor is listed under one lobbyist. Order of preference:

1. a link marked primary — the Fundraising Tracker's "Lobbyist 1", or the
   client's lead (below);
2. a confirmed link over an unreviewed one;
3. the stronger match.

Anyone else attached to the donor appears as "also: …". Unreviewed matches are
marked **?** and can be hidden with *Include unreviewed matches*.

Contact details are each lobbyist's **email and primary phone**. A donor filed
under a **firm** (Thorn Run, Oxley & Associates) shows the firm's primary
contact first and its other members in a collapsed list; the export puts the
primary in *Contact / Email / Phone* and the rest in *Other Firm Contacts*.

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
  directly, or mark a donor "not theirs".
- **Unmatched donors** — the largest donors since 2021 with nothing attributed;
  assign a lobbyist or a client.
- **Decisions** — everything confirmed or rejected, with undo.

The weekly *Lobbyist Attribution* workflow re-reads Capitol Club, re-reads the
contacts of up to 400 committees whose data is over 30 days old, and refreshes
suggestions. A confirmed or rejected row is never changed by a re-run.

## What it deliberately does not do

- **No cross-party suggestions** when the target's party is known.
- **No donor invented from nothing** — every suggestion has a giving history
  with a comparable committee.
- **No ask above a donor's largest observed gift**, even after scaling.
- **No primary-margin influence**, by design.

## Tuning it

| Change | Where |
|---|---|
| Similarity weights, the ≤ 20 cutoff, top-50 | `findComparables()` |
| Score factors 1–8 | `buildRepeatDonorTargets()` / `scoreDonors()` |
| Competitiveness bands and multipliers | `MARGIN_BANDS` / `UNOPPOSED` |
| $1,000 prospect floor | end of `scoreDonors()` |
| Exclude or flag a committee | `/admin` tags (`exclude`, `prolific`) |
| Lobbyist attribution | `/admin/lobbyists`; matching rules in `scraper/match_lobbyists.py` |

All weights are plain constants — there is no trained model and no hidden
state, so a change here is fully predictable in the output.

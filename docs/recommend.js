/**
 * recommend.js — Donor Recommendation Engine
 *
 * Transparent, explainable, rule-based v1.
 *
 * Flow:
 *  1. User authenticates via Supabase
 *  2. User searches for a candidate committee
 *  3. Engine finds comparable fundraisers (same office/party/chamber)
 *  4. Finds donors who gave to comparable filers
 *  5. Scores each donor on explainable factors
 *  6. Outputs recommendations with target ask and explanation
 */

"use strict";

// ── Utility helpers (shared with main app) ─────────────────────────────────
function fmt$(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtNum(n) { return Number(n).toLocaleString("en-US"); }
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// ── Cycle helpers ──────────────────────────────────────────────────────────
// Two-calendar-year cycle: 2026 cycle = Jan 1 2025 through Dec 31 2026
function cycleYears(cycle) {
  return [cycle - 1, cycle];
}
function currentCycle() {
  const yr = new Date().getFullYear();
  return yr % 2 === 0 ? yr : yr + 1;
}
function cycleDateRange(cycle) {
  const [y1, y2] = cycleYears(cycle);
  return { start: `${y1}-01`, end: `${y2}-12` };
}

// ── Data cache ─────────────────────────────────────────────────────────────
let filerIndex = null;
let filerFuse = null;
const filerCache = {};
let leadershipRoles = {};   // filer_id or slug → role info (from Supabase)
let adminTags = {};         // entity_id → tags (from Supabase)

// ── Auth ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth();
  if (session) {
    document.getElementById("user-info").textContent = session.user.email;
    await initApp();
  }

  document.getElementById("login-form-el").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    try {
      await signIn(
        document.getElementById("login-email").value,
        document.getElementById("login-password").value,
      );
      window.location.reload();
    } catch (err) {
      errEl.textContent = err.message || "Sign-in failed";
      errEl.hidden = false;
    }
  });

  document.getElementById("sign-out-btn").addEventListener("click", signOut);
});

// ── App initialization ─────────────────────────────────────────────────────
async function initApp() {
  showStatus("Loading filer data…", "loading");

  filerIndex = await DL.getBlob("filer_index");
  filerFuse = new Fuse(filerIndex, {
    keys: [
      { name: "name",            weight: 2 },
      { name: "candidate_name",  weight: 1.5 },
      { name: "office_district", weight: 1 },
      { name: "filer_id",        weight: 0.5 },
    ],
    threshold: 0.3,
  });

  // Try loading leadership roles and admin tags from Supabase
  try {
    const sb = await getSupabase();
    const { data: roles } = await sb.from("leadership_roles").select("*").is("end_date", null);
    if (roles) {
      roles.forEach(r => {
        const key = r.filer_id || r.filer_name.toLowerCase();
        leadershipRoles[key] = r;
      });
    }
    const { data: tags } = await sb.from("admin_tags").select("*");
    if (tags) {
      tags.forEach(t => {
        if (!adminTags[t.entity_id]) adminTags[t.entity_id] = [];
        adminTags[t.entity_id].push(t);
      });
    }
  } catch (e) {
    console.warn("Could not load Supabase data (tables may not exist yet):", e.message);
  }

  hideStatus();
  initSearch();
  initCycleSelector();
  initChamberList();
  initModeSwitch();
}

/** Two questions, two sets of controls: one candidate, or a whole chamber. */
function initModeSwitch() {
  const buttons = [...document.querySelectorAll(".mode-btn")];
  if (!buttons.length) return;
  buttons.forEach(button => button.addEventListener("click", () => {
    buttons.forEach(b => {
      const on = b === button;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      document.getElementById(b.dataset.mode).hidden = !on;
    });
    hideStatus();
  }));
}

// ── Filer search ───────────────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById("filer-search");
  const dropdown = document.getElementById("filer-results");
  let selectedFiler = null;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) { dropdown.hidden = true; return; }
    // Digits → exact/prefix filer-ID lookup ("4792" → Friends of Tina Kotek)
    let results;
    if (/^\d+$/.test(q)) {
      results = filerIndex
        .filter(f => String(f.filer_id).startsWith(q))
        .sort((a, b) => (String(a.filer_id) === q ? -1 : 0) - (String(b.filer_id) === q ? -1 : 0))
        .slice(0, 15);
    }
    if (!results || !results.length) {
      results = filerFuse.search(q).slice(0, 15).map(r => r.item);
    }
    if (!results.length) { dropdown.hidden = true; return; }
    dropdown.innerHTML = results.map((f, i) => {
      const metaParts = [fmt$(f.total_in) + " raised"];
      if (f.candidate_name) metaParts.push(f.candidate_name);
      if (f.party) metaParts.push(f.party);
      if (f.office_district || f.office) metaParts.push(f.office_district || f.office);
      else if (f.committee_type) metaParts.push(f.committee_type);
      if (f.election) metaParts.push(f.election);
      return `<li data-idx="${i}">
        <span>${esc(f.name)}</span>
        <span class="filer-meta">${metaParts.join(" · ")}</span>
      </li>`;
    }).join("");
    dropdown.hidden = false;
    dropdown._items = results;
  });

  dropdown.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const idx = parseInt(li.dataset.idx);
    const filer = dropdown._items[idx];
    if (filer) selectFiler(filer);
  });

  input.addEventListener("blur", () => setTimeout(() => dropdown.hidden = true, 150));

  window._selectFiler = selectFiler;
  window._getSelectedFiler = () => selectedFiler;

  async function selectFiler(filer) {
    selectedFiler = filer;
    input.value = filer.name;
    dropdown.hidden = true;

    showStatus("Loading filer details…", "loading");
    const profile = await loadFilerProfile(filer.slug);
    hideStatus();

    const info = document.getElementById("selected-filer-info");
    info.hidden = false;
    const detectedOffice = getOffice(filer);
    const detectedParty = getParty(filer);
    const officeBadge = filer.office_district || filer.office || (detectedOffice || "");
    const partyBadge = filer.party || (detectedParty === "D" ? "Democrat" : detectedParty === "R" ? "Republican" : "");
    const badges = [officeBadge, partyBadge].filter(Boolean).join(" · ");
    info.innerHTML = `
      <h3>${esc(filer.name)}</h3>
      ${badges ? `<div class="filer-badges">${esc(badges)}</div>` : ""}
      <div class="filer-stats">
        <div><span class="filer-stat-label">Cash Contributions</span><br><span class="filer-stat-value">${fmt$(profile.total_in)}</span></div>
        <div><span class="filer-stat-label">Total Expenditures</span><br><span class="filer-stat-value">${fmt$(profile.total_out)}</span></div>
        <div><span class="filer-stat-label">Cash on Hand</span><br><span class="filer-stat-value">${fmt$(profile.cash_on_hand)}</span></div>
        <div><span class="filer-stat-label">Transactions</span><br><span class="filer-stat-value">${fmtNum(profile.tran_count)}</span></div>
      </div>
    `;

    document.getElementById("cycle-section").hidden = false;
    document.getElementById("results-section").hidden = true;
  }
}

function initCycleSelector() {
  const sel = document.getElementById("cycle-select");
  const cur = currentCycle();
  for (let c = cur; c >= 2008; c -= 2) {
    sel.insertAdjacentHTML("beforeend", `<option value="${c}"${c === cur ? " selected" : ""}>${c - 1}–${c}</option>`);
  }

  document.getElementById("run-btn").addEventListener("click", runRecommendations);
}

async function loadFilerProfile(slug) {
  if (!filerCache[slug]) {
    filerCache[slug] = DL.getFilerDetail(slug);
  }
  return filerCache[slug];
}

async function loadRecommendationIdentities(profiles, filers) {
  const pending = profiles.map((profile, i) => ({ profile, filer: filers[i] })).filter(({ profile }) =>
    Object.values(profile.top_donors_by_year || {}).some(rows => rows.some(d => !d.donor_key)));
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length) {
      const { profile, filer } = pending.shift();
      const ids = profile.filer_ids?.length ? profile.filer_ids : [filer.filer_id];
      const data = await DL.getDonors({ filerIds: ids });
      profile.top_donors_by_year = data.by_year || {};
      profile.top_donors = data.all_time || [];
    }
  }));
}

/** Combine exact organizational display names before scoring, never personal names.
 * Distinct underlying IDs remain available for attribution and first-gift queries. */
async function loadPlanningKeys(profiles) {
  window._planningKeys = new Map();
  const ids = [...new Set(profiles.flatMap(p => Object.values(p.top_donors_by_year || {}).flat())
    .map(d => d.donor_id).filter(Boolean))];
  const donors = await LOB.fetchIn("donors", "donor_id,display_name,book_type", "donor_id", ids);
  const byName = new Map();
  for (const d of donors) {
    if (!d.book_type || PERSON_BOOK_TYPES.has(d.book_type)) continue;
    const name = donorDisplayName(d.display_name).toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(d.donor_id);
  }
  for (const [name, members] of byName) if (members.length > 1)
    for (const id of members) window._planningKeys.set(id, `organization:${name}`);
}

async function loadFirstGifts(profiles, comparables, compProfiles, cycle) {
  window._firstGifts = null;
  window._planIdentityIds = new Map();
  const keysById = new Map();
  for (const profile of profiles) for (const rows of Object.values(profile.top_donors_by_year || {})) {
    for (const d of rows) if (d.donor_id) {
      const key = donorKey(d);
      if (!window._planIdentityIds.has(key)) window._planIdentityIds.set(key, new Set());
      window._planIdentityIds.get(key).add(d.donor_id);
      keysById.set(d.donor_id, key);
    }
  }
  const filers = new Map();
  comparables.forEach((c, i) => {
    if (c.committee_type && c.committee_type !== "Candidate Committee") return;
    const ids = compProfiles[i].filer_ids?.length ? compProfiles[i].filer_ids : [c.filer_id];
    ids.filter(Boolean).forEach(id => filers.set(String(id), { ...c, baselineStart: compProfiles[i]._entryBaseline?.start, primaryExclusions: compProfiles[i]._primaryExclusions }));
  });
  try {
    const sb = await getSupabase();
    const earliest = new Map();
    const existing = new Set(Object.values(profiles[0].top_donors_by_year || {}).flat().map(donorKey));
    const breadth = new Map();
    for (const profile of compProfiles) {
      const keys = new Set(cycleYears(cycle).flatMap(year => profile.top_donors_by_year?.[year] || []).map(donorKey));
      for (const key of keys) breadth.set(key, (breadth.get(key) || 0) + 1);
    }
    const ids = [...keysById.keys()].filter(id => !existing.has(keysById.get(id)) && breadth.get(keysById.get(id)) > (leadershipPool(comparables) ? 0 : 1));
    for (let i = 0; i < ids.length; i += 150) {
      const data = await LOB.fetchAll(() => sb.rpc("recommendation_first_gifts", {
        p_donor_ids: ids.slice(i, i + 150), p_filer_ids: [...filers.keys()], p_through: `${cycle}-12-31`,
      }));
      for (const r of data || []) {
        const key = keysById.get(r.donor_id), comp = filers.get(String(r.filer_id));
        if (!comp || (comp.baselineStart && r.first_date < comp.baselineStart)
          || (comp.primaryExclusions || []).some(p => r.first_date >= p.start && r.first_date <= p.through)) continue;
        const pair = `${key}|${comp.slug}`;
        const prior = earliest.get(pair);
        if (!prior || r.first_date < prior.first_date || (r.first_date === prior.first_date && Number(r.amount) < prior.amount)) {
          earliest.set(pair, { key, first_date: r.first_date, amount: Number(r.amount),
            filer: comp.name, benchmarkFactor: comp.benchmarkFactor ?? 1, seatBand: comp.seat?.band, marginPts: comp.seat?.margin_pts ?? null });
        }
      }
    }
    window._firstGifts = new Map();
    for (const gift of earliest.values()) {
      if (!window._firstGifts.has(gift.key)) window._firstGifts.set(gift.key, []);
      window._firstGifts.get(gift.key).push(gift);
    }
  } catch (error) {
    console.warn("First-contribution lookup unavailable; using explicitly labeled annual proxy:", error.message);
  }
}

// ── Status helpers ─────────────────────────────────────────────────────────
function showStatus(msg, type) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.hidden = false;
}
function hideStatus() {
  document.getElementById("status-msg").hidden = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// RECOMMENDATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// Donors to always exclude from recommendations (aggregated/non-individual entries)
const EXCLUDED_DONORS = new Set([
  "miscellaneous cash contributions $100 and under",
  "miscellaneous contributors",
  "miscellaneous cash contributions",
  "misc cash contributions $100 and under",
  "aggregate contributions $100 or less",
]);
// ORESTAR's pooled line for unitemized small gifts, however a filer words it:
// "Miscellaneous Contributions $100 and under", "Misc. Contributions Under
// $100", "MISCELLANEOUS-NOT OVER $100". It is not a donor anyone can ask, and
// the one spelling the set above missed sat at #1 on the House Democratic list.
// "Aggregate Resource Industries" and its like are real companies, hence
// "contribut" on that branch.
const POOLED_SMALL_GIFTS = /^misc(?:ellaneous)?\b|^aggregate\s.*contribut/i;
// Other states' candidate committees stay donors: the user wants Friends of
// Reggie Harris (Columbus, OH) and its like asked like anyone else. Only
// Oregon candidate committees, which the filer index names, are left out.
function isDonorExcluded(name) {
  const label = String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
  return EXCLUDED_DONORS.has(label) || POOLED_SMALL_GIFTS.test(label);
}

async function runRecommendations() {
  const filer = window._getSelectedFiler();
  if (!filer) return;

  const cycle = parseInt(document.getElementById("cycle-select").value);
  const years = cycleYears(cycle).map(String);
  window._targetFiler = filer;   // chamber/party for comparable selection

  document.getElementById("run-btn").disabled = true;
  showStatus("Finding comparable fundraisers…", "loading");

  try {
    // 1. Load the target filer's profile
    const targetProfile = await loadFilerProfile(filer.slug);

    await Promise.all([loadLegislativeWinners(), loadPrimaryCampaigns()]);
    // 2. Find comparable filers
    const comparables = await findComparables(targetProfile, filer, cycle);
    showStatus(`Loading donor data for ${comparables.length} comparable filers…`, "loading");

    // 3. Load profiles for all comparables
    const compProfiles = await Promise.all(
      comparables.map(c => loadFilerProfile(c.slug))
    );

    // Closed status lives in the detail cache, not every filer-index version.
    for (let i = comparables.length - 1; i >= 0; i--) {
      if (compProfiles[i]?.closed) {
        comparables.splice(i, 1);
        compProfiles.splice(i, 1);
      }
    }

    // Cached profiles may be rebuilt from raw labels between resolver runs.
    // Repair missing identities from the same scoped donor query as Donor Lookup
    // before scoring, classifying repeat donors, or building export history.
    await loadRecommendationIdentities([targetProfile, ...compProfiles], [filer, ...comparables]);

    showStatus("Separating exceptional primary fundraising from ask baselines…", "loading");
    await loadIncumbentBaselines([targetProfile, ...compProfiles], [filer, ...comparables], cycle);
    showStatus("Combining donor identities…", "loading");
    await loadPlanningKeys([targetProfile, ...compProfiles]);

    showStatus("Checking first-time giving…", "loading");
    await loadFirstGifts([targetProfile, ...compProfiles], comparables, compProfiles, cycle);

    // 4. Build repeat donor targets (existing donors to THIS filer)
    showStatus("Analyzing repeat donors…", "loading");
    targetProfile._leadershipTier = effectiveLeadershipTier(filer);
    targetProfile._recommendationOffice = getOffice(filer);
    const targetSeat = seatCompetitiveness(filer);
    const { targets: repeatTargets, notRecommended: repeatNotRec } = buildRepeatDonorTargets(targetProfile, comparables, compProfiles, years, cycle, targetSeat);

    // 5. Build new donor scoring
    showStatus("Scoring new donors…", "loading");
    const { prospects: recommendations, notRecommended: prospectNotRec } = scoreDonors(targetProfile, comparables, compProfiles, years, cycle, targetSeat);
    const allNotRecommended = [...repeatNotRec, ...prospectNotRec];

    // 6. Display results, with what seats of this closeness actually raise
    window._compCycles = buildCompCycleIndex(comparables, compProfiles);
    // The export's earlier-cycle columns span the chamber's fundraising ladder,
    // not just the comparables, so a few more committees' donor histories are
    // indexed — the per-year tables only, a fraction of a full blob.
    window._fundraiserLevels = fundraiserLadder(filer, cycle);
    try {
      const extra = ladderCandidates(window._fundraiserLevels)
        .filter(slug => !comparables.some(c => c.slug === slug));
      if (extra.length) indexLadderGiving(await DL.getFilerDonorYears(extra), window._fundraiserLevels);
    } catch (e) {
      console.warn("Ladder committees unavailable; columns fall back to the comparables:", e.message);
    }
    window._primaryExclusionNotes = [targetProfile, ...compProfiles].flatMap((p,i) =>
        (p._primaryExclusions || []).map(x => ({...x, name:i ? comparables[i-1].name : x.name})));
    const seatContext = seatPeerContext(comparables, compProfiles, cycle, targetSeat, targetProfile);
    displayResults(recommendations, repeatTargets, targetProfile, comparables, cycle, allNotRecommended,
                   targetSeat, seatContext);

  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
    console.error(err);
  } finally {
    document.getElementById("run-btn").disabled = false;
  }
}

// ── Office hierarchy for asymmetric comparability ─────────────────────────
// Legislative donors flow UP to statewide, but not down.
const LEGISLATIVE_OFFICES = new Set(["state_rep", "state_senate"]);
const STATEWIDE_OFFICES = new Set(["governor", "sos", "ag", "treasurer"]);

/**
 * Check if fOffice is comparable to targetOffice.
 * - state_rep ↔ state_senate: never comparable
 * - legislative → statewide: comparable (donors flow up)
 * - statewide → legislative: NOT comparable (donors don't flow down)
 * - same office: always comparable
 */
function isOfficeComparable(targetOffice, fOffice) {
  if (!targetOffice || !fOffice) return false;
  if (targetOffice === fOffice) return true;
  // Different legislative chambers never share a comparison pool.
  if (LEGISLATIVE_OFFICES.has(targetOffice) && LEGISLATIVE_OFFICES.has(fOffice)) return false;
  // Legislative → statewide: filer is legislative, target is statewide
  if (STATEWIDE_OFFICES.has(targetOffice) && LEGISLATIVE_OFFICES.has(fOffice)) return true;
  // Statewide ↔ statewide: comparable
  if (STATEWIDE_OFFICES.has(targetOffice) && STATEWIDE_OFFICES.has(fOffice)) return true;
  return false;
}

// ── Leadership tier definitions ───────────────────────────────────────────
// Tier 1: Speaker of the House, President of the Senate
// Tier 2: Majority Leaders, Ways & Means Co-Chairs
// Tier 3: Chairs, Pro Tems, Whips, other leadership positions
// Tier 0: Not in leadership
//
// Leadership tiers influence comparable-filer matching (affinity scoring),
// NOT individual donor ask amounts — comparable uplift handles that naturally.

// ── Step 2: Find comparable fundraisers ────────────────────────────────────
// ── Seat competitiveness ─────────────────────────────────────────────────────
//
// How close a seat is shapes what donors give: a swing-seat candidate can ask
// for more than someone in a safe seat, and a safe seat's donor history is a
// poor template for a competitive one. Margins come from race_margins
// (general elections only — primaries are too variable to describe a seat).
//
// Competitiveness is used as a BENCHMARK, never as a multiplier. The engine
// does not scale a base ask up because a seat is close; it asks what this
// donor actually gave to candidates in seats of the same closeness, and uses
// that. The bands below only label a seat and steer which committees count as
// comparable — no number is derived from them.
//
// Only the CURRENT district era is used. Oregon redraws maps two years after
// each census (2012, 2022), so a pre-2022 margin describes a different
// electorate under the same district number.

const MARGIN_BANDS = [
  { band: "competitive", max: 10,       label: "competitive (<10 pt margin)" },
  { band: "lean",        max: 20,       label: "lean (10–20 pt margin)" },
  { band: "safe",        max: Infinity, label: "safe (>20 pt margin)" },
];
const UNOPPOSED = { band: "unopposed", label: "unopposed last cycle" };

// A gift counts as a peer benchmark when the seat it was given in finished
// within this many points of the target's margin. The windows widen until
// enough gifts qualify; below MIN_PEER_GIFTS the donor's whole history is
// used instead and the fallback is stated in the explanation.
const PEER_WINDOWS = [5, 10, 20];
const MIN_PEER_GIFTS = 3;

// ── Recency: an ask is argued from what a donor does now ──────────────────
//
// A gift is evidence of what a donor will give today only while the
// relationship it describes still holds. Oregon Nurses gave Susan McLain
// $25,000 in the 2013–14 cycle and $1,000–$2,000 in each of the last three;
// taking a comparable's lifetime maximum asked every candidate for $25,000 on
// the strength of a relationship that had ended a decade earlier.
//
// The window below is the one this engine already used for newer incumbents
// (the two completed cycles before this one — the cycle being planned is
// still in progress, so a peer's part-cycle total is not a benchmark), now
// applied to everyone. With nothing in it, the best gift in the stale window
// stands in and the row says so; older than that is history, not evidence.
const RECENT_BENCHMARK_CYCLES = [2, 4];
const STALE_BENCHMARK_CYCLES = [6, 8, 10];

/** "2023–2024" — the cycle a gift was given in. */
function cycleName(cycle) { return `${cycle - 1}–${cycle}`; }

/**
 * The cycle of a donor's giving to one comparable that argues an ask: their
 * largest inside the recent window, else inside the stale window (flagged),
 * else nothing at all.
 */
function benchmarkCycle(cyMap, cycle) {
  const given = offsets => offsets.map(back => ({ cycle: cycle - back, amount: cyMap[cycle - back] }))
    .filter(c => c.amount > 0);
  // Inside the recent window both cycles describe a live relationship, so the
  // larger of them is what the donor is good for.
  const fresh = given(RECENT_BENCHMARK_CYCLES);
  if (fresh.length) return { ...fresh.reduce((a, b) => (b.amount > a.amount ? b : a)), stale: false };
  // Outside it, take the LAST thing known about the relationship rather than
  // the biggest: reaching back twelve years for a maximum is how a single
  // decade-old gift priced every ask in the first place.
  const older = given(STALE_BENCHMARK_CYCLES);
  return older.length ? { ...older[0], stale: true } : null;
}

// The graded form of the same window, for figures that blend many gifts
// rather than choose one. Index = cycles ago; a gift older than this counts
// for nothing.
const CYCLE_WEIGHTS = [1, 1, 1, 0.5, 0.25, 0.1];

/** How many cycles back `giftCycle` sits from the cycle being planned. */
function cyclesAgo(giftCycle, planCycle) {
  return Math.round((planCycle - Number(giftCycle)) / 2);
}

/** How much a gift from `giftCycle` counts toward a blended figure. */
function cycleWeight(giftCycle, planCycle) {
  const ago = cyclesAgo(giftCycle, planCycle);
  return ago < 0 ? 0 : (CYCLE_WEIGHTS[ago] ?? 0);
}

/**
 * The amount at which half the weight sits below, each gift weighted by how
 * recent it is.
 *
 * Oregon Nurses gave Susan McLain $25,000 in 2013–14 and $1,000–$2,000 in
 * each of the last three cycles. A plain median over that history is pulled
 * up by a relationship that ended a decade ago; the weighted one answers
 * $2,000, which is what they actually give now.
 */
function weightedPercentile(entries, p) {
  const sorted = entries.filter(e => e.weight > 0 && e.amount > 0)
    .sort((a, b) => a.amount - b.amount);
  const total = sorted.reduce((s, e) => s + e.weight, 0);
  if (!total) return 0;
  let seen = 0;
  for (const e of sorted) {
    seen += e.weight;
    if (seen >= total * p) return e.amount;
  }
  return sorted[sorted.length - 1].amount;
}

function weightedMedian(entries) { return weightedPercentile(entries, 0.5); }

/** The phrase a row uses to say how old the giving behind its ask is. */
function recencyNote(stale, cycle) {
  const window = RECENT_BENCHMARK_CYCLES.map(back => cycleName(cycle - back)).reverse().join(" and ");
  return stale
    ? `Nothing in ${window} — benchmarked on older giving instead`
    : `Benchmarked on ${window}`;
}

// Senior legislative leadership shares a primary pool across chambers.
const HOUSE_MAJORITY_BENCHMARK_FACTOR = 0.90;
function leadershipTitle(filer) {
  const normalized = text => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const candidate = normalized(filer.candidate_name).replace(/\b[a-z]\b/g, "").replace(/\s+/g," ").trim();
  const name = normalized(filer.name);
  const live = Object.values(leadershipRoles).find(r =>
    (r.filer_id && [filer.filer_id,...(filer.filer_ids || [])].map(String).includes(String(r.filer_id)))
    || (r.filer_name && (normalized(r.filer_name) === candidate
      || ` ${name} `.includes(` ${normalized(r.filer_name)} `))));
  return normalized(live?.role_title || filer.leadership_role);
}
let committeeChairs = null;
async function loadCommitteeChairs() {
  if (committeeChairs) return committeeChairs;
  const response = await fetch("assets/current_committee_chairs.json", { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not verify committee chairs. Please retry.");
  const data = await response.json();
  if (!Array.isArray(data.chairs) || !data.chairs.length) throw new Error("Committee chair roster is unavailable.");
  committeeChairs = data.chairs;
  return committeeChairs;
}
const chairMatchCache = new WeakMap();
function chairAssignments(filer) {
  const cached = chairMatchCache.get(filer);
  if (cached?.roster === committeeChairs) return cached.matches;
  const matches = (committeeChairs || []).filter(r => r.chamber === getChamber(filer) && matchesElectionName(filer,r.name));
  chairMatchCache.set(filer, { roster: committeeChairs, matches });
  return matches;
}
function primaryLeadershipRole(filer) {
  const chamber = getChamber(filer), title = leadershipTitle(filer);
  if (!chamber) return null;
  if (chamber === "house" && /^(speaker of (the )?house|house speaker|speaker)$/.test(title)) return "speaker";
  if (chamber === "senate" && /^(president of (the )?senate|senate president|president)$/.test(title)) return "president";
  if (new RegExp(`^(${chamber} )?majority leader$`).test(title)) return `${chamber}-majority-leader`;
  if (/^((house|senate|joint) )?ways (and )?means co ?chair(s)?$/.test(title)
    || chairAssignments(filer).some(r => r.committees.some(c => c.toLowerCase() === "ways and means"))) return "ways-means";
  return null;
}
function otherLeadershipOrChair(filer) {
  if (!getChamber(filer) || primaryLeadershipRole(filer)) return false;
  const title = leadershipTitle(filer);
  return chairAssignments(filer).length > 0
    || /\b(leader|whip|pro tem|floor manager|ex officio)\b/.test(title)
    || (/\bchair\b/.test(title) && !/\bvice\b/.test(title))
    || (!title && Number(filer.leadership_tier) === 3);
}
function effectiveLeadershipTier(filer) {
  const primary = primaryLeadershipRole(filer);
  return primary ? (["speaker","president"].includes(primary) ? 1 : 2)
    : otherLeadershipOrChair(filer) ? 3 : 0;
}
function completedHistoryCycles(profile, cycle) {
  const cycles = new Set();
  for (const [year, donors] of Object.entries(askDonorsByYear(profile))) {
    const c = yearToCycle(Number(year));
    if (c < cycle && (!profile._entryBaseline || c > profile._entryBaseline.year)
      && !(profile._primaryExclusions || []).some(p => p.year === c)
      && donors.some(d => Number(d.total) > 0)) cycles.add(c);
  }
  return cycles.size;
}
function limitedHistoryWeight(profile, cycle) {
  const office = profile._recommendationOffice || getOffice(profile);
  if (office && !LEGISLATIVE_OFFICES.has(office)) return null;
  const n = completedHistoryCycles(profile, cycle);
  return n === 0 ? 0.75 : n === 1 ? 0.60 : null;
}
function leadershipPool(comparables) {
  return comparables.length > 0 && comparables.every(c =>
    ["leadership-primary", "leadership-secondary"].includes(c.comparisonKind));
}
function leadershipReference(gifts, comparables) {
  if (!leadershipPool(comparables)) return null;
  const primaryNames = new Set(comparables.filter(c => c.comparisonKind === "leadership-primary").map(c => c.name));
  const primary = gifts.filter(g => primaryNames.has(g.filer));
  const chosen = comparables.some(c => c.chosen);
  return { gifts: primary.length ? primary : gifts,
    label: chosen ? "the comparison committees chosen for this candidate"
      : primary.length ? "primary leadership references" : "secondary fundraising-outlier references (no giving to primary leaders)" };
}
function leadershipFactors(factors, reference) {
  if (!reference) return;
  factors.push(`Benchmark: ${reference.label}; ${reference.gifts.length} recipient observations`);
  if (reference.gifts.some(g => (g.benchmarkFactor ?? 1) < 1))
    factors.push("House Majority Leader benchmark: Speaker giving discounted 10%; actual contributions remain unchanged");
}
// Tukey upper fence: unusually high fundraising relative to current same-party members.
// Use each member's best complete two-year cycle of the previous two cycles so
// staggered Senate elections are not judged only on an off-cycle period.
function fundraisingOutliers(filers, rows, cycle) {
  const bySlug = new Map(rows.filter(r => !r.closed).map(r => [r.slug, r]));
  const amounts = filers.filter(f => bySlug.has(f.slug)).map(f => {
    const timeline = bySlug.get(f.slug).timeline || [];
    const entry = firstLegislativeBaseline(f, cycle);
    const totals = [cycle - 2, cycle - 4].map(c => {
      if ((entry && c <= entry.year) || primaryExclusionsFor(f, cycle).some(p => p.year === c)) return 0; // Outliers require a complete incumbent cycle.
      const { start, end } = cycleDateRange(c);
      return timeline.filter(t => t.month >= start && t.month <= end)
        .reduce((sum, t) => sum + Number(t.contributions || 0), 0);
    });
    return { slug: f.slug, amount: Math.max(...totals) };
  }).filter(r => r.amount > 0);
  if (amounts.length < 8) return new Map(); // Too little evidence to label outliers.
  const values = amounts.map(r => r.amount).sort((a,b) => a-b);
  const q1 = percentile(values, 0.25), q3 = percentile(values, 0.75);
  const threshold = q3 + 1.5 * (q3 - q1);
  return new Map(amounts.filter(r => r.amount > threshold).map(r => [r.slug, { ...r, threshold }]));
}
async function loadFundraisingOutliers(targetFiler, cycle) {
  const party = getParty(targetFiler);
  if (!party) return new Map();
  const candidates = filerIndex.filter(f => f.slug !== targetFiler.slug
    && eligibleComparable(f, cycle) && isCurrentLegislator(f) && getParty(f) === party
    && !primaryLeadershipRole(f) && !(adminTags[f.slug] || []).some(t => t.tag === "exclude"));
  if (candidates.length < 8) return new Map();
  const sb = await getSupabase();
  // Only small timeline projections, not donor profiles for every legislator.
  const { data, error } = await sb.from("filer_detail")
    .select("slug,timeline:detail->timeline,closed:detail->closed").in("slug", candidates.map(f => f.slug));
  if (error) throw new Error(`Could not identify fundraising outliers: ${error.message}`);
  return fundraisingOutliers(candidates, data || [], cycle);
}
function benchmarkAmount(gift) { return gift.amount * (gift.benchmarkFactor ?? 1); }
function compatibleSeat(target, peer) {
  if (!target) return true; // No measured seat constraint is available.
  if (!peer) return false;
  if (target.band === "unopposed" || peer.band === "unopposed") return target.band === peer.band;
  return target.margin_pts != null && peer.margin_pts != null
    && Math.abs(target.margin_pts - peer.margin_pts) <= PEER_WINDOWS[PEER_WINDOWS.length - 1];
}



/**
 * The subset of a donor's comparable gifts made in seats about as contested
 * as the target's, using the narrowest window that holds enough of them.
 * Returns null when the target seat has no margin on record, or when even the
 * widest window is too thin to say anything.
 */
function peerMarginGifts(gifts, targetSeat) {
  // Numeric input is retained for callers with an actual contested margin.
  const seat = typeof targetSeat === "number" ? { margin_pts: targetSeat } : targetSeat;
  if (!seat) return null;
  if (seat.band === "unopposed") {
    const peers = gifts.filter(g => g.seatBand === "unopposed");
    return peers.length >= MIN_PEER_GIFTS ? { gifts: peers, window: null, kind: "unopposed" } : null;
  }
  if (seat.margin_pts == null) return null;
  for (const window of PEER_WINDOWS) {
    const peers = gifts.filter(g => g.seatBand !== "unopposed" && g.marginPts != null
      && Math.abs(g.marginPts - seat.margin_pts) <= window);
    if (peers.length >= MIN_PEER_GIFTS) return { gifts: peers, window, kind: "margin" };
  }
  return null;
}

function seatDescription(seat) {
  return seat?.band === "unopposed" ? "unopposed" : seat?.margin_pts != null
    ? `${seat.margin_pts.toFixed(1)} pt margin` : "no margin";
}

function peerDescription(peer) {
  return peer.kind === "unopposed" ? "unopposed seats" : `seats within ${peer.window} pts of this one`;
}

function peerGiftLabel(g) {
  return `${g.filer} (${seatDescription({ band: g.seatBand, margin_pts: g.marginPts })}): ${fmt$(g.amount)}`;
}

// Membership is separate from committee status: former members can keep open PACs.
let currentLegislators = null;
async function loadCurrentLegislators() {
  if (currentLegislators) return currentLegislators;
  const response = await fetch("assets/current_legislators.json", { cache: "no-cache" });
  if (!response.ok) throw new Error("Could not verify current legislators. Please retry.");
  const roster = await response.json();
  if (!["house", "senate"].every(c => Array.isArray(roster.members?.[c]) && roster.members[c].length)) {
    throw new Error("Current legislator roster is unavailable. Please retry.");
  }
  currentLegislators = roster.members;
  return currentLegislators;
}
function memberNameTokens(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z]+/g, " ").trim().split(/\s+/)
    .filter(t => t.length > 1 && !["jr", "sr", "ii", "iii"].includes(t));
}
// Keep reporting history intact; use a separate post-entry-primary history for asks.
let legislativeWinners = null;
async function loadLegislativeWinners() {
  if (legislativeWinners) return legislativeWinners;
  const sb = await getSupabase(), rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await sb.from("election_results")
      .select("id,year,office_normalized,district,candidate")
      .eq("election_type", "General").eq("won", true)
      .in("office_normalized", ["State Representative", "State Senator"])
      .order("id").range(start, start + 999);
    if (error) throw new Error(`Could not verify first legislative elections: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  if (!rows.length) throw new Error("First legislative election history is unavailable.");
  legislativeWinners = rows;
  return rows;
}
const ELECTION_NAME_VARIANTS = {
  rob:"robert", bob:"robert", bobby:"robert", deb:"deborah", debbie:"deborah",
  rich:"richard", rick:"richard", dick:"richard", bill:"william", will:"william",
  jim:"james", mike:"michael", dan:"daniel", dave:"david", tom:"thomas",
  chris:"christopher", kim:"kimberly", ben:"benjamin", jeff:"jeffrey",
  sue:"susan", liz:"elizabeth", matt:"matthew", greg:"gregory", ken:"kenneth",
  kate:"katherine", steve:"steven", stephen:"steven", joe:"joseph",
};
function electionNameTokens(name) {
  return memberNameTokens(name).map(t => ELECTION_NAME_VARIANTS[t] || t);
}
function matchesElectionName(filer, name) {
  const tokens = electionNameTokens(name);
  if (tokens.length < 2) return false;
  return [filer.candidate_name, filer.name].some(value => {
    const own = electionNameTokens(value);
    const shared = tokens.filter(t => own.includes(t));
    // Permit full middle names on either side; never match only a surname.
    return shared.length >= 2 && (tokens.every(t => own.includes(t)) || own.every(t => tokens.includes(t)));
  });
}
function firstLegislativeBaseline(filer, cycle) {
  if (!getChamber(filer) || !legislativeWinners?.length) return null;
  const wins = legislativeWinners.filter(r => matchesElectionName(filer, r.candidate)).sort((a,b) => a.year-b.year);
  const first = wins[0];
  const firstAvailableYear = Math.min(...legislativeWinners.map(r => r.year));
  if (!first || first.year <= firstAvailableYear || first.year >= cycle) return null;
  // A different predecessor provides affirmative evidence of entry; do not
  // treat the first available database record as someone's first term.
  const predecessor = legislativeWinners.filter(r => r.year < first.year
    && r.office_normalized === first.office_normalized && r.district === first.district)
    .sort((a,b) => b.year-a.year)[0];
  if (!predecessor || matchesElectionName(filer, predecessor.candidate)) return null;
  const may1 = new Date(Date.UTC(first.year, 4, 1));
  const primaryDay = 1 + (2 - may1.getUTCDay() + 7) % 7 + 14;
  return { year: first.year, primaryDate: `${first.year}-05-${String(primaryDay).padStart(2,"0")}`,
    start: `${first.year}-05-${String(primaryDay+1).padStart(2,"0")}` };
}
function askDonorsByYear(profile) {
  return profile?._askDonorsByYear ?? profile?.top_donors_by_year ?? {};
}
// Small reviewed evidence asset: no statewide transaction scans during a page load.
let primaryCampaigns = null;
async function loadPrimaryCampaigns() {
  if (primaryCampaigns) return primaryCampaigns;
  const response = await fetch("assets/primary_campaign_exclusions.json", {cache:"no-cache"});
  if (!response.ok) throw new Error("Could not verify primary-campaign exclusions. Please retry.");
  const data = await response.json();
  if (data.version !== 1 || !Array.isArray(data.exclusions) || data.exclusions.some(p =>
    !Number.isInteger(p.year) || !Array.isArray(p.filer_ids) || !p.filer_ids.length
    || !/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.through)
    || !/^\d{4}-\d{2}-\d{2}$/.test(p.resume)))
    throw new Error("Primary-campaign exclusion data is invalid. Please retry.");
  primaryCampaigns = data.exclusions;
  return primaryCampaigns;
}
function primaryExclusionsFor(filer, cycle, profile = {}) {
  const ids = new Set([...(profile.filer_ids || []), ...(filer.filer_ids || []), filer.filer_id].filter(Boolean).map(String));
  return (primaryCampaigns || []).filter(p => p.year <= cycle
    && (p.slug === filer.slug || p.filer_ids.some(id => ids.has(String(id)))));
}
function primaryExclusionNote(profile) {
  return (profile?._primaryExclusions || []).map(p =>
    `${p.year} unusually large contested primary: giving from ${p.start} through ${p.through} excluded from asks`).join("; ");
}
async function loadIncumbentBaselines(profiles, filers, cycle) {
  const pending = profiles.map((profile,i) => ({profile,filer:filers[i]}));
  await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
    while (pending.length) {
      const {profile,filer} = pending.shift();
      delete profile._askDonorsByYear; delete profile._entryBaseline; delete profile._primaryExclusions;
      const entry = firstLegislativeBaseline(filer,cycle);
      const exclusions = primaryExclusionsFor(filer,cycle,profile);
      if (!entry && !exclusions.length) continue;
      const filerIds = profile.filer_ids?.length ? profile.filer_ids : (filer.filer_ids?.length ? filer.filer_ids : [filer.filer_id].filter(Boolean));
      if (!filerIds.length) throw new Error(`Cannot verify post-primary giving for ${filer.name}: missing committee ID`);
      const adjusted = Object.fromEntries(Object.entries(profile.top_donors_by_year || {})
        .filter(([year]) => !entry || Number(year) > entry.year));
      const partialYears = new Map(entry ? [[entry.year, entry.start]] : []);
      for (const exclusion of exclusions) {
        if (entry && exclusion.year < entry.year) continue;
        delete adjusted[exclusion.year - 1];
        partialYears.set(exclusion.year, exclusion.resume);
      }
      for (const [year, start] of partialYears) {
        const partial = await DL.getDonors({start,end:`${year}-12-31`,filerIds});
        adjusted[year] = partial.by_year?.[year] || [];
      }
      profile._askDonorsByYear = adjusted;
      if (entry) profile._entryBaseline = entry;
      profile._primaryExclusions = exclusions;
    }
  }));
}

// Reviewed ORESTAR/legal-name variants; never match on surname alone.
const CURRENT_MEMBER_NAME_ALIASES = {
  "Ricki Ruiz": ["Ricardo Ruiz"],
  "Vikki Breese-Iverson": ["Vikki Iverson"],
  "Courtney Neron Misslin": ["Courtney Neron"],
};
/** The sitting member this committee belongs to, by roster name, else null. */
function currentMemberFor(filer) {
  const chamber = getChamber(filer);
  if (!chamber || !currentLegislators) return null;
  // Whole tokens accommodate middle initials and committee labels without fuzzy surname matches.
  const candidates = [filer.candidate_name, filer.name].map(n => new Set(memberNameTokens(n)));
  return currentLegislators[chamber].find(name =>
    [name, ...(CURRENT_MEMBER_NAME_ALIASES[name] || [])].some(variant => {
      const tokens = memberNameTokens(variant);
      return tokens.length >= 2 && candidates.some(candidate => tokens.every(t => candidate.has(t)));
    })) || null;
}

function isCurrentLegislator(filer) {
  return currentMemberFor(filer) !== null;
}

/**
 * How a call list writes a candidate: the surname alone, and the surname plus
 * a first initial when the chamber seats two of them — Bobby Levy and Emerson
 * Levy both sit in the House, so both read "Levy B" and "Levy E".
 */
function memberShortNames(chamber) {
  const roster = currentLegislators?.[chamber] || [];
  const bySurname = new Map();
  for (const name of roster) {
    const tokens = String(name).trim().split(/\s+/);
    const surname = tokens[tokens.length - 1];
    if (!bySurname.has(surname)) bySurname.set(surname, []);
    bySurname.get(surname).push(name);
  }
  const out = new Map();
  for (const [surname, names] of bySurname) {
    for (const name of names) {
      out.set(name, names.length > 1 ? `${surname} ${name.trim()[0]}` : surname);
    }
  }
  return out;
}

/** Only known, recent candidate elections can establish candidate comparability.
 * Senate and statewide executive candidates have four-year terms. Other offices use the previous cycle.
 * Missing election metadata is not evidence of a current candidacy.
 */
function eligibleComparable(filer, cycle) {
  if (filer.closed || filer.committee_type !== "Candidate Committee") return false;
  const year = Number(String(filer.election || "").match(/\b(?:19|20)\d{2}\b/)?.[0]);
  const lookback = ["state_senate", "governor", "sos", "ag", "treasurer"].includes(getOffice(filer)) ? 4 : 2;
  return year >= cycle - lookback && year <= cycle;
}

let raceMarginIndex = null;   // "Office|District" -> {margin_pts, band, label, year}

function bandFor(marginPts, unopposed) {
  if (unopposed) return UNOPPOSED;
  if (marginPts == null) return null;
  return MARGIN_BANDS.find(b => marginPts < b.max) || MARGIN_BANDS[MARGIN_BANDS.length - 1];
}

async function loadRaceMargins() {
  if (raceMarginIndex) return raceMarginIndex;
  raceMarginIndex = new Map();
  try {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("race_margins")
      .select("year, office_normalized, district, margin_pts, unopposed, era")
      .eq("era", "2022-")                       // current maps only
      .order("year", { ascending: false });
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      const key = `${r.office_normalized}|${r.district || ""}`;
      if (raceMarginIndex.has(key)) continue;   // newest year wins
      const b = bandFor(r.margin_pts, r.unopposed);
      if (b) raceMarginIndex.set(key, { ...b, margin_pts: r.margin_pts, year: r.year });
    }
    console.log(`[recommend] loaded competitiveness for ${raceMarginIndex.size} seats`);
  } catch (e) {
    console.warn("[recommend] race margins unavailable — scaling disabled:", e.message);
  }
  return raceMarginIndex;
}

/** Competitiveness for a filer, from its office_district ("State Representative, 15th District"). */
function seatCompetitiveness(filer) {
  if (!raceMarginIndex || !filer) return null;
  const od = (filer.office_district || "").trim();
  if (!od) return null;
  const i = od.indexOf(",");
  if (i === -1) return null;
  return raceMarginIndex.get(`${od.slice(0, i).trim()}|${od.slice(i + 1).trim()}`) || null;
}

// ── Comparison committees chosen by hand ──────────────────────────────────
// For a few candidates the user names the comparison committees outright, and
// that list replaces the rules in findComparables. Every chosen committee is a
// primary reference: Rob Nosse holds no senior leadership role, but he is on
// Ben Bowman's list and counts the same as the leaders on it. The House
// Majority Leader's 10% Speaker discount still applies.
const CHOSEN_COMPARABLES = new Map([
  ["friends_of_ben_bowman", ["friends_of_julie_fahey", "friends_of_rob_wagner", "kayse_jama_for_oregon",
                             "kate_lieber_for_state_senate", "tawna_sanchez_for_oregon", "friends_of_rob_nosse"]],
]);

function chosenComparables(targetFiler, slugs) {
  const targetRole = primaryLeadershipRole(targetFiler);
  const found = slugs.map(slug => (filerIndex || []).find(f => f.slug === slug));
  slugs.forEach((slug, i) => { if (!found[i]) console.warn(`[recommend] chosen comparable not on file: ${slug}`); });
  return found.filter(Boolean).map(f => ({
    ...f, similarity: 100, officeType: getOffice(f), party: getParty(f), chamber: getChamber(f),
    seat: seatCompetitiveness(f), comparisonKind: targetRole ? "leadership-primary" : "seat", chosen: true,
    leadership_tier: effectiveLeadershipTier(f), outlierEvidence: null,
    benchmarkFactor: targetRole === "house-majority-leader" && primaryLeadershipRole(f) === "speaker"
      ? HOUSE_MAJORITY_BENCHMARK_FACTOR : 1,
  }));
}

async function findComparables(targetProfile, targetFiler, cycle) {
  await Promise.all([loadRaceMargins(), loadCurrentLegislators(), loadCommitteeChairs()]);
  const chosen = CHOSEN_COMPARABLES.get(targetFiler.slug);
  if (chosen) return chosenComparables(targetFiler, chosen);
  const targetSeat = seatCompetitiveness(targetFiler);
  if (targetSeat) {
    console.log(`[recommend] target seat: ${targetSeat.label} (${targetSeat.year})`);
  }
  const officeType = getOffice(targetFiler);
  const party = getParty(targetFiler);
  const chamber = getChamber(targetFiler);
  const targetLeadershipRole = primaryLeadershipRole(targetFiler);
  const outliers = targetLeadershipRole ? await loadFundraisingOutliers(targetFiler, cycle) : new Map();
  const targetOtherLeader = otherLeadershipOrChair(targetFiler);
  const targetTier = effectiveLeadershipTier(targetFiler);
  const isTargetLeadership = targetTier > 0;

  console.log(`[recommend] Target: office=${officeType}, party=${party}, chamber=${chamber}, leadership_tier=${targetTier}`);

  const scored = [];

  for (const f of filerIndex) {
    if (f.slug === targetFiler.slug || !eligibleComparable(f, cycle)) continue;

    // Must have some fundraising activity
    if (f.total_in < 100) continue;

    const fOffice = getOffice(f);
    const fParty = getParty(f);
    const fChamber = getChamber(f);
    const fTier = effectiveLeadershipTier(f);
    const peerLeadershipRole = primaryLeadershipRole(f);
    const fTags = adminTags[f.slug] || [];
    let comparisonKind = "seat";
    if (targetLeadershipRole) {
      // Leadership and reviewed fundraising outliers may cross chambers.
      if (!fChamber || !isCurrentLegislator(f)) continue;
      if (peerLeadershipRole) comparisonKind = "leadership-primary";
      else if (outliers.has(f.slug)) comparisonKind = "leadership-secondary";
      else continue;
    } else {
      // Ordinary candidates never benchmark against the senior leadership group.
      if (peerLeadershipRole) continue;
      if (targetOtherLeader !== otherLeadershipOrChair(f)) continue;
      comparisonKind = targetOtherLeader ? "leadership-chair" : "seat";
      if (fChamber && !isCurrentLegislator(f)) continue;
      if (chamber && (fChamber !== chamber || !isCurrentLegislator(f))) continue;
      if (officeType && !isOfficeComparable(officeType, fOffice)) continue;
      if (!compatibleSeat(targetSeat, seatCompetitiveness(f))) continue;
    }

    // Party filter: if target has a known party, SKIP filers from other parties.
    // PACs/committees without party affiliation are allowed through.
    if (party && fParty && fParty !== party) continue;

    let similarity = 0;

    // Office comparability (asymmetric: legislative → statewide but not reverse)
    if (officeType && fOffice) {
      if (officeType === fOffice) {
        similarity += 40;  // Exact same office
      } else if (targetLeadershipRole || isOfficeComparable(officeType, fOffice)) {
        similarity += 30;  // legislative → statewide
      }
    }

    // Same party gets a bonus (already filtered opposite parties above)
    if (party && fParty === party) similarity += 15;

    // Similar fundraising magnitude
    const ratio = Math.min(f.total_in, targetFiler.total_in) /
                  Math.max(f.total_in, targetFiler.total_in, 1);
    similarity += ratio * 15;

    // Leadership-to-leadership affinity: heavy preference
    if (isTargetLeadership && fTier > 0) {
      // Both are leadership — strong bonus
      similarity += 25;
      // Extra bonus if same tier or adjacent tier
      if (fTier === targetTier) similarity += 10;
      else if (Math.abs(fTier - targetTier) === 1) similarity += 5;
    } else if (isTargetLeadership && fTier === 0) {
      // Target is leadership, comparable is not — no penalty.
      // Non-leadership filers with bigger donations are a strong signal
      // of donor capacity and should be included in comparables.
    } else if (!isTargetLeadership && fTier > 0) {
      // Target is NOT leadership but comparable IS — bigger penalty
      similarity -= 15;
    }

    // Seat competitiveness: prefer comparables from similarly-contested seats.
    // Without this, a safe-seat donor history can set the template for a swing
    // seat (and vice versa), which is exactly what skews the suggested ask.
    const fSeat = seatCompetitiveness(f);
    if (targetSeat) {
      if (fSeat) {
        if (fSeat.band === targetSeat.band) similarity += 12;
        else if ((fSeat.band === "competitive" && targetSeat.band === "safe") ||
                 (fSeat.band === "safe" && targetSeat.band === "competitive") ||
                 fSeat.band === "unopposed" || targetSeat.band === "unopposed") {
          similarity -= 8;                       // opposite ends of the scale
        }
      }
    }

    // Check admin tags for exclusions
    if (fTags.some(t => t.tag === "exclude")) continue;
    if (fTags.some(t => t.tag === "prolific") && !isTargetLeadership) {
      similarity -= 10;
    }

    if (similarity > 20) {
      scored.push({ ...f, similarity, officeType: fOffice, party: fParty, chamber: fChamber, seat: fSeat,
        comparisonKind, leadership_tier: fTier, outlierEvidence: outliers.get(f.slug) || null,
        benchmarkFactor: targetLeadershipRole === "house-majority-leader" && peerLeadershipRole === "speaker" ? HOUSE_MAJORITY_BENCHMARK_FACTOR : 1 });
    }
  }

  // Sort eligible peers by similarity descending, take at most 20
  scored.sort((a, b) => Number(b.comparisonKind === "leadership-primary") - Number(a.comparisonKind === "leadership-primary") || (b.outlierEvidence?.amount || 0) - (a.outlierEvidence?.amount || 0) || b.similarity - a.similarity);
  return scored.slice(0, 20);
}

/**
 * What committees in seats of the same closeness actually raise.
 *
 * The engine's answer to "is this ask realistic for a seat this contested?"
 * is measured, not assumed: take the comparables whose last general finished
 * within a few points of the target's, and report what they raised this
 * cycle. Shown on the results page and in the export so a target can be read
 * against its peers rather than against a multiplier.
 */
function seatPeerContext(comparables, compProfiles, cycle, targetSeat, targetProfile) {
  if (leadershipPool(comparables)) return null;
  if (!targetSeat || targetSeat.margin_pts == null) return null;
  const { start, end } = cycleDateRange(cycle);
  const raised = profile => (profile?.timeline || [])
    .filter(t => t.month >= start && t.month <= end)
    .reduce((s, t) => s + (t.contributions || 0), 0);
  const all = comparables
    .map((c, i) => ({ name: c.name, seat: c.seat, total: raised(compProfiles[i]),
                      leadership: (c.leadership_tier || 0) > 0 }))
    .filter(c => c.seat && c.seat.margin_pts != null);
  // Leadership raises on a different scale from the back bench, so a leader's
  // seat is only comparable to another leader's. Fall back to every seat when
  // that leaves too few.
  const isLeader = (targetProfile?._leadershipTier || 0) > 0;
  const sameRole = all.filter(c => c.leadership === isLeader);
  const withSeats = sameRole.length >= 3 ? sameRole : all;
  const selection = peerMarginGifts(withSeats.map(c => ({ ...c,
    seatBand: c.seat.band, marginPts: c.seat.margin_pts })), targetSeat);
  if (selection) {
    const peers = selection.gifts;
    const totals = peers.map(p => p.total).sort((a, b) => a - b);
    return {
      window: selection.window, kind: selection.kind, n: peers.length,
      median: percentile(totals, 0.5),
      p75: percentile(totals, 0.75),
      max: totals[totals.length - 1],
      raised: raised(targetProfile),
      leadershipOnly: withSeats === sameRole && isLeader,
      peers: peers.sort((a, b) => b.total - a.total),
    };
  }
  return null;
}

// ── Metadata helpers: use scraped ORESTAR data, fall back to name heuristics ─

/**
 * Normalize a scraped office string to a canonical office type.
 * ORESTAR gives us e.g. "State Representative" or "State Senator".
 */
function normalizeOffice(office) {
  if (!office) return null;
  const o = office.toLowerCase().trim();
  if (o.startsWith("state representative")) return "state_rep";
  if (o.startsWith("state senator") || o.startsWith("state senate")) return "state_senate";
  if (o === "governor") return "governor";
  if (o.includes("secretary of state")) return "sos";
  if (o.includes("attorney general")) return "ag";
  if (o.includes("treasurer")) return "treasurer";
  if (o.includes("commissioner")) return "commissioner";
  if (o.includes("county")) return "county";
  if (o.includes("city council") || o.includes("mayor")) return "city";
  if (o.includes("school") || o.includes("education")) return "school";
  if (o.includes("judge") || o.includes("justice")) return "judicial";
  return o; // Return as-is if no normalization matched
}

function getOffice(filer) {
  // 1. Scraped ORESTAR metadata (preferred)
  if (filer.office) return normalizeOffice(filer.office);
  // 2. Name-based fallback
  return detectOfficeFromName(filer.name || "");
}

function getParty(filer) {
  // 1. Scraped ORESTAR metadata (preferred)
  if (filer.party) {
    const p = filer.party.toLowerCase();
    if (p.startsWith("democrat")) return "D";
    if (p.startsWith("republican")) return "R";
    if (p.startsWith("independent") || p.startsWith("nonaffiliated")) return "I";
    return filer.party.charAt(0).toUpperCase();
  }
  // 2. Admin tags
  const tags = adminTags[filer.slug] || [];
  const partyTag = tags.find(t => t.tag === "party");
  if (partyTag) return partyTag.value;
  // 3. PAC nature may hint at party (e.g. "Supporting House Democratic Candidates")
  if (filer.nature) {
    const n = filer.nature.toLowerCase();
    if (n.includes("democrat")) return "D";
    if (n.includes("republican")) return "R";
  }
  // 4. Name-based fallback (rare)
  const name = (filer.name || "").toLowerCase();
  if (/\bdemocrat\b/.test(name)) return "D";
  if (/\brepublican\b/.test(name)) return "R";
  return null;
}

function getChamber(filer) {
  // Use office metadata first
  const office = getOffice(filer);
  if (office === "state_rep") return "house";
  if (office === "state_senate") return "senate";
  // Fallback to name
  const name = (filer.name || "").toLowerCase();
  if (/\b(house)\b/.test(name)) return "house";
  if (/\b(senate)\b/.test(name)) return "senate";
  return null;
}

// Legacy name-based detection (fallback when metadata not scraped)
function detectOfficeFromName(name) {
  const n = name.toLowerCase();
  if (/\b(state representative|state rep)\b/.test(n)) return "state_rep";
  if (/\b(state senator|state senate)\b/.test(n)) return "state_senate";
  if (/\bgovernor\b/.test(n)) return "governor";
  if (/\b(secretary of state)\b/.test(n)) return "sos";
  if (/\b(attorney general)\b/.test(n)) return "ag";
  if (/\b(treasurer)\b/.test(n)) return "treasurer";
  if (/\b(commissioner)\b/.test(n)) return "commissioner";
  if (/\b(county)\b/.test(n)) return "county";
  if (/\b(city council|mayor|city)\b/.test(n)) return "city";
  if (/\b(school|education)\b/.test(n)) return "school";
  if (/\b(judge|justice)\b/.test(n)) return "judicial";
  return null;
}

/**
 * Get all years a donor gave to any comparable filer (across ALL years, not just cycle).
 * Returns array of year numbers, e.g. [2020, 2022, 2024].
 */
/** Oregon cycles run odd→even, named for the even year: 2025 and 2026 → 2026. */
function yearToCycle(yr) { return yr % 2 === 0 ? yr : yr + 1; }

/**
 * A donor's identity, not its spelling.
 *
 * ORESTAR records the same organization under many labels — "FamilyCare",
 * "FamilyCare, Inc", "Familycare, Inc." — and the donor resolver (plus any
 * merge an admin records at /admin/donors) collapses them into one donor_id
 * that every aggregate carries as donor_key. Keying on the label instead
 * splits one donor into several and loses whatever the admin merged, so
 * everything here keys on donor_key and only shows the name.
 */
// User-confirmed corporate families for one fundraising ask. This does not
// merge the underlying legal entities or their transaction records.
const PLAN_DONOR_FAMILIES = new Map([
  ["amazon", "Amazon"], ["amazon com", "Amazon"],
  ["amazon services", "Amazon"], ["amazon com services", "Amazon"],
  ["genentech", "Genentech"], ["genentech usa", "Genentech"],
]);
function planDonorFamily(name) {
  const core = String(name || "").toLowerCase().replace(/[.,]/g, " ")
    .replace(/\b(?:incorporated|inc|llc|corporation|corp)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  return PLAN_DONOR_FAMILIES.get(core) || null;
}

/** Round final asks once, before calculating remaining balances. Halfway rounds up. */
function roundTarget(amount) {
  return Math.round(amount / 250) * 250;
}

/**
 * The least a plan may ask of anyone who gave last cycle: that giving plus 5%,
 * rounded UP to $250, so the ask is always more than last time. Nearest-$250
 * rounding alone handed a $1,000 donor a $1,000 ask. The plan's total target
 * uses the same floor against last cycle's total. Worked in cents first so a
 * product that lands on a $250 step is not pushed to the next one.
 */
const LAST_CYCLE_GROWTH = 1.05;
function aboveLastCycle(amount) {
  return amount > 0 ? Math.ceil(Math.round(amount * LAST_CYCLE_GROWTH * 100) / 25000) * 250 : 0;
}

function donorDisplayName(name) {
  const label = planDonorFamily(name) || String(name || "");
  return typeof DN !== "undefined" ? DN.display(label) : label.trim().replace(/\s+/g, " ")
    .replace(/\bat\s*&\s*t\b/gi, "AT&T").replace(/cooperative/gi, "Cooperative")
    .replace(/\b(pac|llc|usa)\b/gi, w => w.toUpperCase());
}

/** Earliest observed annual giving is a proxy, not a claimed first transaction.
 * Use one observation per comparable recipient, excluding future years.
 */
function firstGivingBenchmark(key, profiles, comparables, cycle, seat) {
  const actual = window._firstGifts?.get(key);
  if (actual?.length) {
    const reference = leadershipReference(actual, comparables);
    const peers = reference ? null : peerMarginGifts(actual, seat);
    const sample = reference?.gifts || peers?.gifts || actual;
    return { amount: percentile(sample.map(benchmarkAmount).sort((a,b) => a-b), 0.5), rawAmount: percentile(sample.map(g => g.amount).sort((a,b) => a-b), 0.5), n: sample.length, actual: true };
  }
  const gifts = [];
  profiles.forEach((profile, i) => {
    if (comparables[i].committee_type && comparables[i].committee_type !== "Candidate Committee") return;
    const years = Object.keys(askDonorsByYear(profile)).map(Number).filter(y => y <= cycle).sort((a,b) => a-b);
    for (const year of years) {
      const amount = (askDonorsByYear(profile)[year] || []).filter(d => donorKey(d) === key)
        .reduce((sum, d) => sum + Number(d.total || 0), 0);
      if (amount > 0) {
        gifts.push({ amount, filer: comparables[i].name, benchmarkFactor: comparables[i].benchmarkFactor ?? 1, seatBand: comparables[i].seat?.band, marginPts: comparables[i].seat?.margin_pts ?? null, year });
        break;
      }
    }
  });
  const reference = leadershipReference(gifts, comparables);
  const peer = reference ? null : peerMarginGifts(gifts, seat);
  const sample = reference?.gifts || peer?.gifts || gifts;
  return { amount: percentile(sample.map(benchmarkAmount).sort((a,b) => a-b), 0.5), rawAmount: percentile(sample.map(g => g.amount).sort((a,b) => a-b), 0.5), n: sample.length };
}

function donorKey(d) {
  const family = planDonorFamily(d.name || d.donor);
  if (family) return `family:${family.toLowerCase()}`;
  return window._planningKeys?.get(d.donor_id || d.donor_key) || d.donor_key || d.donor_id || `name:${String(d.name || "").trim().toLowerCase()}`;
}

/**
 * Every donor's giving to every comparable, by cycle:
 *   Map<donor name (lower), Map<comparable name, {cycle: amount}>>
 *
 * The scoring functions only look at the cycle being planned; the export needs
 * the earlier ones too, because "gave Julie Fahey $17,500 last cycle" is the
 * argument for this cycle's ask. Built once per run.
 */
function buildCompCycleIndex(comparables, compProfiles) {
  const idx = new Map();
  compProfiles.forEach((profile, i) => {
    const filer = comparables[i].name;
    for (const [yrStr, donors] of Object.entries(profile?.top_donors_by_year || {})) {
      const cy = yearToCycle(parseInt(yrStr));
      for (const d of donors) {
        const key = donorKey(d);
        if (!idx.has(key)) idx.set(key, new Map());
        const perFiler = idx.get(key);
        if (!perFiler.has(filer)) perFiler.set(filer, {});
        const byCycle = perFiler.get(filer);
        byCycle[cy] = (byCycle[cy] || 0) + d.total;
      }
    }
  });
  return idx;
}

function _getAllYearGifts(key, compProfiles, comparables) {
  const years = [];
  for (const profile of compProfiles) {
    const byYear = profile.top_donors_by_year || {};
    for (const [yr, donors] of Object.entries(byYear)) {
      if (donors.some(d => donorKey(d) === key)) {
        years.push(parseInt(yr));
      }
    }
  }
  return years;
}

// ── Step 4a: Donor Targets ────────────────────────────────────────────────
// For ANY donor who has ever given to THIS candidate, compute a fundraising
// target: ~5% increase from their last giving, adjusted upward if they gave
// more to comparable candidates.
function buildRepeatDonorTargets(targetProfile, comparables, compProfiles, years, cycle, targetSeat) {
  const byYear = targetProfile.top_donors_by_year || {};
  const allYears = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const cycleStart = cycle - 1;
  const historyCycles = completedHistoryCycles(targetProfile, cycle);
  const historyWeight = limitedHistoryWeight(targetProfile, cycle);

  // Build per-donor cycle history: donor → { cycles: {cycle: amount}, totalGifts }
  const donorHistory = new Map();
  for (const [yrStr, donors] of Object.entries(byYear)) {
    const yr = parseInt(yrStr);
    const cy = yearToCycle(yr);
    for (const d of donors) {
      const key = donorKey(d);
      if (!donorHistory.has(key)) {
        donorHistory.set(key, { name: donorDisplayName(d.name), donor_id: d.donor_id || null, cycles: {}, totalGifts: 0 });
      }
      const entry = donorHistory.get(key);
      entry.cycles[cy] = (entry.cycles[cy] || 0) + d.total;
      entry.totalGifts++;
    }
  }

  const baselineByDonorCycle = new Map();
  for (const [year, donors] of Object.entries(askDonorsByYear(targetProfile))) {
    for (const donor of donors) {
      const key = `${donorKey(donor)}|${yearToCycle(Number(year))}`;
      baselineByDonorCycle.set(key, (baselineByDonorCycle.get(key) || 0) + donor.total);
    }
  }

  // Get comparable giving for upside adjustment — track per-filer details
  // compDonorDetails: lowered name → [{ filer, maxCycleAmt }]
  const compDonorDetails = new Map();
  const observedComparableDonors = new Set();
  for (let i = 0; i < compProfiles.length; i++) {
    const profile = compProfiles[i];
    const comp = comparables[i];
    const compByYear = askDonorsByYear(profile);
    const compDonorCycles = new Map(); // donor → {cycle: amount}
    for (const [yrStr, donors] of Object.entries(compByYear)) {
      const yr = parseInt(yrStr);
      const cy = yearToCycle(yr);
      for (const d of donors) {
        const key = donorKey(d);
        if (!compDonorCycles.has(key)) compDonorCycles.set(key, {});
        const cyMap = compDonorCycles.get(key);
        cyMap[cy] = (cyMap[cy] || 0) + d.total;
      }
    }
    // Store per-filer max cycle amount for each donor
    const compIsLeadership = (comp.leadership_tier || 0) > 0;
    const compTier = comp.leadership_tier || 0;
    for (const [key, cyMap] of compDonorCycles) {
      observedComparableDonors.add(key); // Discovery is separate from the ask benchmark.
      // Newer incumbents need recent ordinary peer giving, not a peer's
      // lifetime maximum (or fundraising from the cycle being planned).
      const recentCycles = RECENT_BENCHMARK_CYCLES.map(back => cycle - back).filter(c => cyMap[c] > 0);
      if (historyWeight !== null && !recentCycles.length) continue;
      // Newer incumbents take the latest eligible cycle; everyone else takes
      // the largest inside the same window rather than a lifetime maximum.
      const pick = historyWeight !== null
        ? { cycle: recentCycles[0], amount: cyMap[recentCycles[0]], stale: false }
        : benchmarkCycle(cyMap, cycle);
      if (!pick) continue;              // every gift is older than the stale window
      if (!compDonorDetails.has(key)) compDonorDetails.set(key, []);
      compDonorDetails.get(key).push({ filer: comp.name, amount: pick.amount, isLeadership: compIsLeadership,
                                       leadershipTier: compTier, benchmarkFactor: comp.benchmarkFactor ?? 1, seatBand: comp.seat?.band, marginPts: comp.seat?.margin_pts ?? null,
                                       cycles: cyMap, referenceCycle: pick.cycle, stale: pick.stale });
    }
  }

  // Build set of candidate committee names for exclusion (not PACs or other types)
  const candidateFilerNames = new Set();
  if (filerIndex) {
    for (const f of filerIndex) {
      if (f.committee_type === "Candidate Committee") {
        candidateFilerNames.add(f.name.toLowerCase());
      }
    }
  }

  const results = [];
  const notRecommended = [];

  for (const [key, donor] of donorHistory) {
    // Skip aggregated/non-individual entries
    if (isDonorExcluded(donor.name)) continue;

    // Skip candidate committees (e.g. "Kate Lieber for State Senate (20136)")
    const nameNoId = donor.name.replace(/\s*\(\d+\)\s*$/, "").toLowerCase();
    if (candidateFilerNames.has(key) || candidateFilerNames.has(nameNoId)) continue;

    const cycleNums = Object.keys(donor.cycles).map(Number).sort((a, b) => a - b);
    // Eligible giving last cycle: exceptional primary windows left out.
    const lastEligible = baselineByDonorCycle.get(`${key}|${cycle - 2}`) || 0;

    // A one-cycle donor needs to have given to comparable candidates too,
    // unless that one cycle was the last one: everyone who gave last cycle is
    // asked to give again, for more.
    if (cycleNums.length < 2 && !observedComparableDonors.has(key) && !(lastEligible > 0)) continue;

    const currentCycleAmt = donor.cycles[cycle] || 0;
    const prevCycles = cycleNums.filter(c => c < cycle);

    const prevCycle = cycle - 2; // Most recent previous cycle
    const gaveInPrevCycle = donor.cycles[prevCycle] != null && donor.cycles[prevCycle] > 0;

    // Determine last giving amount for target calculation
    let lastCycle, lastCycleAmt;
    if (prevCycles.length) {
      lastCycle = prevCycles[prevCycles.length - 1];
      lastCycleAmt = donor.cycles[lastCycle];
    } else {
      // Only gave in current cycle — use current giving as base
      lastCycle = cycle;
      lastCycleAmt = currentCycleAmt;
    }

    const eligiblePastCycles = prevCycles.filter(c => (baselineByDonorCycle.get(`${key}|${c}`) || 0) > 0);
    const baselineCycle = eligiblePastCycles.length ? eligiblePastCycles[eligiblePastCycles.length - 1] : lastCycle;
    const baselineAmt = baselineByDonorCycle.get(`${key}|${baselineCycle}`) || 0;
    // Reporting retains full historical giving; asks use eligible post-primary giving.
    let target = Math.round(baselineAmt * 1.05 * 100) / 100;

    // Same-tier leadership floor: if a same-tier leader received more from this
    // donor, use that as the starting point (not just a blend).
    const compGifts = compDonorDetails.get(key) || [];
    const targetTier = targetProfile._leadershipTier || 0;
    // What a same-tier peer received is evidence, not the answer. Assigning it
    // to the target outright made one peer's gift the whole ask — a donor
    // giving this committee $2,000 a cycle was asked for $25,000 because it
    // once gave another member of the same tier that much. It is now one more
    // candidate reference, and the ask is always a stated blend of the donor's
    // own giving here with whichever reference is larger.
    let sameTierRef = 0;
    if (targetTier > 0 && historyWeight === null) {
      const sameTier = compGifts
        .filter(g => g.leadershipTier === targetTier && !g.stale)
        .map(benchmarkAmount).sort((a, b) => b - a);
      if (sameTier.length) {
        sameTierRef = (sameTier.length >= 2 && sameTier[0] > sameTier[1] * 1.5)
          ? sameTier[1] : sameTier[0];
      }
    }

    // Comparable upside adjustment: if they gave MORE to a comparable,
    // blend toward that amount — but scale weight INVERSELY with the gap.
    // A small gap (1.5x) means the comp amount is realistic for this donor;
    // a huge gap (10x+) means the relationship isn't there and we should
    // stay close to historical giving.
    //
    // The comparison set is the donor's giving in seats about as contested as
    // this one (peerMarginGifts) whenever enough of it exists: what a donor
    // gives a candidate in a 3-point race is the evidence for what they would
    // give this candidate in a 3-point race. Everything they gave is the
    // fallback, and the explanation says which was used.
    // Recency first, then the seat: a gift counts only while the relationship
    // it describes is current, and among current gifts the ones given in seats
    // about as close as this one set the number.
    const freshGifts = compGifts.filter(g => !g.stale);
    const evidence = freshGifts.length ? freshGifts : compGifts;
    const staleEvidence = !freshGifts.length && compGifts.length > 0;
    const reference = leadershipReference(evidence, comparables);
    const peer = reference ? null : peerMarginGifts(evidence, targetSeat);
    const refGifts = reference?.gifts || (peer ? peer.gifts : evidence);
    // Discount single-filer outliers: if the max is >1.5x the second-highest,
    // it's an outlier — use the second-highest as the reference instead.
    const sortedAmts = refGifts.map(benchmarkAmount).sort((a, b) => b - a);
    const seatRef = historyWeight !== null
      ? percentile([...sortedAmts].reverse(), 0.5)
      : (sortedAmts.length >= 2 && sortedAmts[0] > sortedAmts[1] * 1.5)
        ? sortedAmts[1] : (sortedAmts[0] || 0);
    const compRef = Math.max(seatRef, sameTierRef);
    const refGift = refGifts.find(g => benchmarkAmount(g) === compRef)
      || compGifts.find(g => benchmarkAmount(g) === compRef);
    const maxFromNonLeadership = refGift && !refGift.isLeadership;
    const historyBlend = historyWeight !== null && compRef > 0;
    const hasUplift = compRef > target;
    let compWeight = 0;
    if (historyBlend) {
      // Limited incumbent history is weaker evidence in either direction.
      // The peer reference already excludes first-primary giving and outliers.
      compWeight = historyWeight;
      target = Math.min(compRef, baselineAmt * 1.05 * (1-compWeight) + compRef * compWeight);
    } else if (hasUplift) {
      const gapRatio = compRef / Math.max(target, 1);
      if (gapRatio >= 8) compWeight = 0.05;
      else if (gapRatio >= 4) compWeight = 0.10;
      else if (gapRatio >= 2) compWeight = 0.20;
      else compWeight = 0.35;
      if (maxFromNonLeadership) compWeight = Math.min(compWeight + 0.05, 0.40);
      target = Math.round((target * (1-compWeight) + compRef * compWeight) * 100) / 100;
    }

    target = roundTarget(target);
    // Whatever the comparables say, a donor who gave last cycle is asked for
    // more: the peer cap for newer incumbents could otherwise land below what
    // the donor already gives this candidate. Eligible giving, as for the rest
    // of the ask, so exceptional primary windows do not set the floor.
    const evidenceTarget = target;
    const askFloor = aboveLastCycle(lastEligible);
    const floored = askFloor > target;
    if (floored) target = askFloor;
    const remaining = Math.max(0, Math.round((target - currentCycleAmt) * 100) / 100);

    if (!gaveInPrevCycle && prevCycles.length > 0) {
      // Lapsed donor — didn't give in most recent previous cycle
      notRecommended.push({
        donor: donor.name,
        type: "Previous Donor",
        lastGave: `${prevCycles[prevCycles.length - 1] - 1}–${prevCycles[prevCycles.length - 1]}`,
        amount: lastCycleAmt,
        whyNotIncluded: `Did not give in most recent previous cycle (${prevCycle - 1}–${prevCycle})`,
      });
      continue; // Skip adding to results
    }

    // Build cycle history summary
    const historyParts = prevCycles.map(c => `${c - 1}–${c}: ${fmt$(donor.cycles[c])}`);
    const avgPrev = prevCycles.length
      ? prevCycles.reduce((s, c) => s + donor.cycles[c], 0) / prevCycles.length
      : currentCycleAmt;

    const factors = [];
    if (prevCycles.length) {
      factors.push(`${prevCycles.length} previous cycle${prevCycles.length > 1 ? "s" : ""}: ${historyParts.join(", ")}`);
      factors.push(`Ask baseline (${baselineCycle - 1}–${baselineCycle}): ${fmt$(baselineAmt)} → target: ${fmt$(evidenceTarget)} (${historyBlend ? "history-weighted comparable benchmark" : `+5%${hasUplift ? " + comparable uplift" : ""}`}; rounded to nearest $250)`);
    } else {
      factors.push(`Current cycle donor: ${fmt$(currentCycleAmt)} given so far`);
      factors.push(`Base target: ${fmt$(evidenceTarget)} (${historyBlend ? "history-weighted comparable benchmark" : `+5%${hasUplift ? " + comparable uplift" : ""}`}; rounded to nearest $250)`);
    }

    if (primaryExclusionNote(targetProfile)) factors.push(primaryExclusionNote(targetProfile));
    if (targetProfile._entryBaseline) factors.push(`Incumbent baseline excludes giving through the first legislative primary (${targetProfile._entryBaseline.primaryDate}); full giving remains in history`);
    if (historyBlend) factors.push(`Recent peer benchmark: ${fmt$(compRef)} median of ${refGifts.length} recipients, using each recipient's latest funded eligible cycle in ${cycle-5}–${cycle-2}; donor ask capped at this benchmark before $250 rounding`);
    if (historyBlend) factors.push(`Limited incumbent history: ${historyCycles} completed eligible cycle${historyCycles === 1 ? "" : "s"}; ${Math.round(compWeight*100)}% comparable benchmark + ${Math.round((1-compWeight)*100)}% own eligible baseline (with 5% growth)`);
    else if (historyWeight !== null) factors.push("Limited incumbent history, but no eligible comparable giving for this donor; own post-primary baseline used");
    for (let i = 0; i < compProfiles.length; i++) if (primaryExclusionNote(compProfiles[i]))
      factors.push(`${comparables[i].name}: ${primaryExclusionNote(compProfiles[i])}`);
    if (compProfiles.some(p => p._entryBaseline)) factors.push("Comparable benchmarks exclude pre-entry-primary fundraising; reported historical contributions remain unchanged");
    leadershipFactors(factors, reference);
    // The ask is a blend; show the arithmetic rather than only its result.
    if (compWeight > 0) {
      const ownShare = baselineAmt * 1.05;
      const blended = ownShare * (1 - compWeight) + compRef * compWeight;
      const source = [refGift?.filer, refGift?.referenceCycle ? cycleName(refGift.referenceCycle) : null]
        .filter(Boolean).join(", ");
      factors.push(`Ask = ${Math.round((1 - compWeight) * 100)}% × ${fmt$(ownShare)} (own giving here, +5%)`
        + ` + ${Math.round(compWeight * 100)}% × ${fmt$(compRef)}${source ? ` (${source})` : ""}`
        + ` = ${fmt$(blended)} → ${fmt$(evidenceTarget)}`
        + (roundTarget(blended) === evidenceTarget ? " rounded" : " after capping and rounding"));
    }
    // Last, because it overrides the arithmetic above it.
    if (floored) factors.push(`More than last cycle: ${fmt$(lastEligible)} eligible giving in ${cycleName(prevCycle)} + 5%, rounded up to $250 → ${fmt$(target)}`);
    // How recent the giving behind the benchmark is, before quoting it.
    if (compGifts.length) factors.push(recencyNote(staleEvidence, cycle));
    // Say which giving the benchmark came from before quoting a number from it.
    if (!reference && targetSeat && targetSeat.margin_pts != null && compGifts.length) {
      factors.push(peer
        ? `Benchmark: ${peer.gifts.length} gift${peer.gifts.length === 1 ? "" : "s"} to ${peerDescription(peer)}`
          + ` (${seatDescription(targetSeat)}, ${targetSeat.year})`
        : `Benchmark: all eligible comparable giving — fewer than ${MIN_PEER_GIFTS} gifts to seats of similar closeness`);
    }

    // Show comparable uplift details
    if (hasUplift) {
      const upliftGifts = refGifts
        .filter(g => benchmarkAmount(g) > baselineAmt * 1.05)
        .sort((a, b) => b.amount - a.amount);
      const pct = Math.round(compWeight * 100);
      const nlTag = maxFromNonLeadership ? " — non-leadership benchmark" : "";
      const outlierNote = historyWeight !== null ? " — median recent peer giving" : (compRef < sortedAmts[0]) ? ` — top gift ${fmt$(sortedAmts[0])} discounted as outlier` : "";
      factors.push(`Comparable uplift (${pct}% weight, ref: ${fmt$(compRef)}${nlTag}${outlierNote}):`);
      upliftGifts.forEach(g => {
        const tag = g.isLeadership ? "" : " ★";
        const seat = g.seatBand === "unopposed" ? " [unopposed seat]" : g.marginPts != null ? ` [${g.marginPts.toFixed(1)} pt seat]` : "";
        factors.push(`  • ${g.filer}: ${fmt$(g.amount)}${g.referenceCycle ? ` (${g.referenceCycle-1}–${g.referenceCycle})` : ""}${seat}${tag}`);
      });
    } else if (refGifts.length > 0) {
      // Show top comparable gifts even without uplift for context
      const topGifts = [...refGifts].sort((a, b) => b.amount - a.amount).slice(0, 3);
      factors.push(`Top comparable gifts: ${topGifts.map(g => `${g.filer} (${fmt$(g.amount)})`).join(", ")}`);
    }

    if (currentCycleAmt > 0 && prevCycles.length > 0) {
      factors.push(`Already given this cycle: ${fmt$(currentCycleAmt)}`);
    }

    // Confidence based on consistency
    const consistency = prevCycles.length >= 3 ? "high" : prevCycles.length >= 1 ? "medium" : "low";

    results.push({
      donor: donor.name,
      donor_id: donor.donor_id || null,
      donor_key: key,
      prev_cycles: prevCycles.length,
      last_cycle_amt: lastCycleAmt,
      baseline_cycle_amt: baselineAmt, baseline_cycle: baselineCycle,
      history_cycles: historyCycles, comparable_weight: compWeight,
      benchmark_stale: staleEvidence, same_tier_ref: sameTierRef,
      avg_prev: Math.round(avgPrev * 100) / 100,
      comp_max: refGift?.amount || 0,
      comp_max_filers: refGifts.filter(g => benchmarkAmount(g) === compRef).map(g => g.filer),
      peer_benchmark: compRef,
      target, evidence_target: evidenceTarget,
      last_cycle_eligible: lastEligible, ask_floor: askFloor,
      current_cycle_amt: currentCycleAmt,
      remaining,
      consistency,
      history: historyParts,
      cycles: donor.cycles,          // {cycle: amount} to THIS committee
      comp_gifts: compGifts,         // gifts to comparables, with seat margins
      benchmark: peer ? { kind: peer.kind, window: peer.window, n: peer.gifts.length } : null,
      factors,
    });
  }

  // Asks under $500 are left out unless the donor gave last cycle: everyone
  // who did is asked to give more, however small the gift.
  const filtered = results.filter(r => r.evidence_target >= 500 || r.last_cycle_eligible > 0)
    .sort((a, b) => b.target - a.target);
  return { targets: filtered, notRecommended };
}

// ── Step 4b: Score new donors ─────────────────────────────────────────────
function scoreDonors(targetProfile, comparables, compProfiles, years, cycle, targetSeat) {
  // Build a set of leadership filer slugs for quick lookup
  const leadershipSlugs = new Set(
    comparables.filter(c => c.leadership_tier > 0).map(c => c.slug)
  );

  // Build: donor name → { compGifts, totalToComps, distinctComps, leadershipComps }
  const donorMap = new Map(); // lowered name → data

  compProfiles.forEach((profile, idx) => {
    const comp = comparables[idx];
    const donors = mergeDonorsByYear(askDonorsByYear(profile), years);

    donors.forEach(d => {
      const key = donorKey(d);
      if (!donorMap.has(key)) {
        donorMap.set(key, {
          name: donorDisplayName(d.name),
          donor_id: d.donor_id || null,
          compGifts: [],
          totalToComps: 0,
          distinctComps: 0,
          leadershipComps: 0,  // how many leadership members this donor gave to
        });
      }
      const entry = donorMap.get(key);
      entry.compGifts.push({
        filer: comp.name,
        amount: d.total,
        similarity: comp.similarity,
        isLeadership: (comp.leadership_tier || 0) > 0,
        benchmarkFactor: comp.benchmarkFactor ?? 1,
        seatBand: comp.seat?.band, marginPts: comp.seat?.margin_pts ?? null,
      });
      entry.totalToComps += d.total;
      entry.distinctComps = entry.compGifts.length;
      if ((comp.leadership_tier || 0) > 0) entry.leadershipComps++;
    });
  });

  // Get what each donor already gave to the target filer this cycle
  const targetDonors = mergeDonorsByYear(targetProfile.top_donors_by_year || {}, years);
  const targetDonorMap = new Map(targetDonors.map(d => [donorKey(d), d.total]));

  // Build set of ALL donors who have ever given to this filer (any year)
  const allTargetDonors = new Set();
  for (const donors of Object.values(targetProfile.top_donors_by_year || {})) {
    for (const d of donors) allTargetDonors.add(donorKey(d));
  }

  // Build set of candidate committee names for exclusion (not PACs or other types)
  const candidateFilerNames = new Set();
  if (filerIndex) {
    for (const f of filerIndex) {
      if (f.committee_type === "Candidate Committee") {
        candidateFilerNames.add(f.name.toLowerCase());
      }
    }
  }

  // Score each donor
  const results = [];
  const notRecommended = [];

  for (const [key, donor] of donorMap) {
    // Skip aggregated/non-individual entries
    if (isDonorExcluded(donor.name)) continue;

    // Skip candidate committees (e.g. "Kate Lieber for State Senate (20136)")
    const nameNoId = donor.name.replace(/\s*\(\d+\)\s*$/, "").toLowerCase();
    if (candidateFilerNames.has(key) || candidateFilerNames.has(nameNoId)) continue;

    // Skip donors who have ever given to this filer — they belong in Donor Targets
    if (allTargetDonors.has(key)) continue;

    const alreadyGiven = targetDonorMap.get(key) || 0;

    // ── EXCLUSION: donors who gave to only 1 person or donated ≤2 times ──
    const allYearGifts = _getAllYearGifts(key, compProfiles, comparables);
    const distinctYears = new Set(allYearGifts).size;
    const totalDonationInstances = allYearGifts.length; // times across all years × filers

    if (donor.distinctComps <= 1 && !donor.compGifts.some(g => comparables.some(c => c.name === g.filer && c.comparisonKind === "leadership-primary"))) {
      notRecommended.push({
        donor: donor.name,
        type: "Donor Prospect",
        lastGave: "",  // Could compute but not critical
        amount: donor.totalToComps,
        whyNotIncluded: "Gave only to one comparable filer across all cycles",
      });
      continue;
    }

    // Compute the target ask from comparable gifts.
    //
    // Which gifts count is decided by the seat, not by a multiplier: when this
    // donor has given to enough candidates in seats about as close as this one,
    // only those gifts set the ask. That IS the competitiveness adjustment —
    // the number comes from giving in comparable races rather than from
    // scaling a safe-seat number up.
    const compAmounts = donor.compGifts.map(g => g.amount).sort((a, b) => a - b);
    const reference = leadershipReference(donor.compGifts, comparables);
    const peer = reference ? null : peerMarginGifts(donor.compGifts, targetSeat);
    const askAmounts = (reference?.gifts || (peer ? peer.gifts : donor.compGifts)).map(benchmarkAmount).sort((a, b) => a - b);
    const median = percentile(askAmounts, 0.5);
    const p75 = percentile(askAmounts, 0.75);

    // Target = upper-median (between median and 75th) capped by donor's own max
    const maxGift = Math.max(...compAmounts);
    const benchmarkMax = Math.max(...donor.compGifts.map(benchmarkAmount));
    let targetAsk = Math.min(Math.round(((median + p75) / 2) * 100) / 100, benchmarkMax);

    const firstGiving = firstGivingBenchmark(key, compProfiles, comparables, cycle, targetSeat);
    // A new relationship should not start at an established donor's ask.
    // Annual aggregates cannot identify a single first gift: label that limit.
    targetAsk = Math.round(Math.min(targetAsk * 0.5, firstGiving.amount || targetAsk * 0.5) * 100) / 100;
    targetAsk = roundTarget(targetAsk);
    const remainingAsk = Math.max(0, targetAsk - alreadyGiven);

    // Comparable giving range
    const compMin = Math.min(...compAmounts);
    const compMax = maxGift;

    // ── Explainable score components ──────────────────────────────────
    let score = 0;
    const factors = [];

    factors.push(`First-time ask: ${fmt$(targetAsk)} — capped at 50% of the established-giving benchmark before rounding to the nearest $250`);
    if (firstGiving.n) factors.push(firstGiving.actual
      ? `Median first observed cash contribution to ${firstGiving.n} comparable recipients: ${fmt$(firstGiving.rawAmount ?? firstGiving.amount)}`
      : `Median earliest observed annual giving to ${firstGiving.n} comparable recipients: ${fmt$(firstGiving.rawAmount ?? firstGiving.amount)}; annual totals are a proxy, not individual first gifts`);

    for (let i = 0; i < compProfiles.length; i++) if (primaryExclusionNote(compProfiles[i]))
      factors.push(`${comparables[i].name}: ${primaryExclusionNote(compProfiles[i])}`);
    if (compProfiles.some(p => p._entryBaseline)) factors.push("Comparable benchmarks exclude pre-entry-primary fundraising; reported historical contributions remain unchanged");
    leadershipFactors(factors, reference);
    // Show what the ask was measured against, so the number is traceable to
    // real gifts rather than to a rule.
    if (peer) {
      factors.push(`Ask set by ${peer.gifts.length} gifts to ${peerDescription(peer)}`
        + ` (${seatDescription(targetSeat)}, ${targetSeat.year}) — median ${fmt$(median)}`);
      [...peer.gifts].sort((a, b) => b.amount - a.amount).slice(0, 4)
        .forEach(g => factors.push(`  • ${peerGiftLabel(g)}`));
    } else if (!reference && targetSeat && targetSeat.margin_pts != null) {
      factors.push(`Ask set by all eligible comparable giving — under ${MIN_PEER_GIFTS} gifts to `
        + (targetSeat.band === "unopposed" ? "unopposed seats" : `seats within ${PEER_WINDOWS[PEER_WINDOWS.length - 1]} pts of this one`));
    }

    // Factor 1: Number of distinct comparable filers supported (0-35 pts)
    // STRONG preference for donors who gave to MULTIPLE candidates.
    const distinctPts = donor.distinctComps === 1
      ? 3
      : Math.min(donor.distinctComps * 7, 35);
    score += distinctPts;
    if (donor.distinctComps >= 3) {
      factors.push(`Gave to ${donor.distinctComps} similar candidates`);
    } else if (donor.distinctComps === 1) {
      factors.push(`Only gave to 1 comparable candidate`);
    }

    // Factor 2: Total amount to comparable filers (0-15 pts)
    const totalPts = Math.min(donor.totalToComps / 500, 15);
    score += totalPts;

    // Factor 3: Similarity-weighted giving (0-15 pts)
    const simWeighted = donor.compGifts.reduce((s, g) => s + g.amount * (g.similarity / 100), 0);
    const simPts = Math.min(simWeighted / 300, 15);
    score += simPts;

    // Factor 4: Gap between comparable giving and current giving (0-15 pts)
    const gap = targetAsk - alreadyGiven;
    const gapPts = gap > 0 ? Math.min(gap / 200, 15) : 0;
    score += gapPts;
    if (alreadyGiven > 0 && gap > 0) {
      factors.push(`Gave ${fmt$(alreadyGiven)} but target is ${fmt$(targetAsk)}`);
    } else if (alreadyGiven === 0) {
      factors.push(`Has not given to this filer yet`);
    }

    // Factor 5: Recency — reward current-cycle giving, penalize stale donors
    const mostRecentYear = allYearGifts.length ? Math.max(...allYearGifts) : 0;
    const currentYear = new Date().getFullYear();
    const yearsAgo = mostRecentYear ? (currentYear - mostRecentYear) : 99;

    if (yearsAgo <= 1) {
      score += 20;
      factors.push(`Active donor (last gave ${mostRecentYear})`);
    } else if (yearsAgo <= 3) {
      score += 10;
    } else if (yearsAgo > 5) {
      score -= 10;
      factors.push(`Last gave ${mostRecentYear} (${yearsAgo} years ago)`);
    }

    // Factor 6: Leadership donor bonus — gave to multiple leadership members
    if (donor.leadershipComps >= 2) {
      score += Math.min(donor.leadershipComps * 5, 20);
      factors.push(`Gave to ${donor.leadershipComps} leadership members`);
    }

    // Penalty: one-time donors (1 candidate, 1 year)
    if (donor.distinctComps === 1 && distinctYears <= 1) {
      score -= 5;
      factors.push(`One-time donor (1 candidate, 1 year)`);
    }

    // Compute distinct election cycles (2-year periods) from year-level data
    const giftCycles = new Set(allYearGifts.map(yr => yr % 2 === 0 ? yr : yr + 1));
    const numCycles = giftCycles.size;

    // Heavy penalty: single-cycle donors (all giving in one 2-year cycle)
    if (numCycles <= 1) {
      score -= 25;
      factors.push(`Single-cycle donor — all comparable giving in one election cycle`);
    }

    // Note how many cycles the donor has given in
    if (numCycles > 0) {
      const sortedCycles = [...giftCycles].sort((a, b) => a - b);
      const cycleLabels = sortedCycles.map(c => `${c - 1}–${c}`).join(", ");
      factors.push(`Active in ${numCycles} election cycle${numCycles !== 1 ? "s" : ""}: ${cycleLabels}`);
    }

    // Normalize to 0-100
    score = Math.max(0, Math.min(Math.round(score), 100));

    // Build explanation summary
    const topComps = donor.compGifts
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
    const whySummary = buildWhySummary(donor, alreadyGiven, targetAsk, topComps);

    results.push({
      donor: donor.name,
      donor_id: donor.donor_id || null,
      donor_key: key,
      score,
      already_given: alreadyGiven,
      target_ask: targetAsk,
      remaining_ask: remainingAsk,
      comp_min: compMin,
      comp_max: compMax,
      comp_max_filers: donor.compGifts.filter(g => g.amount === compMax).map(g => g.filer),
      comp_range: `${fmt$(compMin)}–${fmt$(compMax)}`,
      distinct_comps: donor.distinctComps,
      total_to_comps: donor.totalToComps,
      leadership_comps: donor.leadershipComps,
      comp_gifts: donor.compGifts,
      benchmark: peer ? { kind: peer.kind, window: peer.window, n: peer.gifts.length } : null,
      why_summary: whySummary,
      factors,
    });
  }

  // Filter out prospects with target ask below $1,000
  const filtered = results.filter(r => r.target_ask >= 500).sort((a, b) => b.score - a.score);
  return { prospects: filtered, notRecommended };
}

function mergeDonorsByYear(byYear, years) {
  const totalMap = new Map();
  const seen = new Map();
  years.forEach(yr => {
    (byYear[yr] || []).forEach(d => {
      const key = donorKey(d);
      totalMap.set(key, (totalMap.get(key) || 0) + d.total);
      if (!seen.has(key)) seen.set(key, d);
    });
  });
  return [...totalMap.entries()]
    .map(([key, total]) => ({ ...seen.get(key), donor_key: key, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

function buildWhySummary(donor, alreadyGiven, targetAsk, topComps) {
  const parts = [];
  if (topComps.length >= 2) {
    const names = topComps.slice(0, 3).map(g => g.filer);
    const amtRange = `${fmt$(Math.min(...topComps.map(g => g.amount)))}–${fmt$(Math.max(...topComps.map(g => g.amount)))}`;
    parts.push(`Gave ${amtRange} to ${names.length} similar filers (${names.join(", ")})`);
  } else if (topComps.length === 1) {
    parts.push(`Gave ${fmt$(topComps[0].amount)} to ${topComps[0].filer}`);
  }
  if (alreadyGiven > 0) {
    const gap = targetAsk - alreadyGiven;
    if (gap > 0) {
      parts.push(`Already gave ${fmt$(alreadyGiven)}; remaining ask: ${fmt$(gap)}`);
    } else {
      parts.push(`Already gave ${fmt$(alreadyGiven)} (at or above target)`);
    }
  } else {
    parts.push(`Has not contributed this cycle`);
  }
  return parts.join(". ") + ".";
}

// ── Step 6: Display results ───────────────────────────────────────────────
function displayResults(recommendations, repeatTargets, targetProfile, comparables, cycle, allNotRecommended,
                        targetSeat, seatContext) {
  hideStatus();

  const section = document.getElementById("results-section");
  section.hidden = false;

  document.getElementById("results-title").textContent =
    `Fundraising Plan for ${targetProfile.name} (${cycle - 1}–${cycle} Cycle)`;

  // Compute cycle contributions from timeline
  const { start, end } = cycleDateRange(cycle);
  const cycleContributions = (targetProfile.timeline || [])
    .filter(t => t.month >= start && t.month <= end)
    .reduce((s, t) => s + (t.contributions || 0), 0);

  // Summary cards. The targets are for the whole cycle, so the total can be
  // set against last cycle's; what is still to come sits under each.
  const repeatAsks = repeatTargets.reduce((s, r) => s + r.target, 0);
  const newAsks = recommendations.reduce((s, r) => s + r.target_ask, 0);
  const repeatRemaining = repeatTargets.reduce((s, r) => s + r.remaining, 0);
  const newRemaining = recommendations.reduce((s, r) => s + r.remaining_ask, 0);
  const goal = fundraisingTarget(repeatAsks + newAsks, lastCycleContributions(targetProfile, cycle));
  window._fundraisingTarget = goal;
  const last = goal.lastCycle;
  const summaryEl = document.getElementById("results-summary");
  summaryEl.innerHTML = `
    <div class="summary-card sc-muted"><span class="sc-label">Cycle Contributions <span class="sc-help" title="Total cash contributions received by this committee during the selected election cycle.">?</span></span><br><span class="sc-value">${fmt$(cycleContributions)}</span></div>
    <div class="summary-card"><span class="sc-label">Donor Target Total <span class="sc-help" title="Sum of this cycle's asks for existing donors who gave in the most recent previous cycle. Each ask is more than the donor's eligible giving last cycle.">?</span></span><br><span class="sc-value">${fmt$(repeatAsks)}</span><div class="sc-sub">${fmt$(repeatRemaining)} still to come</div></div>
    <div class="summary-card"><span class="sc-label">New Prospect Target <span class="sc-help" title="Sum of this cycle's asks for new donors identified from comparable filer giving patterns.">?</span></span><br><span class="sc-value">${fmt$(newAsks)}</span><div class="sc-sub">${fmt$(newRemaining)} still to come</div></div>
    <div class="summary-card"><span class="sc-label">Comparable Filers <span class="sc-help" title="Number of similar candidates used as benchmarks for donor targeting and prospect identification.">?</span></span><br><span class="sc-value">${fmtNum(comparables.length)}</span></div>
    <div class="summary-card"><span class="sc-label">Total Fundraising Target <span class="sc-help" title="This cycle's goal: every donor and prospect ask, and never less than last cycle's eligible contributions plus 5%, rounded up to $250. Giving in exceptionally high-spend primary contests is left out of last cycle, as it is from every ask. Any shortfall is shown as still to find.">?</span></span><br><span class="sc-value">${fmt$(goal.target)}</span>
      <div class="sc-sub">Last cycle (${cycleName(last.cycle)}): ${fmt$(last.eligible)}${last.excluded ? ` — ${fmt$(last.raised)} raised, ${fmt$(last.excluded)} in exceptional primary windows left out` : ""}</div>
      <div class="sc-sub">Donor &amp; prospect asks: ${fmt$(goal.asks)}${goal.gap ? ` · <strong>Still to find: ${fmt$(goal.gap)}</strong> (small-dollar, events, new donors)` : ""}</div></div>
    ${comparables.some(c => c.chosen) ? `<div class="summary-card"><span class="sc-label">Comparison committees</span><p>Chosen for this candidate: ${comparables.map(c => esc(c.name)).join(", ")}</p></div>`
      : leadershipPool(comparables) ? `<div class="summary-card"><span class="sc-label">Leadership references</span><p>Primary: ${comparables.filter(c => c.comparisonKind === "leadership-primary").map(c => esc(c.name)).join(", ") || "None available"}</p><p>Secondary: ${comparables.filter(c => c.comparisonKind === "leadership-secondary").map(c => `${esc(c.name)} (${fmt$(c.outlierEvidence?.amount)} in best prior completed cycle)`).join(", ") || "None detected"}</p></div>` : ""}
    ${comparables.some(c => c.comparisonKind === "leadership-chair") ? `<div class="summary-card"><span class="sc-label">Leadership and committee-chair peers</span><p>${comparables.map(c => esc(c.name)).join(", ")}</p><p>Same chamber and compatible seat margins.</p></div>` : ""}
    ${primaryExclusionNote(targetProfile) ? `<div class="summary-card"><span class="sc-label">Primary-campaign exclusions</span><p>${esc(primaryExclusionNote(targetProfile))}. Actual history remains visible; current-cycle giving still counts toward the target.</p></div>` : ""}
    ${targetProfile._entryBaseline ? `<div class="summary-card"><span class="sc-label">Incumbent ask baseline</span><p>Giving from ${esc(targetProfile._entryBaseline.start)} onward. First-primary fundraising is excluded from asks and lobbyist minimums; historical giving remains visible.</p></div>` : ""}
    ${seatBenchmarkCard(targetSeat, seatContext, cycleContributions)}
  `;

  // Update tab badges with counts
  document.querySelectorAll(".tab-btn[data-tab='tab-repeat'] .tab-badge").forEach(el => el.textContent = repeatTargets.length + recommendations.length);
  document.querySelectorAll(".tab-btn[data-tab='tab-prospects'] .tab-badge").forEach(el => el.textContent = recommendations.length);
  document.querySelectorAll(".tab-btn[data-tab='tab-not-recommended'] .tab-badge").forEach(el => el.textContent = (allNotRecommended || []).length);

  // Wire up tabs
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  // Store for filtering/sorting/export
  window._recommendations = recommendations;
  window._repeatTargets = repeatTargets;
  window._targetProfile = targetProfile;
  window._comparables = comparables;
  window._cycle = cycle;
  window._targetSeat = targetSeat || null;
  window._seatContext = seatContext || null;
  window._allNotRecommended = allNotRecommended || [];

  // Render repeat donors section
  renderRepeatDonors(allDonorTargets());

  // Render new donor recommendations table
  renderRecTable(recommendations);

  // Wire up search bars
  const repeatSearchEl = document.getElementById("repeat-search");
  const recSearchEl = document.getElementById("rec-search");
  repeatSearchEl.value = "";
  recSearchEl.value = "";
  repeatSearchEl.addEventListener("input", () => renderFilteredRepeat());
  recSearchEl.addEventListener("input", () => renderFilteredRec());

  // Render Not Recommended table
  window._notRecData = allNotRecommended || [];
  window._notRecSortCol = "amount";
  window._notRecSortDir = "desc";
  renderFilteredNotRec();

  // Wire up search for Not Recommended
  const notRecSearch = document.getElementById("not-rec-search");
  if (notRecSearch) {
    notRecSearch.value = "";
    notRecSearch.addEventListener("input", () => renderFilteredNotRec());
  }

  // Wire up sort headers for both tables (remove old listeners by re-cloning)
  function wireSortHeaders(tableId, sortColKey, sortDirKey, renderFn) {
    document.querySelectorAll(`#${tableId} th.sortable`).forEach(th => {
      const clone = th.cloneNode(true);
      th.parentNode.replaceChild(clone, th);
      clone.addEventListener("click", () => {
        const col = clone.dataset.col;
        const curDir = clone.classList.contains("sort-asc") ? "asc" : clone.classList.contains("sort-desc") ? "desc" : null;
        document.querySelectorAll(`#${tableId} th.sortable`).forEach(t => t.classList.remove("sort-asc", "sort-desc"));
        const newDir = curDir === "desc" ? "asc" : "desc";
        clone.classList.add("sort-" + newDir);
        window[sortColKey] = col;
        window[sortDirKey] = newDir;
        renderFn();
      });
    });
  }

  document.querySelectorAll(".tab-btn[data-tab='tab-lobbyist-plan'] .tab-badge").forEach(el => el.textContent = "…");
  window._lobbyPlanLoad = loadLobbyistPlan();

  wireSortHeaders("repeat-table", "_repeatSortCol", "_repeatSortDir", renderFilteredRepeat);
  wireSortHeaders("rec-table", "_sortCol", "_sortDir", renderFilteredRec);
  wireSortHeaders("not-rec-table", "_notRecSortCol", "_notRecSortDir", renderFilteredNotRec);

  // Wire up export (re-clone to avoid duplicate listeners)
  for (const id of ["export-csv", "export-xlsx", "export-repeat-csv", "export-repeat-xlsx", "export-full-csv", "export-full-xlsx",
                    "export-lobbyist-csv", "export-lobbyist-xlsx", "export-lobbyist-xlsx-2"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    const fmt = id.includes("csv") ? "csv" : "xlsx";
    const scope = id.includes("lobbyist") ? "lobbyist" : id.includes("repeat") ? "repeat" : id.includes("full") ? "full" : "new";
    clone.addEventListener("click", () => exportData(fmt, scope));
  }
}

/** "Similar-margin seats" card: what peers of this seat raised, and where
 *  this committee sits against them. Empty when the seat has no margin on
 *  record or too few peers to quote. */
function seatBenchmarkCard(targetSeat, ctx, cycleContributions) {
  if (!targetSeat) return "";
  if (!ctx) {
    return `<div class="summary-card sc-muted"><span class="sc-label">Seat</span><br>
      <span class="sc-value sc-small">${esc(targetSeat.label)}</span>
      <div class="sc-sub">${targetSeat.year || ""} general — too few comparable seats to benchmark</div></div>`;
  }
  const pct = ctx.median > 0 ? Math.round((cycleContributions / ctx.median) * 100) : null;
  const standing = pct == null ? ""
    : pct >= 100 ? `${pct}% of that median` : `${pct}% of that median — ${fmt$(ctx.median - cycleContributions)} behind`;
  return `<div class="summary-card"><span class="sc-label">${ctx.kind === "unopposed" ? "Unopposed-seat peers" : "Similar-margin seats"}
      <span class="sc-help" title="Comparable committees in ${peerDescription(ctx)}, and what they raised this cycle. Targets are benchmarked against giving in seats like these rather than scaled by a multiplier.">?</span></span><br>
    <span class="sc-value">${fmt$(ctx.median)}</span>
    <div class="sc-sub">${esc(targetSeat.label)} · median of ${ctx.n}
      ${ctx.leadershipOnly ? "leadership " : ""}${peerDescription(ctx)} · ${standing}</div></div>`;
}

// ── Lobbyist tiers ─────────────────────────────────────────────────────────
//
// The fundraising sheets rank lobbyists before they are called: the 2024 lobby
// list is worked Tier 1 → Tier 2 → Tier 3 → Tier 4. A tier is a claim about
// likelihood to give, and it rests on two observable things:
//
//   volume   — how many donors in this plan they carry, and how much those
//              donors are worth;
//   fit      — whether their donors give to candidates like this one at all
//              (the comparables are already filtered to the target's party and
//              office, so "gave to 9 comparables" means nine like-members).
//
const TIER_RULES = [
  { tier: 1, min: 70, label: "Tier 1" },
  { tier: 2, min: 45, label: "Tier 2" },
  { tier: 3, min: 20, label: "Tier 3" },
  { tier: 4, min: -Infinity, label: "Tier 4" },
];

/**
 * Score and tier one lobbyist group.
 *   rows        the plan rows filed under them
 * Returns { tier, label, score, donors, likeComps, likeTotal, toCandidate, why }.
 */
function lobbyistTier(rows) {
  const donors = rows.length;
  const likeFilers = new Set();
  let likeTotal = 0, toCandidate = 0, lifetime = 0;
  for (const r of rows) {
    for (const g of r.comp_gifts || []) {
      likeFilers.add(g.filer);
      likeTotal += g.amount || 0;
    }
    toCandidate += r.given || 0;
    lifetime += Object.values(r.cycles || {}).reduce((s, v) => s + v, 0);
  }
  const bookPts = Math.min(30, 6 * donors);
  const fitPts = Math.min(30, 2 * likeFilers.size);
  const sizePts = Math.min(20, likeTotal / 5000);
  const relationshipPts = (lifetime > 0 ? 15 : 0) + (toCandidate > 0 ? 5 : 0);
  const score = Math.round(bookPts + fitPts + sizePts + relationshipPts);
  const rule = TIER_RULES.find(t => score >= t.min);
  const why = [
    `${donors} donor${donors === 1 ? "" : "s"} in this plan`,
    `${likeFilers.size} like candidate${likeFilers.size === 1 ? "" : "s"} supported (${fmt$(likeTotal)})`,
    lifetime > 0 ? `${fmt$(lifetime)} to this committee to date` : "no prior gift to this committee",
  ];
  return {
    tier: rule.tier,
    label: rule.label,
    score, donors, likeComps: likeFilers.size, likeTotal, toCandidate, lifetime,
    why: why.join(" · "),
  };
}

function allDonorTargets() {
  return [...(window._repeatTargets || []), ...(window._recommendations || []).map(r => ({
    ...r, target: r.target_ask, current_cycle_amt: r.already_given, remaining: r.remaining_ask,
    last_cycle_amt: 0, prev_cycles: 0, consistency: "new", history: ["First-time prospect"], cycles: {},
  }))];
}

/**
 * What this committee raised last cycle, and how much of it counts toward the
 * floor. The raised figure is the monthly total the Cycle Contributions card
 * reads. Giving inside a reviewed exceptional primary campaign (or before the
 * first legislative primary) is left out, as it is from every ask baseline:
 * it is measured as the gap between the full per-donor history and the
 * adjusted one, year by year.
 */
function lastCycleContributions(profile, cycle) {
  const last = cycle - 2, years = [last - 1, last];
  const raised = (profile?.timeline || [])
    .filter(t => t.month >= `${years[0]}-01` && t.month <= `${years[1]}-12`)
    .reduce((s, t) => s + Number(t.contributions || 0), 0);
  const sum = rows => (rows || []).reduce((s, d) => s + Number(d.total || 0), 0);
  const excluded = profile?._askDonorsByYear
    ? years.reduce((s, y) => s + Math.max(0, sum(profile.top_donors_by_year?.[y]) - sum(profile._askDonorsByYear[y])), 0)
    : 0;
  const cents = n => Math.round(n * 100) / 100;
  return { cycle: last, raised: cents(raised), excluded: cents(excluded), eligible: cents(Math.max(0, raised - excluded)) };
}

/**
 * The cycle's fundraising target: every ask, and never less than last cycle's
 * eligible total plus 5% (rounded up to $250). A shortfall is shown as its own
 * line rather than spread across asks the donor evidence does not support; it
 * is what small-dollar giving, events and new donors have to cover.
 */
function fundraisingTarget(asks, lastCycle) {
  const floor = aboveLastCycle(lastCycle.eligible);
  const target = Math.max(asks, floor);
  return { asks, floor, target, gap: target - asks, lastCycle };
}

function renderRepeatDonors(repeatTargets) {
  const container = document.getElementById("repeat-donors-section");
  if (!container) return;

  // Show/hide container based on whether original data exists
  const allRepeat = allDonorTargets();
  if (!allRepeat.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  // Store the currently-rendered rows so detail toggles reference the right data
  window._renderedRepeat = repeatTargets;

  const tbody = document.getElementById("repeat-tbody");

  if (!repeatTargets.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#718096;padding:24px">No donors match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = repeatTargets.map((r, i) => {
    const consistencyBadge = r.consistency === "new"
      ? '<span class="consistency-badge">New</span>'
      : r.consistency === "high"
      ? '<span class="consistency-badge high">High</span>'
      : r.consistency === "medium"
      ? '<span class="consistency-badge medium">Med</span>'
      : '<span class="consistency-badge low">Low</span>';

    return `
    <tr class="repeat-row" data-idx="${i}">
      <td>${i + 1}</td>
      <td>${esc(r.donor)}</td>
      <td>${lobbyistCell(r)}</td>
      <td class="num">${r.prev_cycles}</td>
      <td class="num">${fmt$(r.last_cycle_amt)}</td>
      <td class="num"><strong>${fmt$(r.target)}</strong></td>
      <td class="num">${fmt$(r.current_cycle_amt)}</td>
      <td class="num">${fmt$(r.remaining)}</td>
      <td>${consistencyBadge}</td>
      <td>
        <div class="why-text">${r.history.join(", ")}</div>
        <button class="why-toggle repeat-detail-toggle" data-ridx="${i}">Show details ▸</button>
      </td>
    </tr>`;
  }).join("");

  // Wire up detail toggles
  tbody.querySelectorAll(".repeat-detail-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.ridx);
      toggleRepeatDetail(idx, btn);
    });
  });
}

function toggleRepeatDetail(idx, btn) {
  const existing = document.querySelector(`.repeat-detail-row[data-for="${idx}"]`);
  if (existing) {
    existing.remove();
    btn.textContent = "Show details ▸";
    return;
  }

  const r = (window._renderedRepeat || window._repeatTargets || [])[idx];
  if (!r) return;

  btn.textContent = "Hide details ▾";
  const tr = btn.closest("tr");
  const detailRow = document.createElement("tr");
  detailRow.className = "repeat-detail-row detail-row";
  detailRow.dataset.for = idx;

  detailRow.innerHTML = `<td colspan="10"><div class="detail-content">
    <h4>Target Calculation</h4>
    <ul style="margin:0 0 0 16px;font-size:0.83rem;color:#4a5568">
      ${r.factors.map(f => {
        const text = esc(f);
        if (text.startsWith("  •")) {
          return `<li style="margin-left:16px;list-style:none">${text.trim()}</li>`;
        }
        return `<li>${text}</li>`;
      }).join("")}
    </ul>
  </div></td>`;

  tr.after(detailRow);
}

// ── Search filtering ──────────────────────────────────────────────────────
function sortRows(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

function renderFilteredRepeat() {
  const q = (document.getElementById("repeat-search").value || "").trim().toLowerCase();
  let rows = allDonorTargets();
  if (q) rows = rows.filter(r => r.donor.toLowerCase().includes(q));

  const col = window._repeatSortCol || "target";
  const dir = window._repeatSortDir || "desc";
  rows = sortRows(rows, col, dir);

  renderRepeatDonors(rows);
}

function renderFilteredRec() {
  const q = (document.getElementById("rec-search").value || "").trim().toLowerCase();
  let rows = window._recommendations || [];
  if (q) rows = rows.filter(r => r.donor.toLowerCase().includes(q));

  const col = window._sortCol || "score";
  const dir = window._sortDir || "desc";
  rows = sortRows(rows, col, dir);

  renderRecTable(rows);
}

function renderFilteredNotRec() {
  const q = (document.getElementById("not-rec-search")?.value || "").trim().toLowerCase();
  let rows = window._notRecData || [];
  if (q) rows = rows.filter(r => r.donor.toLowerCase().includes(q) || r.type.toLowerCase().includes(q));

  const col = window._notRecSortCol || "amount";
  const dir = window._notRecSortDir || "desc";
  rows = sortRows(rows, col, dir);

  const tbody = document.getElementById("not-rec-tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#718096;padding:24px">No excluded donors.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td>${esc(r.donor)}</td>
    <td><span class="not-rec-type">${esc(r.type)}</span></td>
    <td>${esc(r.lastGave)}</td>
    <td class="num">${fmt$(r.amount)}</td>
    <td class="not-rec-reason">${esc(r.whyNotIncluded)}</td>
  </tr>`).join("");
}

function renderRecTable(rows) {
  // Store the currently-rendered rows so detail toggles reference the right data
  window._renderedRecs = rows;

  const tbody = document.getElementById("rec-tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#718096;padding:24px">No recommendations found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((r, i) => `
    <tr class="rec-row" data-idx="${i}">
      <td>${i + 1}</td>
      <td>${esc(r.donor)}</td>
      <td>${lobbyistCell(r)}</td>
      <td class="num">
        <div class="score-bar">
          <div class="score-bar-track"><div class="score-bar-fill" style="width:${r.score}%"></div></div>
          <span>${r.score}</span>
        </div>
      </td>
      <td class="num">${fmt$(r.already_given)}</td>
      <td class="num">${fmt$(r.target_ask)}</td>
      <td class="num">${fmt$(r.remaining_ask)}</td>
      <td class="num" style="font-size:0.8rem">${r.comp_range}${comparableMaxCitation(r)}</td>
      <td>
        <div class="why-text">${esc(r.why_summary)}</div>
        <button class="why-toggle" data-donor-idx="${i}">Show details ▸</button>
      </td>
    </tr>
  `).join("");

  // Attach detail toggle listeners
  tbody.querySelectorAll(".why-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.donorIdx);
      toggleDetail(idx, btn);
    });
  });
}

function toggleDetail(idx, btn) {
  const existing = document.querySelector(`.detail-row[data-for="${idx}"]`);
  if (existing) {
    existing.remove();
    btn.textContent = "Show details ▸";
    return;
  }

  const r = (window._renderedRecs || window._recommendations || [])[idx];
  if (!r) return;

  btn.textContent = "Hide details ▾";

  const tr = btn.closest("tr");
  const detailRow = document.createElement("tr");
  detailRow.className = "detail-row";
  detailRow.dataset.for = idx;

  const topGifts = r.comp_gifts.sort((a, b) => b.amount - a.amount).slice(0, 10);

  detailRow.innerHTML = `<td colspan="9"><div class="detail-content">
    <h4>Comparable Filer Gifts (${r.distinct_comps} filers, ${fmt$(r.total_to_comps)} total)</h4>
    ${topGifts.map(g => `
      <div class="comp-filer-row">
        <span class="comp-filer-name">${esc(g.filer)}</span>
        <span class="comp-filer-amt">${fmt$(g.amount)}</span>
      </div>
    `).join("")}
    <h4>Scoring Factors</h4>
    <ul style="margin:0 0 0 16px;font-size:0.83rem;color:#4a5568">
      ${r.factors.map(f => `<li>${esc(f)}</li>`).join("")}
      <li>Distinct comparable filers: ${r.distinct_comps}</li>
      <li>Total to comparables: ${fmt$(r.total_to_comps)}</li>
    </ul>
  </div></td>`;

  tr.after(detailRow);
}

// ── Lobbyist plan ─────────────────────────────────────────────────────────
// Groups every donor target and prospect under the lobbyist who handles that
// donor, the way the fundraising sheets are worked: one lobbyist, their
// clients, what each should be asked for. Attribution comes from the
// donor_lobbyists view (supabase/migrations/016_lobbyists.sql), reviewed at
// /admin/lobbyists.
let lobbyistsById = null;
let planControlsWired = false;

/** Which caucus this plan is for: "house|D" for a House Democrat. */
async function loadLobbyistPlan() {
  const status = document.getElementById("plan-status");
  window._lobbyAttr = null;
  window._lobbyAttrError = null;
  window._donorContacts = new Map();
  window._donorTypes = new Map();
  wirePlanControls();
  // Portrait acquisition is optional and must never delay attribution results.
  if (typeof LP !== "undefined") LP.load().then(() => renderLobbyistPlan());
  status.textContent = "Looking up lobbyists…";
  renderLobbyistPlan();
  const runCycle = window._cycle;
  const runFiler = window._targetProfile;
  try {
    if (!lobbyistsById) {
      lobbyistsById = new Map((await LOB.loadLobbyists()).map(l => [l.lobbyist_id, { ...l, name: String(l.name || "").trim().replace(/\s+/g, " ") }]));
    }
    const rows = planDonorRows()
      .flatMap(r => [...(window._planIdentityIds?.get(r.donor_key) || [r.donor_id])].map(id => ({ name: r.donor, donor_id: id, key: r.donor_key })));
    const { byKey, contacts, bookTypes, rejected } = await LOB.planAttribution(rows, lobbyistsById);
    // A newer run may have started while this one was loading.
    if (window._cycle !== runCycle || window._targetProfile !== runFiler) return;
    window._lobbyAttr = byKey;
    window._rejectedFirmIds = rejected;
    window._donorContacts = contacts;
    window._donorTypes = bookTypes;
    status.textContent = "";
  } catch (e) {
    console.warn("Lobbyist attribution unavailable:", e);
    window._lobbyAttrError = e.message;
    window._lobbyAttr = new Map();
    status.textContent = `Lobbyist attribution is unavailable (${e.message}). Donors are listed without lobbyists.`;
  }
  renderLobbyistPlan();
  renderFilteredRepeat();
  renderFilteredRec();
}

function wirePlanControls() {
  if (planControlsWired) return;
  planControlsWired = true;
  document.getElementById("plan-search").addEventListener("input", renderLobbyistPlan);
  document.getElementById("plan-show-unattributed").addEventListener("change", renderLobbyistPlan);
  document.getElementById("plan-include-suggested").addEventListener("change", () => {
    renderLobbyistPlan();
    renderFilteredRepeat();
    renderFilteredRec();
  });
}

/** Lobbyists for a donor row, primary first; unreviewed ones only if shown. */
function lobbyistsFor(row) {
  const list = window._lobbyAttr?.get(row.donor_key ?? row.key) || [];
  const includeSuggested = document.getElementById("plan-include-suggested")?.checked ?? true;
  return includeSuggested ? list : list.filter(a => a.status === "confirmed");
}

function lobbyistNames(row) {
  return lobbyistsFor(row).map(a => a.lobbyist.name + (a.status === "confirmed" ? "" : " (unreviewed)")).join("; ");
}

function lobbyistCell(row) {
  if (!window._lobbyAttr) return '<span class="lob-pending">…</span>';
  const list = lobbyistsFor(row);
  if (!list.length) return '<span class="lob-none">—</span>';
  const [p, ...rest] = list;
  const unreviewed = p.status === "confirmed" ? "" : ' <span class="lob-unreviewed" title="Suggested match, not yet reviewed">?</span>';
  const also = rest.length
    ? ` <span class="lob-also" title="${esc(rest.map(a => a.lobbyist.name).join(", "))}">+${rest.length}</span>` : "";
  return `${esc(p.lobbyist.name)}${unreviewed}${also}`;
}

function attributionText(a) {
  if (!a) return "";
  const how = (a.methods || []).map(m => LOB.describeMethod(m));
  const client = a.client_names?.length ? ` — client: ${a.client_names.join(", ")}` : "";
  return `${a.status === "confirmed" ? "Confirmed" : "Unreviewed"}: ${[...new Set(how)].join("; ")}${client}`;
}

// ORESTAR files every contributor under a category. The lobbyist call list is
// for organizations, so the people — including a candidate's own family — are
// kept off it by that category rather than by name. The ones who have given
// to this candidate are listed apart, under the call list (planIndividuals):
// they are asked directly, not through a lobbyist.
const PERSON_BOOK_TYPES = new Set([
  "Individual", "Candidate & Immediate Family", "Candidate's Immediate Family",
]);

function isOrganization(row) {
  const type = window._donorTypes?.get(row.donor_key);
  return !PERSON_BOOK_TYPES.has(type);
}

/** A member's primary donor belongs under the firm's lead. Only an
 * unambiguous recorded membership can promote a person to a firm. */
function owningFirm(lobbyist) { return LOB.owningFirm(lobbyist, lobbyistsById); }

function planDonorRows() {
  const donorRows = [
    ...(window._repeatTargets || []).map(r => ({
      donor: r.donor, donor_id: r.donor_id, donor_key: r.donor_key,
      type: "Donor Target", target: r.target, given: r.current_cycle_amt,
      remaining: r.remaining, last_cycle: (r.cycles ? r.cycles[window._cycle - 2] || 0 : r.last_cycle_amt || 0), comp_max_filers: r.comp_max_filers || [], comp_max: r.comp_max || 0,
      factors: r.factors || [], cycles: r.cycles || {}, comp_gifts: r.comp_gifts || [], benchmark: r.benchmark || null })),
    ...(window._recommendations || []).map(r => ({
      donor: r.donor, donor_id: r.donor_id, donor_key: r.donor_key,
      type: "New Prospect", target: r.target_ask, given: r.already_given,
      remaining: r.remaining_ask, last_cycle: 0, comp_max: r.comp_max, comp_max_filers: r.comp_max_filers || [],
      factors: r.factors || [], cycles: {}, comp_gifts: r.comp_gifts || [], benchmark: r.benchmark || null })),
  ];
  // Clients omitted from individual recommendations still contributed to the book.
  const cycle = window._cycle;
  const byYear = window._targetProfile?.top_donors_by_year || {};
  const seen = new Set(donorRows.map(r => r.donor_key));
  const prior = mergeDonorsByYear(byYear, [cycle - 3, cycle - 2]);
  const current = mergeDonorsByYear(byYear, [cycle - 1, cycle]);
  const priorByKey = new Map(prior.map(d => [d.donor_key, d.total]));
  const currentByKey = new Map(current.map(d => [d.donor_key, d.total]));
  for (const d of [...prior, ...current]) {
    if (seen.has(d.donor_key) || isDonorExcluded(d.name)) continue;
    if ((filerIndex || []).some(f => f.committee_type === "Candidate Committee"
      && f.name.toLowerCase() === d.name.replace(/\s*\(\d+\)\s*$/, "").toLowerCase())) continue;
    seen.add(d.donor_key);
    const last = priorByKey.get(d.donor_key) || 0, given = currentByKey.get(d.donor_key) || 0;
    donorRows.push({ donor: donorDisplayName(d.name), donor_id: d.donor_id, donor_key: d.donor_key,
      type: "Client history", target: 0, given, remaining: 0, last_cycle: last,
      cycles: { [cycle - 2]: last, [cycle]: given }, factors: [], comp_gifts: [],
      comp_max: 0, comp_max_filers: [], history_only: true });
  }
  const eligiblePrior = new Map(mergeDonorsByYear(askDonorsByYear(window._targetProfile), [cycle-3,cycle-2]).map(d => [d.donor_key,d.total]));
  return donorRows.map(r => ({ ...r, baseline_last_cycle: window._targetProfile?._askDonorsByYear
    ? eligiblePrior.get(r.donor_key) || 0 : r.last_cycle }));
}

function planGroups() {
  const donorRows = planDonorRows();
  const groups = new Map();
  const none = { lobbyist: null, rows: [] };
  for (const row of donorRows.filter(isOrganization)) {
    const list = lobbyistsFor(row);
    let groupLobbyist = list[0] ? owningFirm(list[0].lobbyist) : null;
    if (groupLobbyist && window._rejectedFirmIds?.get(row.donor_key)?.has(groupLobbyist.lobbyist_id))
      groupLobbyist = list[0].lobbyist;
    // People reachable through the firm the donor is filed under are already
    // on its row; "also" is for anyone else.
    const firm = list[0] ? firmContacts(groupLobbyist) : { primary: null, others: [] };
    const atFirm = new Set([firm.primary, ...firm.others].filter(Boolean).map(m => m.lobbyist_id));
    if (groupLobbyist) atFirm.add(groupLobbyist.lobbyist_id);
    const entry = { ...row, attribution: list[0] || null,
                    contacts: window._donorContacts?.get(row.donor_key) || [],
                    also: list.slice(1).filter(a => !atFirm.has(a.lobbyist.lobbyist_id)) };
    if (!list.length) { if (!row.history_only) none.rows.push(entry); continue; }
    const id = groupLobbyist.lobbyist_id;
    if (!groups.has(id)) groups.set(id, { lobbyist: groupLobbyist, rows: [] });
    groups.get(id).rows.push(entry);
  }
  const q = (document.getElementById("plan-search")?.value || "").trim().toLowerCase();
  let out = [...groups.values()];
  if (document.getElementById("plan-show-unattributed")?.checked !== false && none.rows.length) out.push(none);
  if (q) {
    out = out.map(g => {
      const l = g.lobbyist;
      const members = l ? [firmContacts(l).primary, ...firmContacts(l).others].filter(Boolean) : [];
      const lobHit = l && [l.name, l.firm, l.affiliation, l.email, ...members.map(m => m.name)]
        .join(" ").toLowerCase().includes(q);
      return lobHit || g.rows.some(r => r.donor.toLowerCase().includes(q)) ? g : { ...g, rows: [] };
    }).filter(g => g.rows.length);
  }
  for (const g of out) {
    g.rows.sort((a, b) => b.remaining - a.remaining || b.target - a.target);
    g.last_cycle = g.rows.reduce((s, r) => s + Number(r.last_cycle || 0), 0);
    g.donor_target = g.rows.reduce((s, r) => s + r.target, 0);
    // A hard historical floor must round up if nearest-$250 would undershoot.
    g.baseline_last_cycle = g.rows.reduce((s,r) => s+Number(r.baseline_last_cycle || 0),0);
    g.target = g.lobbyist ? Math.max(g.donor_target, Math.ceil(g.baseline_last_cycle / 250) * 250) : g.donor_target;
    g.additional_ask = g.target - g.donor_target;
    g.given = g.rows.reduce((s, r) => s + r.given, 0);
    g.remaining = g.lobbyist ? Math.max(0, g.target - g.given) : g.rows.reduce((s, r) => s + r.remaining, 0);
    g.target_reason = g.lobbyist ? `Lobbyist target: at least last cycle’s eligible baseline of ${fmt$(g.baseline_last_cycle)} across currently attributed clients. ${primaryExclusionNote(window._targetProfile)}${window._targetProfile?._entryBaseline ? ` Giving through ${window._targetProfile._entryBaseline.primaryDate} is excluded from the ask floor; Last Cycle shows actual giving.` : ""}`
      + (g.additional_ask ? ` Includes ${fmt$(g.additional_ask)} beyond individual client asks; client allocation remains open.` : "") : "";
    g.tier = lobbyistTier(g.rows);
  }
  // Tier, then the size of the ask — the order the lobby list is worked.
  // Donors with no lobbyist sit at the bottom.
  out.sort((a, b) => (!a.lobbyist - !b.lobbyist) || (a.tier.tier - b.tier.tier)
    || (b.remaining - a.remaining));
  return out;
}

/**
 * Individuals who have given to this candidate, for their own part of the
 * plan. New prospects who are people stay in New Donor Prospects: they have
 * not given here. Unknown categories count as organizations (isOrganization),
 * so nobody is moved here on a guess.
 */
function planIndividuals() {
  if (!window._donorTypes) return [];
  const q = (document.getElementById("plan-search")?.value || "").trim().toLowerCase();
  return planDonorRows()
    .filter(r => r.type !== "New Prospect" && !isOrganization(r))
    .filter(r => !q || r.donor.toLowerCase().includes(q))
    .map(r => ({ ...r, category: window._donorTypes.get(r.donor_key) }))
    .sort((a, b) => b.target - a.target || b.last_cycle - a.last_cycle || b.given - a.given);
}

function lobbyistContact(l) {
  return [l.affiliation || l.firm, l.email, l.phone].filter(Boolean).join(" · ");
}

/** Who to call at a firm: its primary contact first, then the other members.
 *  Set at /admin/lobbyists (seeded from the fundraising sheets). A firm with
 *  its own email or phone typed in by an admin uses that for the primary. */
function firmContacts(l) {
  if (l.kind !== "firm") return { primary: null, others: [] };
  const get = id => lobbyistsById?.get(id);
  const primary = get(l.firm_primary_id) || (l.email || l.phone ? null : get((l.firm_member_ids || [])[0])) || null;
  const others = (l.firm_member_ids || []).map(get)
    .filter(m => m && (!primary || m.lobbyist_id !== primary.lobbyist_id));
  return { primary, others };
}

function contactLine(m) {
  return [m.email, m.phone].filter(Boolean).join(" · ");
}

function portraitPerson(l) {
  if (!l) return null;
  return l.kind === "firm" ? lobbyistsById?.get(l.firm_primary_id) || null : l;
}
function portraitMarkup(person, small = false) {
  const photo = typeof LP !== "undefined" ? LP.get(person) : null;
  if (!photo) return small ? "" : '<span class="plan-photo-empty">Photo unavailable</span>';
  return `<img class="${small ? "plan-member-portrait" : "plan-portrait"}" src="${esc(photo.path)}" alt="${esc(person.name)}" loading="lazy" onerror="this.replaceWith(document.createTextNode('Photo unavailable'))">`;
}
function lobbyistHeader(l) {
  return `<div class="plan-person">${portraitMarkup(portraitPerson(l))}<div>${lobbyistHeaderText(l)}</div></div>`;
}
function lobbyistHeaderText(l) {
  if (l.kind !== "firm") {
    return `<div class="plan-lobbyist">${esc(l.name)}</div>
            <div class="plan-contact">${esc(lobbyistContact(l))}</div>`;
  }
  const primary = portraitPerson(l);
  const others = (l.firm_member_ids || []).map(id => lobbyistsById?.get(id))
    .filter(m => m && m.lobbyist_id !== primary?.lobbyist_id);
  const contact = contactLine(l) || (primary ? contactLine(primary) : "");
  const lead = contact ? `<div class="plan-contact">${esc(contact)}</div>` : "";
  const item = m => `<li>${portraitMarkup(m, true)}${esc(m.name)}${contactLine(m) ? ` <span>${esc(contactLine(m))}</span>` : ""}</li>`;
  const more = others.length
    ? `<details class="plan-members" open><summary>${others.length} other${others.length === 1 ? "" : "s"} at the firm</summary>
         <ul>${others.map(item).join("")}</ul></details>`
    : "";
  const title = primary
    ? `<div class="plan-lobbyist">${esc(primary.name)}</div><div class="plan-contact">${esc(l.name)}</div>`
    : `<div class="plan-lobbyist">${esc(l.name)} <span class="plan-firm">firm</span></div>`;
  return `${title}${lead}${more}`;
}

/** The tier chip in front of a lobbyist: Tier 1 … Tier 4. */
function tierChip(t) {
  if (!t) return "";
  const cls = `is-t${t.tier}`;
  return `<span class="plan-tier ${cls}" title="${esc(t.why)}">${esc(t.label)}</span>`;
}

function contactsCell(r) {
  if (!r.contacts?.length) return "";
  const line = c => [c.name + (c.title ? ` (${c.title})` : ""), c.email, c.phone].filter(Boolean).join(" · ");
  const [first, ...rest] = r.contacts;
  const more = rest.length
    ? `<div class="plan-also">also: ${esc(rest.map(c => c.name).join(", "))}</div>` : "";
  return `<div class="plan-donor-contact">${first.is_primary ? "★ " : ""}${esc(line(first))}</div>${more}`;
}

function comparableMaxCitation(row) {
  const names = [...new Set(row.comp_max_filers || [])];
  return names.map(name => {
    const filer = (window._comparables || []).find(f => f.name === name);
    return `<div class="plan-comp-source">${esc(name)}${filer?.filer_id ? ` (filer ${esc(filer.filer_id)})` : ""}</div>`;
  }).join("");
}

function renderLobbyistPlan() {
  const tbody = document.getElementById("plan-tbody");
  if (!tbody) return;
  if (!window._lobbyAttr) {
    tbody.innerHTML = '<tr><td colspan="9" class="plan-empty">Loading lobbyist attribution…</td></tr>';
    return;
  }
  const groups = planGroups();
  const people = planIndividuals();
  const withLobbyist = groups.filter(g => g.lobbyist).length;
  document.querySelectorAll(".tab-btn[data-tab='tab-lobbyist-plan'] .tab-badge").forEach(el => el.textContent = withLobbyist);
  if (!groups.length && !people.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="plan-empty">No donors match.</td></tr>';
    return;
  }
  tbody.innerHTML = groups.map((g, groupIndex) => {
    const l = g.lobbyist;
    const head = l
      ? lobbyistHeader(l)
      : `<div class="plan-lobbyist plan-none">No lobbyist on file</div>
         <div class="plan-contact">Assign these at <a href="/admin/lobbyists">/admin/lobbyists</a></div>`;
    const header = `<tr class="plan-group">
      <td class="plan-tier-cell">${l ? tierChip(g.tier) : ""}</td>
      <td>${head}</td>
      <td class="plan-count"><button type="button" class="plan-group-toggle" data-group="${groupIndex}" aria-expanded="true">▾ ${g.rows.length} donor${g.rows.length === 1 ? "" : "s"}</button></td>
      <td class="num">${fmt$(g.target)}</td>
      <td class="num">${fmt$(g.given)}</td>
      <td class="num">${fmt$(g.remaining)}</td>
      <td class="num">${fmt$(g.last_cycle)}</td><td></td>
      <td class="plan-why">${l ? esc(g.tier.why) : ""}<div>${esc(g.target_reason || "")}</div></td>
    </tr>`;
    const rows = g.rows.map(r => `<tr class="plan-donor" data-group="${groupIndex}">
      <td></td>
      <td>${esc(r.donor)}${contactsCell(r)}${r.also.length ? `<div class="plan-also">also: ${esc(r.also.map(a => a.lobbyist.name).join(", "))}</div>` : ""}</td>
      <td><span class="plan-type ${r.type === "Donor Target" ? "is-target" : "is-prospect"}">${r.type === "Donor Target" ? "Target" : r.type === "Client history" ? "History" : "Prospect"}</span></td>
      <td class="num"><strong>${fmt$(r.target)}</strong></td>
      <td class="num">${fmt$(r.given)}</td>
      <td class="num">${fmt$(r.remaining)}</td>
      <td class="num">${r.last_cycle === null ? "—" : fmt$(r.last_cycle)}</td>
      <td class="num">${r.comp_max ? fmt$(r.comp_max) : "—"}${comparableMaxCitation(r)}</td>
      <td class="plan-attr">${r.attribution
        ? `${r.attribution.status === "confirmed" ? "" : '<span class="lob-unreviewed" title="Suggested match, not yet reviewed">?</span> '}${esc(attributionText(r.attribution))}`
        : ""}</td>
    </tr>`).join("");
    return header + rows;
  }).join("") + individualsSection(people);
  tbody.querySelectorAll(".plan-group-toggle").forEach(button => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    button.textContent = (open ? "▾" : "▸") + button.textContent.slice(1);
    tbody.querySelectorAll(`.plan-donor[data-group="${button.dataset.group}"]`).forEach(row => { row.hidden = !open; });
  }));
}

/** The people who have given here, under the call list and collapsed: a long
 *  list of small individual gifts should not push the lobbyists off screen. */
const PLAN_INDIVIDUALS = "individuals";
function individualsSection(people) {
  if (!people.length) return "";
  const sum = key => people.reduce((s, r) => s + Number(r[key] || 0), 0);
  const header = `<tr class="plan-group plan-individuals">
      <td class="plan-tier-cell"></td>
      <td><div class="plan-lobbyist">Individual donors</div>
        <div class="plan-contact">People who have given to this candidate. Ask them directly, not through a lobbyist.</div></td>
      <td class="plan-count"><button type="button" class="plan-group-toggle" data-group="${PLAN_INDIVIDUALS}" aria-expanded="false">▸ ${people.length} ${people.length === 1 ? "person" : "people"}</button></td>
      <td class="num">${fmt$(sum("target"))}</td>
      <td class="num">${fmt$(sum("given"))}</td>
      <td class="num">${fmt$(sum("remaining"))}</td>
      <td class="num">${fmt$(sum("last_cycle"))}</td><td></td>
      <td class="plan-why">ORESTAR files these contributors as individuals or as the candidate's family. Each ask is more than their eligible giving last cycle; no ask means no eligible giving last cycle (none, or only inside an exceptional primary window).</td>
    </tr>`;
  const rows = people.map(r => `<tr class="plan-donor" data-group="${PLAN_INDIVIDUALS}" hidden>
      <td></td>
      <td>${esc(r.donor)}${r.category && r.category !== "Individual" ? `<div class="plan-also">${esc(r.category)}</div>` : ""}</td>
      <td><span class="plan-type ${r.target ? "is-target" : "is-prospect"}">${r.target ? "Target" : "History"}</span></td>
      <td class="num"><strong>${r.target ? fmt$(r.target) : "—"}</strong></td>
      <td class="num">${fmt$(r.given)}</td>
      <td class="num">${fmt$(r.remaining)}</td>
      <td class="num">${fmt$(r.last_cycle)}</td>
      <td class="num">${r.comp_max ? fmt$(r.comp_max) : "—"}</td>
      <td class="plan-attr"></td>
    </tr>`).join("");
  return header + rows;
}

// ── Lobbyist plan export ───────────────────────────────────────────────────
// The workbook is the lobby list, not a pivot source. Sheet 1 is one entry per
// lobbyist — tier, who to call, what to ask — with their donors beneath, the
// candidate's own giving history beside it, and the same donors' giving to
// comparable candidates beside that, which is the evidence for the ask. The
// flat table people want for a pivot is still there, on the Donors sheet.

/** Contact details for a lobbyist row: the firm's primary leads. */
function planContact(l) {
  if (!l) return { name: "", email: "", phone: "", others: "" };
  if (l.kind === "firm") {
    const { primary, others } = firmContacts(l);
    return {
      name: primary ? primary.name : l.name,
      email: l.email || primary?.email || "",
      phone: l.phone || primary?.phone || "",
      others: others.map(m => [m.name, m.email, m.phone].filter(Boolean).join(" · ")).join("; "),
    };
  }
  return { name: l.name, email: l.email || "", phone: l.phone || "", others: "" };
}

/** The donor's own primary contact, when an admin has recorded one. */
function donorContact(r) {
  const c = (r.contacts || [])[0];
  return c ? { name: c.name + (c.title ? ` (${c.title})` : ""), email: c.email || "", phone: c.phone || "" }
           : { name: "", email: "", phone: "" };
}

// Sentinel for "the candidate this plan is for", used where a column holds a
// filer name. No committee can be named this.
const PLAN_SELF = "__plan_self__";
const REMAINING = "Remaining";

/** What this donor gave `filer` in `cy`, from the all-years comparable index. */
function givenInCycle(key, filerName, cy, row) {
  if (filerName === PLAN_SELF) return (row?.cycles || {})[cy] || 0;
  const m = window._compCycles?.get(key)?.get(filerName);
  return m ? (m[cy] || 0) : 0;
}

/**
 * Which cycles and which comparable candidates get columns: the three most
 * recent cycles, and the comparables this plan's donors actually gave the most
 * to in the earlier ones — the tracker names five, so do we.
 */
// ── Non-target donors ─────────────────────────────────────────────────────
// A lobbyist's comparable columns count their whole book: every client filed
// under them, not only the donors asked for money here. Clients not in this
// plan go into one "Non-target donors" row under the lobbyist, and are listed
// one by one on their own sheet.
const NON_TARGET = "Non-target donors";

/**
 * Attaches g.nonTarget = { clients, byCell } to each lobbyist group, where
 * byCell maps "comparable|cycle" to dollars. A client is filed under the
 * lobbyist the plan itself would choose: its strongest link as
 * planAttribution ranks them, rolled up to the owning firm. Anyone already in
 * this plan, under any lobbyist or none, is not a non-target donor.
 */
async function loadNonTargetClients(groups, cycle) {
  const named = new Map(groups.filter(g => g.lobbyist).map(g => [g.lobbyist.lobbyist_id, g]));
  for (const g of named.values()) delete g.nonTarget;
  if (!named.size || !lobbyistsById || typeof LOB === "undefined") return [];
  const groupOf = l => (owningFirm(l) || l).lobbyist_id;
  const planLobbyists = [...lobbyistsById.values()].filter(l => named.has(groupOf(l))).map(l => l.lobbyist_id);
  const seeds = await LOB.fetchIn("donor_lobbyists", "donor_id", "lobbyist_id", planLobbyists);
  const links = await LOB.fetchIn("donor_lobbyists", "donor_id,lobbyist_id,status,is_primary,score",
                                  "donor_id", seeds.map(s => s.donor_id));
  const includeSuggested = document.getElementById("plan-include-suggested")?.checked ?? true;
  const byDonor = new Map();
  for (const a of links) {
    const lobbyist = lobbyistsById.get(a.lobbyist_id);
    if (!lobbyist || (!includeSuggested && a.status !== "confirmed")) continue;
    if (!byDonor.has(a.donor_id)) byDonor.set(a.donor_id, []);
    byDonor.get(a.donor_id).push({ lobbyist, status: a.status, is_primary: !!a.is_primary, score: Number(a.score || 0) });
  }
  const inPlanIds = new Set(), inPlanKeys = new Set();
  for (const r of planDonorRows()) {
    inPlanKeys.add(r.donor_key);
    for (const id of window._planIdentityIds?.get(r.donor_key) || [r.donor_id]) inPlanIds.add(id);
  }
  const { cycles, comps } = planCycleColumns(groups, cycle);
  const found = new Map();                         // "group|key" → client, so a merged donor counts once
  for (const [donorId, list] of byDonor) {
    LOB.sortAttribution(list);
    const g = named.get(groupOf(list[0].lobbyist));
    const key = donorKey({ donor_id: donorId });
    if (!g || inPlanIds.has(donorId) || inPlanKeys.has(key) || found.has(`${g.lobbyist.lobbyist_id}|${key}`)) continue;
    const given = window._compCycles?.get(key);
    const byCell = new Map();
    let total = 0;
    for (const c of comps) for (const cy of cycles) {
      const v = given?.get(c.filer)?.[cy] || 0;
      if (v) { byCell.set(`${c.filer}|${cy}`, v); total += v; }
    }
    if (total > 0) found.set(`${g.lobbyist.lobbyist_id}|${key}`, { group: g, donor_id: donorId, key, byCell, total });
  }
  const clients = [...found.values()];
  const names = new Map((await LOB.fetchIn("donors", "donor_id,display_name", "donor_id", clients.map(c => c.donor_id)))
    .map(d => [d.donor_id, d.display_name]));
  const kept = [];
  for (const c of clients) {
    const raw = names.get(c.donor_id) || c.donor_id;
    if (isDonorExcluded(raw) || isCandidateCommittee(c.key, raw)) continue;
    c.name = donorDisplayName(raw);
    kept.push(c);
    const nt = (c.group.nonTarget ||= { clients: [], byCell: new Map() });
    nt.clients.push(c);
    for (const [cell, v] of c.byCell) nt.byCell.set(cell, (nt.byCell.get(cell) || 0) + v);
  }
  for (const g of named.values()) g.nonTarget?.clients.sort((a, b) => b.total - a.total);
  return kept;
}

/** The Non-target donors sheet: who is in each lobbyist's Non-target row. */
function nonTargetSheetRows(groups, cycle) {
  const { cycles, comps } = planCycleColumns(groups, cycle);
  return groups.filter(g => g.nonTarget?.clients.length).flatMap(g => g.nonTarget.clients.map(c => {
    const row = { "Lobbyist": g.lobbyist.name, "Non-target donor": c.name, "Total to comparables": Math.round(c.total) };
    for (const cy of cycles) for (const comp of comps) {
      row[`${comp.filer} ${cycleName(cy)}`] = Math.round(c.byCell.get(`${comp.filer}|${cy}`) || 0);
    }
    return row;
  }));
}

/** What is still to come from one row, never below $0. */
function rowRemaining(r) {
  return Math.max(0, r.remaining ?? ((r.target || 0) - (r.given || 0)));
}

// ── The fundraising ladder ────────────────────────────────────────────────
//
// The export's earlier-cycle columns exist to answer "what does this donor
// give someone like my candidate?" Filling all five with the biggest
// recipients answers a different question — it lists the five biggest
// fundraisers, which is the same handful of leaders on every plan. The
// columns span the ladder instead: one committee per rung, so a back-bench
// plan shows what a donor gives a back-bencher next to what it gives a
// Speaker, and the ask can be read against the right one.
//
// The rungs are built from what this dataset actually records — floor
// leadership, how close the seat is, what the committee raises per cycle and
// how long it has been raising. **Committee chairmanships and legislative
// tenure are not in ORESTAR**, so a long-serving chair in a safe seat reads
// as mid-ladder here rather than as the senior fundraiser they are. Pin a
// committee where it belongs with an `archetype` admin tag on its slug
// (value 1–5); a pin always wins.
const FUNDRAISER_LEVELS = [
  { level: 1, label: "Caucus leadership",   blurb: "Speaker, Senate President or Majority Leader" },
  { level: 2, label: "Senior safe-seat",    blurb: "top of the pack, no election pressure, several cycles in" },
  { level: 3, label: "Established mid",     blurb: "middle of the pack in a seat that is not close" },
  { level: 4, label: "Competitive seat",    blurb: "a close last general — raising under election pressure" },
  { level: 5, label: "Back bench",          blurb: "no leadership, no close race, least raised" },
];
const RUNG_BY_LEVEL = new Map(FUNDRAISER_LEVELS.map(r => [r.level, r]));

/** The election year a committee is registered for, 0 when unknown. */
function committeeElectionYear(filer) {
  const m = /(\d{4})/.exec(filer.election || "");
  return m ? Number(m[1]) : 0;
}

/**
 * The ladder for a chamber and party: every committee still standing for
 * election, placed on a rung.
 *
 * Drawn from the whole chamber rather than from the fifty comparables,
 * because the comparables are deliberately *alike* — a back-bencher's
 * comparables hold no Speaker, so a plan built from them could never show
 * what a donor gives a Speaker, which is exactly the comparison the columns
 * exist to make.
 *
 * "How much they raise" is career total, which is the only per-committee
 * figure the index carries. It blends how big a fundraiser someone is with
 * how long they have been one — which is what the rungs describe, a
 * long-serving chair sitting above a first-term member in the same kind of
 * seat. Where it reads someone wrong, pin them with an `archetype` tag.
 */
function fundraiserLadder(targetFiler, cycle) {
  const office = targetFiler?.office, party = (targetFiler?.party || "").trim();
  const out = new Map();
  if (!office || !party || !filerIndex) return out;
  const active = filerIndex.filter(f =>
    f.committee_type === "Candidate Committee"
    && f.office === office && (f.party || "").trim() === party
    && (f.total_in || 0) >= LIST_MIN_RAISED
    && committeeElectionYear(f) >= cycle - 2
    && f.slug !== targetFiler.slug          // the plan already has its own column
    && !(adminTags[f.slug] || []).some(t => t.tag === "exclude"));
  const totals = active.map(f => f.total_in || 0).sort((a, b) => a - b);
  const high = percentile(totals, 2 / 3), low = percentile(totals, 1 / 3);
  for (const f of active) {
    const pin = Number((adminTags[f.slug] || []).find(t => t.tag === "archetype")?.value);
    const tier = f.leadership_tier || 0;
    const seat = seatCompetitiveness(f);
    const close = !!seat && (seat.band === "competitive" || seat.band === "lean");
    const raised = f.total_in || 0;
    out.set(f.name, {
      slug: f.slug, name: f.name, tier, seat, raised,
      pinned: RUNG_BY_LEVEL.has(pin),
      level: RUNG_BY_LEVEL.has(pin) ? pin
        : (tier === 1 || tier === 2) ? 1
        : close ? 4
        : raised >= high ? 2
        : (raised < low && tier === 0) ? 5
        : 3,
    });
  }
  return out;
}

/**
 * The committees worth loading donor history for: the top few raisers on each
 * rung, so the column for that rung can be filled by whichever of them this
 * plan's donors actually support.
 */
function ladderCandidates(ladder, perRung = 3) {
  const slugs = [];
  for (const rung of FUNDRAISER_LEVELS) {
    [...ladder.values()].filter(s => s.level === rung.level)
      .sort((a, b) => b.raised - a.raised)
      .slice(0, perRung)
      .forEach(s => slugs.push(s.slug));
  }
  return slugs;
}

/** Fold extra committees' per-year donor tables into the comparable index. */
function indexLadderGiving(byYear, ladder) {
  const bySlug = new Map([...ladder.values()].map(s => [s.slug, s.name]));
  for (const [slug, years] of byYear) {
    const filer = bySlug.get(slug);
    if (!filer) continue;
    for (const [yrStr, donors] of Object.entries(years || {})) {
      const cy = yearToCycle(parseInt(yrStr, 10));
      for (const d of donors) {
        const key = donorKey(d);
        if (!window._compCycles.has(key)) window._compCycles.set(key, new Map());
        const perFiler = window._compCycles.get(key);
        if (!perFiler.has(filer)) perFiler.set(filer, {});
        const byCycle = perFiler.get(filer);
        byCycle[cy] = (byCycle[cy] || 0) + d.total;
      }
    }
  }
}

/**
 * Which cycles and which comparable candidates get columns: the three most
 * recent cycles, and one comparable per rung of the fundraising ladder —
 * within a rung, the committee this plan's donors gave the most to. A rung
 * with no comparable gives its slot back to the next-largest recipient, so
 * the sheet always carries five columns of evidence.
 */
function planCycleColumns(groups, cycle) {
  const cycles = [cycle, cycle - 2, cycle - 4];
  // Comparison committees chosen by hand (CHOSEN_COMPARABLES) are the columns,
  // all of them and in the order chosen. The chamber ladder below never could
  // show them: Ben Bowman's six include three senators, and his ladder is the
  // House's.
  const chosen = (window._comparables || []).filter(c => c.chosen);
  if (chosen.length) return { cycles, comps: chosen.map(c => ({ filer: c.name, level: null, rung: "Chosen comparison" })) };
  const totals = new Map();
  for (const g of groups) {
    for (const r of g.rows) {
      const perFiler = window._compCycles?.get(r.donor_key);
      if (!perFiler) continue;
      for (const [filer, byCycle] of perFiler) {
        const sum = cycles.slice(1).reduce((s, c) => s + (byCycle[c] || 0), 0);
        if (sum) totals.set(filer, (totals.get(filer) || 0) + sum);
      }
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const ladder = window._fundraiserLevels || new Map();
  const comps = [], taken = new Set();
  for (const rung of FUNDRAISER_LEVELS) {
    // Within a rung, the committee this plan's donors actually support, so
    // the column holds evidence rather than blanks. Nobody gave any of them
    // anything → the biggest raiser on the rung, and the column stays empty.
    const pick = [...ladder.values()]
      .filter(s => s.level === rung.level && !taken.has(s.name))
      .sort((a, b) => (totals.get(b.name) || 0) - (totals.get(a.name) || 0) || b.raised - a.raised)[0];
    if (!pick) continue;
    taken.add(pick.name);
    comps.push({ filer: pick.name, level: rung.level, rung: rung.label });
  }
  for (const filer of ranked) {                 // fill empty rungs with the next best
    if (comps.length >= FUNDRAISER_LEVELS.length) break;
    if (taken.has(filer)) continue;
    taken.add(filer);
    const rung = RUNG_BY_LEVEL.get(ladder.get(filer)?.level);
    comps.push({ filer, level: ladder.get(filer)?.level ?? null, rung: rung ? rung.label : "Comparable" });
  }
  comps.sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
  return { cycles, comps };
}

/** The unallocated balance belongs to the lobbyist, not a particular donor. */
function planExportRows(g) {
  if (!g.additional_ask) return g.rows;
  return [...g.rows, { donor: "Additional lobbyist ask — client allocation open", type: "Lobbyist balance",
    target: g.additional_ask, given: 0, remaining: g.additional_ask, last_cycle: 0,
    donor_key: "", cycles: {}, comp_gifts: [], factors: [g.target_reason], contacts: [], also: [], attribution: null }];
}

/**
 * The call list, as rows plus a role for each one so the writer can style it.
 *
 * Column layout, left to right: who to call, then one band per cycle. The
 * current cycle carries the ask and what has come in; the two before it carry
 * what these same donors gave this candidate and the handful of comparable
 * candidates they gave most to — the evidence for the ask, sitting next to it.
 */
function planSheetAoa(groups, cycle, { listNonTargets = false } = {}) {
  const self = window._targetProfile?.name || "This committee";
  const { cycles, comps } = planCycleColumns(groups, cycle);

  const fixed = ["Lobbyist", "Lobbyist or firm", "Donor", "Tier", "Who to call", "Email", "Phone",
                 "Why them"];
  const bands = [];
  let width = fixed.length + 1;                       // +1 spacer
  // Remaining is what is still to come, never below $0: the same figure as
  // the on-screen plan's Remaining column.
  bands.push({ cycle: cycles[0], start: width, current: true,
               cols: [{ filer: PLAN_SELF, kind: "Ask" }, { filer: PLAN_SELF, kind: "Given" },
                      { filer: PLAN_SELF, kind: REMAINING }] });
  width += 3;
  // What the comparables have received this cycle, a spacer apart from the
  // candidate's own Ask, Given and Remaining: the candidate's giving this
  // cycle is already Given, so this band holds the comparables only.
  if (comps.length) {
    width += 1;                                       // spacer
    bands.push({ cycle: cycles[0], start: width, compsOnly: true,
                 cols: comps.map(c => ({ filer: c.filer, kind: c.rung })) });
    width += comps.length;
  }
  for (const c of cycles.slice(1)) {
    width += 1;                                       // spacer
    const cols = [{ filer: PLAN_SELF, kind: "This candidate" },
                  ...comps.map(c => ({ filer: c.filer, kind: c.rung }))];
    bands.push({ cycle: c, start: width, cols });
    width += cols.length;
  }
  const blank = () => new Array(width).fill("");
  const label = f => (f === PLAN_SELF ? self : f);
  const remainingAt = bands[0].start + bands[0].cols.findIndex(c => c.kind === REMAINING);
  const rows = [], roles = [];
  const push = (row, role) => { rows.push(row); roles.push(role); };

  const seat = window._targetSeat, ctx = window._seatContext;
  const title = blank();
  title[0] = `${self} — who to ask, and for how much (${cycle - 1}–${cycle})`;
  push(title, "title");
  const sub = blank();
  sub[0] = seat
    ? `This seat was ${seat.label.replace(/ \(.*\)/, "")} in ${seat.year}`
      + (seat.band !== "unopposed" && seat.margin_pts != null ? ` — decided by ${seat.margin_pts.toFixed(1)} points` : "")
      + (ctx ? `. Comparable committees raised a median of ${fmt$(ctx.median)} this cycle.` : ".")
    : "No general-election margin on record for this seat.";
  push(sub, "note");
  const method = blank();
  method[0] = "For candidates with fewer than two completed incumbent cycles, prior-donor asks use median recent peer giving and cannot exceed that benchmark before rounding. Peer evidence uses each recipient's latest funded eligible cycle in the preceding two cycles. First-time asks use initial giving, capped at half the established benchmark before rounding. All donor targets round to the nearest $250, and anyone who gave last cycle is asked for more than that (eligible giving + 5%, rounded up to $250); lobbyist targets cannot fall below eligible last-cycle client giving after primary exclusions. "
    + "The columns on the right show that giving.";
  push(method, "note");
  push(blank(), "blank");

  const rCycle = blank(), rName = blank(), rKind = blank();
  for (const b of bands) {
    rCycle[b.start] = b.current ? `This cycle (${b.cycle - 1}–${b.cycle})`
      : b.compsOnly ? `This cycle (${b.cycle - 1}–${b.cycle}): comparables` : `${b.cycle - 1}–${b.cycle}`;
    b.cols.forEach((c, i) => { rName[b.start + i] = label(c.filer); rKind[b.start + i] = c.kind; });
  }
  fixed.slice(1).forEach((h, i) => { rCycle[i + 1] = h; });
  push(rCycle, "head-band");
  push(rName, "head-name");
  push(rKind, "head-kind");

  const totalsRow = blank();
  totalsRow[1] = "Everyone";
  const totals = new Array(width).fill(0);
  const body = [], bodyRoles = [];

  for (const g of groups) {
    const l = g.lobbyist;
    const name = l ? l.name : "(nobody on file — assign these at /admin/lobbyists)";
    const contact = planContact(l);
    const lead = blank();
    lead[1] = name;
    lead[3] = l ? g.tier.label : "";
    lead[4] = contact.name; lead[5] = contact.email; lead[6] = contact.phone;
    lead[7] = [l ? g.tier.why : "", g.target_reason].filter(Boolean).join(" · ");
    body.push(lead); bodyRoles.push("lobbyist");
    const groupSums = new Array(width).fill(0);
    for (const r of planExportRows(g)) {
      const row = blank();
      row[0] = name;
      row[2] = r.donor;
      row[3] = r.type === "Donor Target" ? "Gave before" : r.type === "New Prospect" ? "New prospect" : r.type;
      const dc = donorContact(r);
      row[4] = dc.name; row[5] = dc.email; row[6] = dc.phone;
      row[7] = [plainAttribution(r.attribution), ...(r.factors || []).filter(f => /First-time ask|first observed|earliest observed|Lobbyist target/.test(f))].filter(Boolean).join(" · ");
      for (const b of bands) {
        b.cols.forEach((c, i) => {
          const at = b.start + i;
          const v = c.kind === "Ask" ? r.target
            : c.kind === REMAINING ? rowRemaining(r)
            : b.current && c.filer === PLAN_SELF ? r.given
            : givenInCycle(r.donor_key, c.filer, b.cycle, r);
          if (c.kind === REMAINING) {
            // $0 once an ask is met (shown green); blank where there is no ask.
            // Lobbyist and Everyone rows use the group figure instead of a sum.
            if (v || r.target > 0) row[at] = Math.round(v);
            return;
          }
          if (!v) return;
          row[at] = Math.round(v);
          groupSums[at] += v;
          totals[at] += v;
        });
      }
      body.push(row); bodyRoles.push("donor");
    }
    if (g.nonTarget?.clients.length) {
      // One summary row, or (the plan's "List non-target donors" box) each
      // client on its own row. The lobbyist's totals are the same either way.
      const n = g.nonTarget.clients.length;
      const entries = listNonTargets
        ? g.nonTarget.clients.map(cl => ({ donor: cl.name, type: "Non-target", byCell: cl.byCell,
            why: "Client of this lobbyist, not in this plan: no ask" }))
        : [{ donor: NON_TARGET, type: "Not asked here", byCell: g.nonTarget.byCell,
             why: `${n} other client${n === 1 ? "" : "s"} of this lobbyist, not in this plan: who they are is on the ${NON_TARGET} sheet` }];
      for (const e of entries) {
        const row = blank();
        row[0] = name; row[2] = e.donor; row[3] = e.type; row[7] = e.why;
        for (const b of bands) b.cols.forEach((c, i) => {
          if (c.filer === PLAN_SELF) return;            // what they gave the comparables, nothing else
          const v = e.byCell.get(`${c.filer}|${b.cycle}`) || 0;
          if (!v) return;
          const at = b.start + i;
          row[at] = Math.round(v);
          groupSums[at] += v;
          totals[at] += v;
        });
        body.push(row); bodyRoles.push("nontarget");
      }
    }
    for (let i = 0; i < width; i++) if (groupSums[i]) lead[i] = Math.round(groupSums[i]);
    for (const b of bands.filter(b => !b.current && !b.compsOnly)) lead[b.start] = Math.round(groupSums[b.start]);
    // A lobbyist's Remaining is their target less what their donors have
    // given, as on screen: one client giving past its ask offsets another.
    const groupRemaining = g.remaining ?? planExportRows(g).reduce((sum, r) => sum + rowRemaining(r), 0);
    if (groupRemaining || groupSums[bands[0].start] > 0) lead[remainingAt] = Math.round(groupRemaining);
    totals[remainingAt] += groupRemaining;
  }
  for (let i = 0; i < width; i++) if (totals[i]) totalsRow[i] = Math.round(totals[i]);
  if (totals[bands[0].start] > 0) totalsRow[remainingAt] = Math.round(totals[remainingAt]);
  push(totalsRow, "total");
  body.forEach((row, i) => push(row, bodyRoles[i]));

  const merges = bands.filter(b => b.cols.length > 1).map(b => ({
    s: { r: 4, c: b.start }, e: { r: 4, c: b.start + b.cols.length - 1 },
  }));
  const cols = new Array(width).fill(null).map((_, i) =>
    ({ wch: i === 0 ? 24 : i === 1 ? 30 : i === 2 ? 38 : i === 3 ? 13 : i === 7 ? 46 : i < 7 ? 26 : 13 }));
  return { rows, roles, merges, cols, moneyFrom: fixed.length, headerRows: 7 };
}

// The same evidence the review page shows, in words a first-time reader can
// follow. A method means different things on the two link tables — a
// "name_exact" on a client link is the donor's name matching the client's,
// while on a direct link it is the lobbyist named on the committee's filing —
// so the two are worded separately.
const WHY_DIRECT = {
  email_exact: "listed as the committee's contact",
  name_exact: "named on the committee's filing",
  email_domain: "shares the committee's email domain",
  director: "a director of the committee works for their client",
  tracker: "from the fundraising tracker",
  sheet_2024: "from the 2024 lobby list",
  manual: "added by an admin",
  reviewed: "confirmed by an admin",
};
const WHY_CLIENT = {
  name_exact: "donor name matches a client of theirs",
  name_fuzzy: "donor name resembles a client of theirs",
  committee_contact: "a director of the committee works for that client",
  manual: "added by an admin",
  reviewed: "confirmed by an admin",
};

/** The "why them" line, in words a first-time reader can follow. */
function plainAttribution(a) {
  if (!a) return "";
  const client = a.client_names?.length ? `Lobbies for ${a.client_names.join(", ")}` : "";
  const reasons = [...new Set((a.methods || []).map(m => m.startsWith("client:")
    ? (WHY_CLIENT[m.slice(7)] || m.slice(7))
    : (WHY_DIRECT[m] || m)))];
  const parts = [client, reasons.join("; ")].filter(Boolean);
  return (a.status === "confirmed" ? "" : "Not yet reviewed — ") + parts.join(" · ");
}

/** Sheet 2: one line per lobbyist, in the shape of the 2024 lobby list. */
function lobbyistSheetRows(groups, cycle) {
  return groups.filter(g => g.lobbyist).map(g => {
    const l = g.lobbyist, c = planContact(l);
    const clients = [...new Set(g.rows.flatMap(r => r.attribution?.client_names || []))].join("; ");
    return {
      "Tier": g.tier.label,
      "Lobbyist / Firm": l.name,
      "Firm / Title": l.kind === "firm" ? "firm" : (l.affiliation || l.firm || ""),
      "Contact": c.name,
      "Email": c.email,
      "Phone": c.phone,
      "Other contacts": c.others,
      "Donors in plan": g.rows.length,
      "Suggested ask": Math.round(g.target),
      [`Given ${cycle - 1}–${cycle}`]: Math.round(g.given),
      "Remaining": Math.round(g.remaining),
      "Last Cycle": Math.round(g.last_cycle || 0),
      "Given to this committee to date": Math.round(g.tier.lifetime),
      "Like candidates supported": g.tier.likeComps,
      "Given to like candidates": Math.round(g.tier.likeTotal),
      "Clients": clients,
      "Why this tier": g.tier.why,
      "Target calculation": g.target_reason || "",
    };
  });
}

/** Sheet 3 (and the CSV): the flat table, one row per donor. */
function lobbyistPlanExportRows() {
  const out = [];
  for (const g of planGroups()) {
    const l = g.lobbyist;
    const name = l ? l.name : "(no lobbyist on file)";
    const c = planContact(l);
    for (const r of planExportRows(g)) {
      const dc = donorContact(r);
      out.push({
        "Tier": l ? g.tier.label : "",
        "Lobbyist": name,
        "Lobbyist Target": g.target, "Lobbyist Remaining": g.remaining,
        "Contact": c.name, "Email": c.email, "Phone": c.phone, "Other Firm Contacts": c.others,
        "Donor": r.donor,
        "Donor Contact": dc.name, "Donor Contact Email": dc.email, "Donor Contact Phone": dc.phone,
        "Type": r.type,
        "Target": Math.round(r.target),
        "Given This Cycle": Math.round(r.given),
        "Remaining": Math.round(r.remaining),
        "Last Cycle": r.last_cycle ?? "",
        "Comparable Max": r.comp_max || "",
        "Benchmark": r.benchmark ? `${r.benchmark.n} gifts to ${peerDescription(r.benchmark)}` : "all comparable giving",
        "Ask calculation": (r.factors || []).join("; "),
        "Attribution": attributionText(r.attribution),
        "Also Lobbied By": r.also.map(a => a.lobbyist.name).join("; "),
      });
    }
  }
  for (const r of planIndividuals()) {
    out.push({
      "Tier": "", "Lobbyist": "(individual — ask directly)", "Lobbyist Target": "", "Lobbyist Remaining": "",
      "Contact": "", "Email": "", "Phone": "", "Other Firm Contacts": "",
      "Donor": r.donor, "Donor Contact": "", "Donor Contact Email": "", "Donor Contact Phone": "",
      "Type": `Individual — ${r.type === "Donor Target" ? "Donor Target" : "Client history"}`,
      "Target": Math.round(r.target), "Given This Cycle": Math.round(r.given), "Remaining": Math.round(r.remaining),
      "Last Cycle": r.last_cycle ?? "", "Comparable Max": r.comp_max || "",
      "Benchmark": r.benchmark ? `${r.benchmark.n} gifts to ${peerDescription(r.benchmark)}` : "",
      "Ask calculation": (r.factors || []).join("; "), "Attribution": "", "Also Lobbied By": "",
    });
  }
  return out;
}

/** The Individuals sheet: the people who have given here, one line each. */
function individualSheetRows(cycle) {
  return planIndividuals().map(r => ({
    "Donor": r.donor,
    "ORESTAR category": r.category || "",
    "Ask": r.target ? Math.round(r.target) : "",
    [`Given ${cycle - 1}–${cycle}`]: Math.round(r.given),
    "Remaining": Math.round(r.remaining),
    [`Given ${cycle - 3}–${cycle - 2}`]: Math.round(r.last_cycle || 0),
    "How the ask was set": (r.factors || []).filter(f => /^(Ask baseline|Base target|Ask = |More than last cycle)|unusually large contested primary|first legislative primary/.test(f)).join(" · ")
      || (r.target ? "" : "No ask: no eligible giving last cycle (none, or only inside an exceptional primary window)"),
  }));
}

/** Sheet 4: how every number on the other sheets was arrived at. */
function methodSheetRows(groups, cycle) {
  const seat = window._targetSeat, ctx = window._seatContext;
  const rows = [
    { Item: "Committee", Value: window._targetProfile?.name || "", Detail: `${cycle - 1}–${cycle} cycle` },
    { Item: "Seat", Value: seat ? seat.label : "no margin on record",
      Detail: seat && seat.margin_pts != null ? `${seatDescription(seat)}, ${seat.year} general` : "" },
  ];
  if (ctx) {
    rows.push({ Item: ctx.kind === "unopposed" ? "Unopposed-seat peers" : "Similar-margin seats", Value: fmt$(ctx.median),
      Detail: `median raised this cycle by ${ctx.n} comparable committees in ${peerDescription(ctx)}` });
    rows.push({ Item: "This committee", Value: fmt$(ctx.raised),
      Detail: ctx.median ? `${Math.round((ctx.raised / ctx.median) * 100)}% of that median` : "" });
    for (const p of ctx.peers.slice(0, 10)) {
      rows.push({ Item: "  peer", Value: p.name, Detail: `${seatDescription(p.seat)} · ${fmt$(p.total)} this cycle` });
    }
  }
  if (window._targetProfile?._entryBaseline) rows.push({ Item: "Incumbent ask baseline", Value: window._targetProfile._entryBaseline.start,
    Detail: "Exclude fundraising through the first legislative primary from donor ask baselines and lobbyist minimums. Last Cycle and historical contribution columns retain full actual giving." });
  rows.push({ Item: "Unusually large primaries", Value: "Excluded from ask baselines",
    Detail: "A named primary opponent has at least 20%; cash through the primary is at least $25,000, 1.5 times the median of the previous two funded primary periods, and $10,000 above that median. Exclude January 1 of the preceding year through primary day for the candidate and all comparison references. Normal earlier cycles and post-primary giving remain eligible. Actual history and current giving credits are unchanged. Detected periods refresh through reviewed data PRs." });
  for (const p of window._primaryExclusionNotes || []) rows.push({ Item: `Excluded primary: ${p.name}`, Value: `${p.start}–${p.through}`,
    Detail: `${fmt$(p.primary_cash)} cash vs ${fmt$(p.historical_median)} historical median; strongest named opponent ${p.opposition_pct}%.` });
  const chosenComps = (window._comparables || []).filter(c => c.chosen);
  if (chosenComps.length) rows.push({ Item: "Comparison committees", Value: "chosen for this candidate",
    Detail: `${chosenComps.map(c => c.name).join(", ")}. Named by hand; they replace the selection rules below and each counts as a primary reference.` });
  rows.push({ Item: "Limited incumbent history", Value: "75% / 60% comparable weight",
    Detail: "Repeat-donor asks use 75% comparable giving with no completed eligible incumbent cycle, or 60% with one. The remainder is own post-primary giving plus 5%, capped at the median peer benchmark before $250 rounding. Each peer contributes their latest funded eligible cycle from the preceding two cycles; current, future, and older cycles do not set this benchmark. Two or more completed cycles retain history-led weighting. No peer gift means no invented benchmark. New-donor first-gift limits are unchanged." });
  rows.push({ Item: "Leadership and committee chairs", Value: "same-chamber role peers",
    Detail: "Other leadership members and verified committee chairs compare with each other within the same chamber, party and compatible seat margins. Senior leaders retain their separate primary pool; ordinary members use ordinary peers." });
  rows.push({ Item: "Established giving benchmark", Value: "comparable seats",
    Detail: `A donor's ask is the upper-median of what they gave candidates in seats within ${PEER_WINDOWS[0]}–`
      + `${PEER_WINDOWS[PEER_WINDOWS.length - 1]} pts of this one, never above their own largest gift. `
      + `Legislative comparisons use current members verified against the official roster. Ordinary candidates use the same chamber; senior leaders use a cross-chamber primary leadership pool, with automatically identified fundraising outliers as secondary references only when the donor has no primary leadership giving. Unopposed seats are matched only to other unopposed seats, never numeric margins. Outliers exceed Q3 + 1.5 × IQR among at least eight current same-party non-primary members, using each member’s best two-year total in the preceding two completed cycles. Primary leaders are the House Speaker, Senate President, both Majority Leaders, and Ways and Means Co-Chairs. Speaker giving is discounted 10% for a House Majority Leader target. Other comparisons exclude mismatched unopposed seats, unknown peer margins when the target margin is known, and seats more than 20 points apart. Under ${MIN_PEER_GIFTS} such gifts, only eligible comparable giving is used and the donor row says so.` });
  const goal = window._fundraisingTarget;
  if (goal) rows.push({ Item: "Fundraising target", Value: fmt$(goal.target),
    Detail: `The greater of every donor and prospect ask (${fmt$(goal.asks)}) or last cycle's eligible contributions `
      + `(${fmt$(goal.lastCycle.eligible)} in ${cycleName(goal.lastCycle.cycle)}) plus 5%, rounded up to $250 (${fmt$(goal.floor)}). `
      + (goal.lastCycle.excluded ? `${fmt$(goal.lastCycle.excluded)} raised inside exceptional primary windows is left out of last cycle. ` : "")
      + (goal.gap ? `The asks leave ${fmt$(goal.gap)} still to find from small-dollar giving, events and new donors.` : "The asks cover it.") });
  rows.push({ Item: "More than last cycle", Value: "+5%, rounded up to $250",
    Detail: "Every donor with eligible giving last cycle gets an ask of at least that giving plus 5%, rounded up to the next $250, so the ask is always more than last time — including one-cycle donors and gifts too small for an ask of their own. It applies after the benchmark blend and any peer cap. Giving in exceptional primary windows does not count toward the floor. ORESTAR's pooled line for unitemized gifts of $100 and under is never a donor." });
  rows.push({ Item: NON_TARGET, Value: "whole book, comparables only",
    Detail: "A lobbyist's comparable columns include every client filed under them (their strongest attribution, rolled up to the firm) who is not in this plan. Those clients have no ask; their giving to the comparison candidates is one row under the lobbyist, and each is listed on the Non-target donors sheet." });
  rows.push({ Item: "Lobbyist target", Value: "last-cycle floor",
    Detail: "The greater of summed client asks or eligible last-cycle giving from currently attributed clients, including clients omitted from individual recommendations. First-entry and flagged unusually large primary fundraising are excluded from this floor, while Last Cycle shows actual giving. The floor rounds up to $250 to avoid falling below eligible baseline giving. Additional asks remain allocated to the lobbyist, not a specific client. Current client giving reduces the group remaining ask. Attribution describes the current client book, not proven historical representation." });
  rows.push({ Item: "How recent the evidence is", Value: RECENT_BENCHMARK_CYCLES.map(b => cycleName(cycle - b)).reverse().join(" and "),
    Detail: "Only giving from those two completed cycles sets an ask. A donor who gave a comparable candidate "
      + "nothing in them is benchmarked on its older giving instead and the row says so; giving more than "
      + `${STALE_BENCHMARK_CYCLES[STALE_BENCHMARK_CYCLES.length - 1] / 2} cycles back never prices an ask. `
      + "Earlier giving is still shown as history." });
  rows.push({ Item: "Every ask is a blend", Value: "own giving + comparable reference",
    Detail: "A comparable's giving pulls an ask toward it and never replaces it: the donor row states the "
      + "percentages, both amounts and the result. A same-tier peer's gift is one candidate reference among "
      + "others rather than the answer." });
  rows.push({ Item: "Fundraising ladder", Value: "one column per rung",
    Detail: "The earlier-cycle columns hold one candidate per rung of this chamber's fundraising ladder "
      + "rather than the five largest recipients, so an ask can be read against a candidate of this kind. "
      + "Rungs come from floor leadership, how close the seat is, and career fundraising among committees "
      + "still standing for election. Committee chairmanships are not in ORESTAR; pin a committee to a rung "
      + "with an `archetype` admin tag (value 1–5) and the pin wins." });
  const columns = planCycleColumns(groups, cycle).comps;
  if (columns.some(c => c.rung === "Chosen comparison")) {
    rows.push({ Item: "  columns for this plan", Value: "chosen comparison committees",
      Detail: `This candidate's comparison committees were chosen by hand, so they are the earlier-cycle columns instead of the ladder: ${columns.map(c => c.filer).join(", ")}.` });
  }
  const chosenRungs = new Map(columns.filter(c => c.level != null).map(c => [c.level, c.filer]));
  for (const rung of FUNDRAISER_LEVELS) {
    const named = [...(window._fundraiserLevels || new Map()).values()]
      .filter(s => s.level === rung.level).sort((a, b) => b.raised - a.raised);
    rows.push({ Item: `  rung ${rung.level} — ${rung.label}`,
      Value: chosenRungs.get(rung.level) || "(no column)",
      Detail: `${rung.blurb}. ${named.length} committee${named.length === 1 ? "" : "s"} on this rung`
        + (named.length ? `: ${named.slice(0, 5).map(s => s.name).join(", ")}` : "") });
  }
  rows.push({ Item: "First-time ask", Value: "lower introductory ask",
    Detail: "Median first observed cash contribution to comparable candidates, capped at 50% of the established-giving benchmark before rounding to the nearest $250. If first transactions are unavailable, earliest observed annual totals serve as an explicitly labeled proxy. The first observed record may not be the donor’s first-ever gift." });
  for (const t of TIER_RULES) {
    rows.push({ Item: t.label, Value: `score ≥ ${t.min === -Infinity ? "0" : t.min}`,
      Detail: "6 × donors in plan (max 30) + 2 × like candidates supported (max 30) + giving to them ÷ 5,000 (max 20) + 15 if they have given here before + 5 if they have given this cycle" });
  }
  return rows;
}

// ── The lobbyist plan workbook ─────────────────────────────────────────────
// Built with ExcelJS rather than the SheetJS build the other exports use,
// because this one is opened by people who did not make it: it needs frozen
// headers, bold titles, shaded tier rows and currency formatting, none of
// which the community SheetJS build can write. Loaded only when asked for.

const EXCELJS_SRC = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

async function loadExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  await new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = EXCELJS_SRC;
    el.onload = resolve;
    el.onerror = () => reject(new Error("could not load the spreadsheet formatter"));
    document.head.appendChild(el);
  });
  return window.ExcelJS;
}

const INK = {
  head: "FF1F3864",        // header band
  headText: "FFFFFFFF",
  // One colour per tier, matching the chips on screen: green, amber, blue,
  // and nothing for Tier 4 — an unfilled row reads as "the rest".
  tier1: "FFDCFCE7",
  tier2: "FFFEF3C7",
  tier3: "FFDBEAFE",
  lobbyist: "FFEFF3FA",
  total: "FFD9E2F3",
  rule: "FFBFBFBF",
  contact: "FF7D9A78",     // the lobby list's sage header for who-to-call columns
  muted: "FF595959",
  // Remaining stands apart from the columns around it: its own header, a
  // tinted column, red while money is still to come and green once an ask is met.
  remainingHead: "FFC55A11",
  remaining: "FFFCE4D6",
  owed: "FFC00000",
  met: "FF2E7D32",
};
const MONEY = '"$"#,##0';

function styleHeaderCell(cell, { center = false } = {}) {
  cell.font = { bold: true, color: { argb: INK.headText }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.head } };
  cell.alignment = { vertical: "middle", horizontal: center ? "center" : "left", wrapText: true };
}

const TIER_FILLS = { "Tier 1": INK.tier1, "Tier 2": INK.tier2, "Tier 3": INK.tier3 };
function tierFill(label) {
  return TIER_FILLS[label] || null;
}

/** Sheet 1 of the workbook: the call list, styled. */
async function writeCallList(wb, groups, cycle, options = {}) {
  const { rows, roles, headerRows, cols, moneyFrom, merges } = planSheetAoa(groups, cycle, options);
  const ws = wb.addWorksheet("Call list", {
    views: [{ state: "frozen", xSplit: 3, ySplit: headerRows }],
    properties: { defaultRowHeight: 16, outlineLevelRow: 1, outlineProperties: { summaryBelow: false } },
  });
  rows.forEach(r => ws.addRow(r));
  cols.forEach((col, i) => { ws.getColumn(i+1).width = col?.wch || 12; });
  for (const m of merges) ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  // Excel columns for the planSheetAoa layout: B lobbyist, C donor, D tier, H why.
  const TIER_COL = 4, DONOR_COL = 3, WHY_COL = 8;
  const remainingCol = rows[headerRows - 1].indexOf(REMAINING) + 1;

  let group = -1;                      // planSheetAoa writes one lobbyist row per group, in order
  rows.forEach((_, i) => {
    const row = ws.getRow(i + 1);
    const role = roles[i];
    if (role === "title") {
      row.font = { bold: true, size: 14 };
      row.height = 22;
    } else if (role === "note") {
      row.font = { italic: true, size: 10, color: { argb: INK.muted } };
    } else if (role.startsWith("head")) {
      row.height = role === "head-name" ? 28 : 18;
      row.eachCell({ includeEmpty: true }, (cell, c) => styleHeaderCell(cell, { center: c > moneyFrom }));
      // The band title is one merged cell; only the rows under it change colour.
      if (remainingCol && role !== "head-band") {
        row.getCell(remainingCol).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.remainingHead } };
      }
    } else if (role === "total") {
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.total } };
      });
    } else if (role === "lobbyist") {
      group++;
      row.font = { bold: true };
      const tier = String(row.getCell(TIER_COL).value || "");
      const fill = tierFill(tier) || INK.lobbyist;
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        cell.border = { top: { style: "thin", color: { argb: INK.rule } } };
      });
    } else if (role === "donor" || role === "nontarget") {
      if (role === "nontarget") row.font = { italic: true, color: { argb: INK.muted } };
      row.outlineLevel = 1;
      // Donors with no lobbyist are listed as they are, at the bottom: there is
      // nobody to collapse them under, and a plan without attribution should
      // never open looking empty.
      row.hidden = Boolean(groups[group]?.lobbyist);
      row.getCell(DONOR_COL).alignment = { indent: 1 };
    }
    if (role === "donor" || role === "nontarget" || role === "lobbyist" || role === "total") {
      for (let c = moneyFrom + 1; c <= rows[0].length; c++) row.getCell(c).numFmt = MONEY;
      row.getCell(WHY_COL).alignment = { wrapText: true, vertical: "top" };
      if (remainingCol) {
        const cell = row.getCell(remainingCol), value = cell.value;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.remaining } };
        if (typeof value === "number") {
          cell.font = { bold: role !== "donor" || value > 0, color: { argb: value > 0 ? INK.owed : INK.met } };
        }
      }
    }
  });
  // The "Lobbyist" repeat in column A is there for filtering and sorting, not
  // for reading; it would otherwise be the first thing the eye lands on.
  ws.getColumn(1).hidden = true;
  ws.getColumn(1).width = 24;
  const headers = roles.flatMap((role,i) => role === "lobbyist" ? [i+1] : []);
  for (let i = 0; i < headers.length; i++) {
    if (groups[i]?.lobbyist) writeFirmName(ws, groups[i].lobbyist, headers[i], 2);
  }
  return ws;
}

/** A plain table sheet: bold frozen header, filter, currency where asked. */
function writeTable(wb, name, rows, { money = [], widths = {}, note = "" } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: note ? 3 : 1 }] });
  const headers = Object.keys(rows[0] || {});
  if (note) {
    ws.addRow([note]).font = { italic: true, size: 10, color: { argb: INK.muted } };
    ws.addRow([]);
  }
  const head = ws.addRow(headers);
  head.height = 26;
  head.eachCell(cell => styleHeaderCell(cell));
  for (const r of rows) ws.addRow(headers.map(h => r[h]));
  headers.forEach((h, i) => {
    const col = ws.getColumn(i+1);
    col.width = widths[h] || Math.min(42, Math.max(12, String(h).length + 4));
    if (money.includes(h)) col.numFmt = MONEY;
  });
  ws.autoFilter = {
    from: { row: head.number, column: 1 },
    to: { row: head.number + rows.length, column: headers.length },
  };
  return ws;
}

/** Sheet 0: what this is, for someone opening it cold. */
function writeCover(wb, groups, cycle, { listNonTargets = false } = {}) {
  const ws = wb.addWorksheet("Start here", { views: [{ showGridLines: false }] });
  const self = window._targetProfile?.name || "This committee";
  const seat = window._targetSeat, ctx = window._seatContext;
  const withLob = groups.filter(g => g.lobbyist);
  const donors = groups.reduce((n, g) => n + g.rows.length, 0);
  const ask = groups.reduce((n, g) => n + g.remaining, 0);

  const title = ws.addRow([`${self} — lobbyist call plan`]);
  title.font = { bold: true, size: 18 };
  title.height = 26;
  ws.addRow([`${cycle - 1}–${cycle} election cycle · prepared ${new Date().toLocaleDateString("en-US",
    { year: "numeric", month: "long", day: "numeric" })}`]).font = { size: 11, color: { argb: INK.muted } };
  ws.addRow([]);

  const goal = window._fundraisingTarget;
  const facts = [
    ["Lobbyists to call", withLob.length],
    ["Donors covered", donors],
    ["Still to ask", ask],
    ["Seat", seat ? `${seat.label.replace(/ \(.*\)/, "")}${seat.band !== "unopposed" && seat.margin_pts != null
      ? `, decided by ${seat.margin_pts.toFixed(1)} points in ${seat.year}` : ""}` : "no margin on record"],
  ];
  if (ctx) facts.push([ctx.kind === "unopposed" ? "What unopposed-seat peers raise" : "What seats this close raise", ctx.median]);
  const money = new Set(["Still to ask"]);
  if (goal) {
    const lastLabel = `Last cycle (${cycleName(goal.lastCycle.cycle)}), eligible`;
    facts.push(["Fundraising target this cycle", goal.target], [lastLabel, goal.lastCycle.eligible],
               ["Donor and prospect asks", goal.asks]);
    if (goal.gap) facts.push(["Still to find (small-dollar, events, new donors)", goal.gap]);
    for (const k of ["Fundraising target this cycle", lastLabel, "Donor and prospect asks",
                     "Still to find (small-dollar, events, new donors)"]) money.add(k);
  }
  for (const [k, v] of facts) {
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (typeof v === "number" && (money.has(k) || k.startsWith("What seats"))) {
      row.getCell(2).numFmt = MONEY;
    }
  }
  ws.addRow([]);

  const heading = t => { const r = ws.addRow([t]); r.font = { bold: true, size: 12 }; r.height = 20; };
  const para = t => { const r = ws.addRow([t]); r.font = { size: 11 }; r.alignment = { wrapText: true }; r.height = 30; };

  heading("What's in this file");
  for (const [sheet, what] of [
    ["Call list", "Every lobbyist to call, in the order to call them, with their donors underneath and what to ask each one for."],
    ["Lobbyists", "The same lobbyists, one line each, with the designated lead named for firms."],
    ["Non-target donors", "Clients of the lobbyists on the call list who are not in this plan, and what each gave the comparison candidates."],
    ["Individuals", "People who have given to this candidate, with their asks. Call them directly; they are not on the call list."],
    ["Donors", "One line per donor, for anyone who wants to pivot the numbers."],
    ["How these numbers were set", "Where each figure came from."],
  ]) {
    const row = ws.addRow([sheet, what]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true };
    row.height = 28;
  }
  ws.addRow([]);

  heading("How to read the call list");
  para("Lobbyists are listed best-prospect first: Tier 1 through Tier 4. The tier reflects how many donors they carry here and how much those donors give to candidates like this one — the reason is spelled out in the “Why them” column.");
  para(`Under each lobbyist are the donors they handle. “Ask” is what to ask for this cycle; “Given” is what has already come in; “Remaining” is what is still to come, never below $0; for a lobbyist it is their target less what their donors have given. Next come what those same donors have given the comparable candidates this cycle, then what they gave this candidate and the comparables in the two cycles before — that is the case for the ask. A lobbyist's comparable columns count their whole book: ${listNonTargets ? "clients not in this plan are listed one by one under them, marked “Non-target”, with no ask." : "clients not in this plan are summed in a “Non-target donors” row under them."}`);
  para("The call list is organizations, PACs and businesses only, using ORESTAR's own category for each contributor. Donors with no lobbyist on file are at the bottom of it. People who have given to this candidate are on the Individuals sheet instead.");
  para("Anyone who gave last cycle is asked for more than that. The fundraising target is never less than last cycle's contributions plus 5%, leaving out giving in exceptionally high-spend primary contests; anything the asks do not cover is shown as still to find.");

  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 96;
  return ws;
}

// Keep identity/grouping data intact; only the visible Excel label changes.
function writeFirmName(ws, lobbyist, rowNumber, columnNumber) {
  if (lobbyist.kind !== "firm") return;
  const primary = portraitPerson(lobbyist);
  if (!primary) return;
  const row = ws.getRow(rowNumber), cell = row.getCell(columnNumber);
  cell.value = {richText:[
    {font:{bold:true},text:primary.name},
    {font:{bold:false},text:"\n" + lobbyist.name},
  ]};
  cell.alignment = {wrapText:true,vertical:"middle"};
  row.height = Math.max(row.height || 16, 36);
}

async function addPortrait(wb, ws, person, rowNumber, columnNumber, imageCache) {
  const cell = ws.getRow(rowNumber).getCell(columnNumber);
  const image = typeof LP !== "undefined" ? await LP.image(person) : null;
  if (!image) {
    cell.value = "Photo unavailable";
    ws.getRow(rowNumber).height = Math.max(ws.getRow(rowNumber).height || 16, 28);
    cell.alignment = {wrapText:true,vertical:"middle",horizontal:"center"};
    cell.font = {size:9,color:{argb:INK.muted}};
    return;
  }
  if (!imageCache.has(image.photo.path)) imageCache.set(image.photo.path,
    wb.addImage({buffer:image.data,extension:"jpeg"}));
  ws.getRow(rowNumber).height = Math.max(ws.getRow(rowNumber).height || 16, 84);
  ws.addImage(imageCache.get(image.photo.path), {
    tl:{col:columnNumber-1+.12,row:rowNumber-1+.05}, ext:{width:80,height:100}, editAs:"oneCell",
  });
}

async function exportLobbyistWorkbook(groups, cycle, filename) {
  const ExcelJSLib = await loadExcelJs();
  const wb = new ExcelJSLib.Workbook();
  wb.creator = "Oregon Campaign Finance";
  wb.created = new Date();

  try {
    await loadNonTargetClients(groups, cycle);
  } catch (e) {
    console.warn("Non-target clients unavailable:", e);   // the call list is still right without them
  }
  // Decided per export, with the box beside the Excel button.
  const listNonTargets = document.getElementById("plan-list-non-targets")?.checked === true;
  writeCover(wb, groups, cycle, { listNonTargets });
  await writeCallList(wb, groups, cycle, { listNonTargets });

  const lobRows = lobbyistSheetRows(groups, cycle);
  if (lobRows.length) {
    const lobbyistSheet = writeTable(wb, "Lobbyists", lobRows, {
      money: ["Suggested ask", `Given ${cycle - 1}–${cycle}`, "Remaining", "Last Cycle",
              "Given to this committee to date", "Given to like candidates"],
      widths: { "Lobbyist / Firm": 30, "Firm / Title": 24, Contact: 24, Email: 30,
                "Other contacts": 44, Clients: 60, "Why this tier": 60 },
      note: "One line per lobbyist. For firms, the designated lead is named first.",
    });
    const named = groups.filter(g => g.lobbyist);
    for (let i = 0; i < named.length; i++) writeFirmName(lobbyistSheet, named[i].lobbyist, i + 4, 2);
  }
  const nonTargets = nonTargetSheetRows(groups, cycle);
  if (nonTargets.length) {
    writeTable(wb, NON_TARGET, nonTargets, {
      money: Object.keys(nonTargets[0]).filter(k => k !== "Lobbyist" && k !== "Non-target donor"),
      widths: { Lobbyist: 30, "Non-target donor": 40 },
      note: "Clients filed under a lobbyist in this plan who are not in the plan themselves. Their giving to the comparison candidates is each lobbyist's “Non-target donors” row on the call list.",
    });
  }
  const people = individualSheetRows(cycle);
  if (people.length) {
    writeTable(wb, "Individuals", people, {
      money: ["Ask", `Given ${cycle - 1}–${cycle}`, "Remaining", `Given ${cycle - 3}–${cycle - 2}`],
      widths: { Donor: 34, "ORESTAR category": 26, "How the ask was set": 90 },
      note: "People who have given to this candidate. They are not on the call list: ask them directly, not through a lobbyist.",
    });
  }
  const flat = lobbyistPlanExportRows();
  if (flat.length) {
    writeTable(wb, "Donors", flat, {
      money: ["Target", "Given This Cycle", "Remaining", "Last Cycle", "Comparable Max"],
      widths: { Lobbyist: 28, Donor: 38, Attribution: 60, Email: 30, "Other Firm Contacts": 40 },
      note: "One line per donor — the sheet to pivot.",
    });
  }
  writeTable(wb, "How these numbers were set", methodSheetRows(groups, cycle),
             { widths: { Item: 26, Value: 34, Detail: 110 } });

  const buf = await wb.xlsx.writeBuffer();
  downloadFile(new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), filename);
}

// ── Export ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// THE STANDING DONOR LIST — top organizations by chamber and party
// ═══════════════════════════════════════════════════════════════════════════
//
// The candidate view answers "who should *this* candidate call?" This one
// answers the question a caucus asks before any candidate is in the room:
// **who gives to House Democrats, and how much do they give one of them?**
//
// It is built from every candidate committee of that chamber and party — not
// the fifty comparables — because the claim is about the seat type, not about
// one race. Each donor is ranked on the three things that make a name worth
// putting on a standing call list:
//
//   consistency  do they show up cycle after cycle, or did they appear once?
//   breadth      how many of these campaigns do they give to in a cycle?
//   magnitude    how much do they put into the chamber in a cycle?
//
// and each is measured through the same recency window the asks use, so a
// donor who was everywhere in 2014 and nowhere since does not lead the list.
//
// The number beside each name is the **generic ask**: the recency-weighted
// median of what that donor gives ONE candidate of this kind across a whole
// cycle. Installments are added up first — a $1,000 primary check and a
// $1,000 general check are a $2,000 relationship, and that is what you ask
// for. The median single check is carried alongside for reference.

const LIST_SIZE = 125;              // the list the user asked for: top 100–125
// The next tranche down. These are not asked for — they carry no suggested
// ask — but when a lobbyist already on the list also represents one of them,
// it belongs in their giving columns: it is part of the conversation you are
// about to have, even though it is not part of the ask.
const LIST_CONTEXT_SIZE = 250;

// ── Who sets a typical ask, and who does not ─────────────────────────────
//
// A Speaker is given money on a different scale from a back-bencher, and so
// is a veteran committee chair who has been raising for a decade. Leaving
// them in the median asks a first-time caller to open at a number only a
// leader ever sees.
//
// So they come out of the *median* and nothing else: they keep their place in
// the giving columns, and they still count toward a donor's breadth,
// consistency and size. The ask is simply what this donor gives an ordinary
// member of the caucus.
//
// Three kinds come out, in descending order of how obvious they are:
//
//   1. Chamber leadership — Speaker, Senate President, Majority Leader,
//      Minority Leader, and the Ways and Means Co-Chairs.
//   2. A senior member who is also in leadership or chairs a committee AND
//      raises like an outlier. That last clause is what makes the rule
//      workable: seniority and a gavel are common, and plenty of members who
//      have both still raise ordinary sums. Only the combination distorts a
//      median, and the money is the part we can measure directly.
//
// Seniority is counted in completed cycles with giving, so "more than two
// terms" is three or more.
const LIST_SENIOR_CYCLES = 3;

/** Minority Leader, which the primary-leadership test does not cover. */
function minorityLeaderRole(filer) {
  const chamber = getChamber(filer);
  return !!chamber && new RegExp(`^(${chamber} )?minority leader$`).test(leadershipTitle(filer));
}

/**
 * Why this committee's giving is left out of the ask median, or null.
 * `senior` and `outlier` are measured per cohort by the caller.
 */
function askMedianExclusion(filer, { senior, outlier }) {
  if (primaryLeadershipRole(filer)) return "chamber leadership";
  if (minorityLeaderRole(filer)) return "chamber leadership";
  if (senior && outlier && otherLeadershipOrChair(filer)) return "senior leader or chair, outsized";
  return null;
}

/**
 * Committees raising far above the rest of their caucus: Q3 + 1.5 × IQR, the
 * same rule the candidate plan uses for fundraising outliers.
 *
 * Measured over **sitting members only**. A cohort holds decades of committees,
 * most of them long dormant, and including them drags Q1 to almost nothing and
 * blows the interquartile range out: against the whole cohort the bar came to
 * $424,000 and only the Speaker and the Majority Leader cleared it, which is
 * not a useful definition of "raises more than their colleagues". Against
 * sitting members it is $377,000, and it finds the veterans it is meant to.
 */
function outsizedRaisers(totalsBySlug) {
  const values = [...totalsBySlug.values()].filter(v => v > 0).sort((a, b) => a - b);
  if (values.length < 8) return new Set();   // too little evidence to call anyone an outlier
  const q1 = percentile(values, 0.25), q3 = percentile(values, 0.75);
  const threshold = q3 + 1.5 * (q3 - q1);
  return new Set([...totalsBySlug].filter(([, v]) => v > threshold).map(([slug]) => slug));
}
const LIST_MIN_RAISED = 5000;       // committees below this are paper filings
const LIST_MIN_CYCLES = 2;          // one cycle is an event, not a habit
const LIST_LOOKUP_BATCH = 300;      // donors whose category is read at a time
const LIST_RECIPIENTS_SHOWN = 20;   // candidates named per donor per cycle
// A call list asks for round numbers, but a small ask has to stay small: a
// donor whose giving sits at $250 should be asked $250, not rounded up to
// $500 for tidiness. So the step is finer below $1,000 than above it.
const LIST_ASK_STEP = 500;
const LIST_ASK_SMALL_STEP = 250;
const LIST_ASK_SMALL_BELOW = 1000;
const LIST_ASK_FLOOR = 250;

function roundAsk(amount) {
  const value = Number(amount) || 0;
  const step = value < LIST_ASK_SMALL_BELOW ? LIST_ASK_SMALL_STEP : LIST_ASK_STEP;
  return Math.max(LIST_ASK_FLOOR, Math.round(value / step) * step);
}

// Full marks. A donor giving to this many campaigns in a cycle, or this many
// dollars into the chamber in a cycle, tops out the component; the curve in
// between is logarithmic because the difference between 2 and 6 campaigns
// says far more than the difference between 26 and 30.
const LIST_BREADTH_FULL = 35;
const LIST_MAGNITUDE_FULL = 150000;
const LIST_WEIGHTS = { consistency: 40, breadth: 35, magnitude: 25 };

const LIST_CHAMBERS = [
  { key: "house",  label: "House",  office: "State Representative" },
  { key: "senate", label: "Senate", office: "State Senator" },
];
const LIST_PARTIES = [
  { key: "Democrat",   label: "Democratic", short: "D" },
  { key: "Republican", label: "Republican", short: "R" },
];

const listCache = new Map();        // "house|Democrat|2026" → built list

function listChamber(key) { return LIST_CHAMBERS.find(c => c.key === key) || LIST_CHAMBERS[0]; }
function listParty(key) { return LIST_PARTIES.find(p => p.key === key) || LIST_PARTIES[0]; }
function listTitle(chamber, party, cycle) {
  return `${party.label} candidates for the Oregon ${chamber.label}, through ${cycleName(cycle)}`;
}

/** Every candidate committee of a chamber and party that ever really raised. */
function chamberCohort(chamber, party) {
  return (filerIndex || []).filter(f =>
    f.committee_type === "Candidate Committee"
    && f.office === chamber.office
    && (f.party || "") === party.key
    && (f.total_in || 0) >= LIST_MIN_RAISED
    && !(adminTags[f.slug] || []).some(t => t.tag === "exclude"));
}

/** Committee names, so a candidate's own committee is never listed as a donor. */
let candidateNameSet = null;
function candidateCommitteeNames() {
  if (!candidateNameSet) {
    candidateNameSet = new Set((filerIndex || [])
      .filter(f => f.committee_type === "Candidate Committee")
      .map(f => f.name.toLowerCase()));
  }
  return candidateNameSet;
}
function isCandidateCommittee(key, name) {
  const names = candidateCommitteeNames();
  return names.has(key) || names.has(String(name).replace(/\s*\(\d+\)\s*$/, "").toLowerCase());
}

/**
 * Build the list. Loads every cohort committee's per-year donor table, rolls
 * it up per donor per committee per cycle, drops the people, and ranks what
 * is left.
 */
async function buildChamberList(chamberKey, partyKey, cycle, onProgress = () => {}) {
  const chamber = listChamber(chamberKey), party = listParty(partyKey);
  const cacheKey = `${chamber.key}|${party.key}|${cycle}`;
  if (listCache.has(cacheKey)) return listCache.get(cacheKey);

  const cohort = chamberCohort(chamber, party);
  if (!cohort.length) throw new Error(`No ${party.label} ${chamber.label} committees on file.`);
  // The giving history names sitting members only, and the ask median leaves
  // out leaders and chairs, so both rosters are required rather than optional.
  await Promise.all([loadCurrentLegislators(), loadCommitteeChairs()]);
  const windowCycles = CYCLE_WEIGHTS.map((_, i) => cycle - 2 * i);
  const inWindow = new Map();                        // "2025" → 2026
  for (const c of windowCycles) for (const y of cycleYears(c)) inWindow.set(String(y), c);

  onProgress(`Loading donor history for ${cohort.length} ${party.label} ${chamber.label} committees…`);
  const blobs = await DL.getFilerDonorYears(cohort.map(f => f.slug));

  // donor → { name, ids, gifts: Map<"slug|cycle", amount> }
  const donors = new Map();
  const raisedBySlug = new Map();          // slug → {cycle: total raised}
  for (const filer of cohort) {
    const byYear = blobs.get(filer.slug) || {};
    for (const [year, rows] of Object.entries(byYear)) {
      const cy = inWindow.get(String(year));
      if (!cy) continue;
      if (!raisedBySlug.has(filer.slug)) raisedBySlug.set(filer.slug, {});
      const raised = raisedBySlug.get(filer.slug);
      for (const d of rows) {
        raised[cy] = (raised[cy] || 0) + Number(d.total || 0);
        const key = donorKey(d);
        if (!donors.has(key)) {
          donors.set(key, { name: donorDisplayName(d.name), ids: new Set(), gifts: new Map() });
        }
        const entry = donors.get(key);
        if (d.donor_id) entry.ids.add(d.donor_id);
        const slot = `${filer.slug}|${cy}`;
        entry.gifts.set(slot, (entry.gifts.get(slot) || 0) + Number(d.total || 0));
      }
    }
  }

  const byName = new Map(cohort.map(f => [f.slug, f.name]));
  // Every cohort committee whose candidate still holds the seat, by the name
  // a call list would write: "Fahey", or "Levy B" where the chamber seats two.
  const shortNames = memberShortNames(chamber.key);
  const memberNames = new Map();
  for (const filer of cohort) {
    const member = currentMemberFor(filer);
    if (member) memberNames.set(filer.slug, shortNames.get(member) || member);
  }
  // Who is left out of the ask median. Seniority and size are measured
  // against this cohort, so a caucus is judged against itself.
  const bestRecent = new Map();
  const seniorSlugs = new Set();
  for (const filer of cohort) {
    const raised = raisedBySlug.get(filer.slug) || {};
    const completed = Object.entries(raised)
      .filter(([cy, total]) => Number(cy) < cycle && total > 0);
    if (completed.length >= LIST_SENIOR_CYCLES) seniorSlugs.add(filer.slug);
    // The best of the two completed cycles, as the candidate plan measures it.
    // Only members who still hold the seat set the bar the others are judged by.
    if (memberNames.has(filer.slug)) {
      bestRecent.set(filer.slug, Math.max(...[cycle - 2, cycle - 4].map(c => raised[c] || 0)));
    }
  }
  const outsized = outsizedRaisers(bestRecent);
  const askExcluded = new Map();
  for (const filer of cohort) {
    const why = askMedianExclusion(filer,
      { senior: seniorSlugs.has(filer.slug), outlier: outsized.has(filer.slug) });
    if (why) askExcluded.set(filer.slug, why);
  }

  const totalWeight = CYCLE_WEIGHTS.reduce((s, w) => s + w, 0);
  const ranked = [];

  for (const [key, donor] of donors) {
    if (isDonorExcluded(donor.name)) continue;
    if (isCandidateCommittee(key, donor.name)) continue;

    // Per cycle: what they put in, and how many campaigns they put it into.
    const perCycle = new Map();
    const gifts = [];
    for (const [slot, amount] of donor.gifts) {
      if (!(amount > 0)) continue;
      const [slug, cyStr] = slot.split("|");
      const cy = Number(cyStr);
      if (!perCycle.has(cy)) perCycle.set(cy, { total: 0, committees: [] });
      const bucket = perCycle.get(cy);
      bucket.total += amount;
      bucket.committees.push({ filer: byName.get(slug) || slug, slug, amount });
      gifts.push({ cycle: cy, amount, weight: cycleWeight(cy, cycle), filer: byName.get(slug) || slug,
                   excluded: askExcluded.get(slug) || null });
    }
    if (perCycle.size < LIST_MIN_CYCLES) continue;

    let consistency = 0, breadth = 0, magnitude = 0;
    for (const [cy, bucket] of perCycle) {
      const w = cycleWeight(cy, cycle);
      consistency += w;
      breadth += w * bucket.committees.length;
      magnitude += w * bucket.total;
    }
    consistency /= totalWeight;
    breadth /= totalWeight;
    magnitude /= totalWeight;

    const curve = (value, full) => Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(full));
    const score = LIST_WEIGHTS.consistency * consistency
                + LIST_WEIGHTS.breadth * curve(breadth, LIST_BREADTH_FULL)
                + LIST_WEIGHTS.magnitude * curve(magnitude, LIST_MAGNITUDE_FULL);

    // The ask is what this donor gives an ordinary member: leaders and
    // outsized veterans are out of the median. A donor who gives nobody else
    // falls back to its whole history rather than losing an ask, and the row
    // records that it did.
    const ordinary = gifts.filter(g => !g.excluded);
    const askFrom = ordinary.length ? ordinary : gifts;
    const ask = weightedMedian(askFrom);
    const askLow = weightedPercentile(askFrom, 0.25);
    const askHigh = weightedPercentile(askFrom, 0.75);
    const campaigns = new Set([...donor.gifts.keys()].map(s => s.split("|")[0]));
    const cyclesGiven = [...perCycle.keys()].sort((a, b) => b - a);
    ranked.push({
      donor_key: key, donor: donor.name, donor_id: [...donor.ids][0] || null,
      ids: [...donor.ids], book_type: null,
      ask: roundAsk(ask),
      // The spread behind the ask, kept for the flat sheet; the call list
      // itself quotes one number.
      ask_low: Math.round(askLow), ask_high: Math.round(askHigh),
      ask_from: askFrom.length, ask_set_aside: gifts.length - ordinary.length,
      ask_all_leaders: !ordinary.length && gifts.length > 0,
      score: Math.round(score * 10) / 10,
      consistency, breadth, magnitude,
      cycles_given: perCycle.size,
      cycles_in_window: CYCLE_WEIGHTS.length,
      campaigns: campaigns.size,
      last_cycle: cyclesGiven[0] || null,
      per_cycle: cyclesGiven.map(cy => ({
        cycle: cy, total: perCycle.get(cy).total, committees: perCycle.get(cy).committees.length,
        top: [...perCycle.get(cy).committees].sort((a, b) => b.amount - a.amount).slice(0, 5),
        // The lobby list prints who the money went to, not just how much —
        // and only people you can still call. Money given to a member who
        // lost or retired says nothing about who to ring now.
        recipients: [...perCycle.get(cy).committees].sort((a, b) => b.amount - a.amount)
          .map(c => ({ ...c, member: memberNames.get(c.slug) || null }))
          .filter(c => c.member)
          .slice(0, LIST_RECIPIENTS_SHOWN),
      })),
      gifts,
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.ask - a.ask);

  // Organizations only, and ORESTAR's own contributor category decides it —
  // never the shape of a name. Reading that category for all 11,000 donors to
  // a chamber is seventy-odd round trips for a list of 125, so the ranking
  // comes first and categories are resolved down the ranking until the list
  // is full. A donor the resolver never gave an id has no category to read,
  // so it cannot be shown to be an organization and is left out.
  // Resolve categories down the ranking until both bands are full: the top
  // LIST_SIZE get an ask, the next tranche is context for whoever carries it.
  const organizations = [];
  let people = 0, unresolved = 0, examined = 0;
  for (let i = 0; i < ranked.length && organizations.length < LIST_CONTEXT_SIZE; i += LIST_LOOKUP_BATCH) {
    const batch = ranked.slice(i, i + LIST_LOOKUP_BATCH);
    onProgress(`Checking contributor categories — ${fmtNum(organizations.length)} organizations of `
      + `${LIST_CONTEXT_SIZE} found in the top ${fmtNum(i + batch.length)}…`);
    let bookTypes;
    try {
      bookTypes = await LOB.loadBookTypes(batch.flatMap(r => r.ids));
    } catch (e) {
      throw new Error(`Could not read contributor categories: ${e.message}`);
    }
    for (const row of batch) {
      examined++;
      const types = row.ids.map(id => bookTypes.get(id)).filter(Boolean);
      if (!types.length) { unresolved++; continue; }
      if (types.every(t => PERSON_BOOK_TYPES.has(t))) { people++; continue; }
      row.book_type = types.find(t => !PERSON_BOOK_TYPES.has(t)) || types[0];
      row.list_rank = organizations.length + 1;
      organizations.push(row);        // row.ids stays: attribution looks donors up by id
      if (organizations.length >= LIST_CONTEXT_SIZE) break;
    }
  }
  const rows = organizations.slice(0, LIST_SIZE);
  const context = organizations.slice(LIST_SIZE).map(r => ({ ...r, context: true, ask: 0 }));

  const built = {
    chamber, party, cycle, rows, context,
    considered: examined, ranked: ranked.length, committees: cohort.length,
    dropped: { people, unresolved },
    generated: new Date().toISOString(),
  };
  listCache.set(cacheKey, built);
  return built;
}

/** The sentence under a donor's name: why it is on the list. */
function listWhy(row) {
  const parts = [
    `Gave in ${row.cycles_given} of the last ${row.cycles_in_window} cycles`,
    `${fmtNum(row.campaigns)} campaign${row.campaigns === 1 ? "" : "s"} supported`,
    `${fmt$(row.magnitude)} a cycle into the chamber`,
  ];
  const recent = row.per_cycle[0];
  if (recent) {
    parts.push(`${cycleName(recent.cycle)}: ${fmt$(recent.total)} across `
      + `${recent.committees} campaign${recent.committees === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}


// ── The standing list, shaped like the lobby list ─────────────────────────
//
// The fundraising team works from a lobby list: one row per lobbyist, tier
// first, then who they are, then the asks — their donors and a number for
// each — then what those donors gave in each recent cycle. A candidate reads
// down the "Suggested asks" column and makes the calls, so the donors are
// sorted into the person who carries them rather than listed on their own.
//
// One row per lobbyist, multi-line cells inside it. A donor appears under one
// lobbyist, chosen the same way the candidate plan chooses: an admin's filing
// first, then a primary link, then a confirmed one, then the stronger match.

/** "Oregon Nurses PAC: $2,500" — one ask, one number. */
function askLine(row) {
  return `${row.donor}: ${fmt$(row.ask)}`;
}

/** The donor and the rest, kept apart so a sheet can bold the donor. */
function askParts(row) {
  return { donor: row.donor, rest: `: ${fmt$(row.ask)}` };
}

/** "Oregon Nurses PAC: $1,000 Fahey, $500 Kropf" — a cycle's giving. */
function givingLine(row, cycle) {
  const parts = givingParts(row, cycle);
  return parts ? parts.donor + parts.rest : "";
}

// A cheque far out of scale with the rest of a cycle is not a reference
// anyone can call on. UFCW Local 555 put $70,000 into Bowman in 2024 and
// again in 2026, against $5,000 and $25,000 for the next name on its list;
// quoting that invites an ask nobody is going to get.
//
// Two tests, because either alone is wrong. The ratio alone would drop
// $2,000 against $500, which is ordinary giving and a perfectly good
// reference; the size alone would drop a $15,000 gift from a donor that
// writes several. Both together find the single freak cheque and nothing
// else — 24 of 343 cycle bands on the House Democratic list.
const OUTSIZED_GIFT_RATIO = 2.5;
const OUTSIZED_GIFT_MIN = 10000;

/** One cycle's recipients, with a gift out of scale with the rest left out. */
function outsizedTrimmed(recipients) {
  const sorted = [...recipients].sort((a, b) => b.amount - a.amount);
  if (sorted.length < 2) return sorted;
  const [top, second] = sorted;
  return top.amount >= OUTSIZED_GIFT_MIN && top.amount >= OUTSIZED_GIFT_RATIO * second.amount
    ? sorted.slice(1) : sorted;
}

function givingParts(row, cycle) {
  const band = (row.per_cycle || []).find(c => c.cycle === cycle);
  if (!band || !band.recipients.length) return null;
  const shown = outsizedTrimmed(band.recipients);
  if (!shown.length) return null;
  const names = shown.map(r => `${fmt$(r.amount)} ${r.member}`).join(", ");
  // Clients from the tranche below read the same as the rest here; the donor
  // clients column is where their having no ask is said.
  return { donor: row.donor, rest: `: ${names}` };
}

/**
 * Anyone else attached to this lobbyist's donors: who they are, which of the
 * clients they are an additional contact for, and how to reach them. A name
 * on its own is not actionable — the point of the column is that you can ring
 * this person about that client.
 */
function alsoContacts(group) {
  const byLobbyist = new Map();
  for (const row of group.rows) {
    for (const a of row.also || []) {
      const id = a.lobbyist.lobbyist_id;
      if (!byLobbyist.has(id)) byLobbyist.set(id, { lobbyist: a.lobbyist, clients: [] });
      const entry = byLobbyist.get(id);
      if (!entry.clients.includes(row.donor)) entry.clients.push(row.donor);
    }
  }
  return [...byLobbyist.values()]
    .map(({ lobbyist, clients }) => ({
      name: lobbyist.name,
      clients,
      reach: [lobbyist.affiliation || lobbyist.firm, contactLine(lobbyist)].filter(Boolean).join(" · "),
    }))
    .sort((a, b) => b.clients.length - a.clients.length || a.name.localeCompare(b.name));
}

/** "Paige Spence (Oregon Nurses PAC) — Thorn Run · paige@… · 503-…" */
function alsoLine(entry) {
  const who = `${entry.name} (${entry.clients.join(", ")})`;
  return entry.reach ? `${who} — ${entry.reach}` : who;
}

/** The name apart from the rest, so a sheet can bold it. */
function alsoParts(entry) {
  const line = alsoLine(entry);
  return { donor: entry.name, rest: line.slice(entry.name.length) };
}

/**
 * The order lobbyists are worked in: tier first, then combined likelihood.
 *
 * Tier is the sort key rather than a label beside the name, so each colour
 * band runs together down the page and in the workbook instead of
 * alternating. Inside a tier, who to call first is a question about the
 * donors, so it is answered with the score that ranked them, added up across
 * everyone that lobbyist carries.
 */
function listGroupOrder(a, b) {
  return a.tier.tier - b.tier.tier || b.likelihood - a.likelihood || b.ask - a.ask;
}

/** Every client whose giving belongs in a lobbyist's columns, asked or not. */
function groupGivingRows(group) {
  return [...group.rows, ...(group.context || [])];
}

let listControlsWired = false;

/** Lobbyists for one donor on the list, primary first. */
function listLobbyistsFor(row) {
  const list = window._listAttr?.get(row.donor_key) || [];
  const includeSuggested = document.getElementById("list-include-suggested")?.checked ?? true;
  return includeSuggested ? list : list.filter(a => a.status === "confirmed");
}

/**
 * The list, grouped under the lobbyist who carries each donor. Mirrors
 * planGroups(): same ownership preference, same firm handling, same order —
 * tier, then the size of the ask.
 */
function chamberGroups() {
  const built = window._chamberList;
  if (!built) return [];
  const groups = new Map();
  const unattributed = [];
  for (const row of built.rows) {
    const list = listLobbyistsFor(row);
    let owner = list[0] ? owningFirm(list[0].lobbyist) : null;
    const firm = owner ? firmContacts(owner) : { primary: null, others: [] };
    const atFirm = new Set([firm.primary, ...firm.others].filter(Boolean).map(m => m.lobbyist_id));
    if (owner) atFirm.add(owner.lobbyist_id);
    const entry = { ...row, attribution: list[0] || null,
                    also: list.slice(1).filter(a => !atFirm.has(a.lobbyist.lobbyist_id)) };
    // Nobody to call means nothing to rank. The donor is not dropped from the
    // problem, though — it is held aside for /admin/lobbyists.
    if (!owner) { unattributed.push(entry); continue; }
    if (!groups.has(owner.lobbyist_id)) groups.set(owner.lobbyist_id, { lobbyist: owner, rows: [] });
    groups.get(owner.lobbyist_id).rows.push(entry);
  }
  window._listUnattributed = unattributed;

  // A lobbyist already on the list may also carry donors from the tranche
  // below. Those get no ask and do not move anyone up the order — they ride
  // along in the giving columns because they are part of the same call.
  for (const row of built.context || []) {
    const list = listLobbyistsFor(row);
    const owner = list[0] ? owningFirm(list[0].lobbyist) : null;
    if (!owner || !groups.has(owner.lobbyist_id)) continue;
    const group = groups.get(owner.lobbyist_id);
    (group.context ||= []).push({ ...row, attribution: list[0], also: [] });
  }

  let out = [...groups.values()];
  const q = (document.getElementById("list-search")?.value || "").trim().toLowerCase();
  if (q) {
    out = out.map(g => {
      const l = g.lobbyist;
      const members = l ? [firmContacts(l).primary, ...firmContacts(l).others].filter(Boolean) : [];
      const hit = l && [l.name, l.firm, l.affiliation, l.email, ...members.map(m => m.name)]
        .join(" ").toLowerCase().includes(q);
      const donorHit = [...g.rows, ...(g.context || [])].some(r => r.donor.toLowerCase().includes(q));
      return hit || donorHit ? g : { ...g, rows: [] };
    }).filter(g => g.rows.length);
  }
  for (const g of out) {
    g.rows.sort((a, b) => b.ask - a.ask || b.score - a.score);
    g.ask = g.rows.reduce((s, r) => s + r.ask, 0);
    if (g.context) g.context.sort((a, b) => b.score - a.score);
    // Who to call first is a question about the donors, so it is answered
    // with the score that ranked them: consistency, breadth and size through
    // the recency window. A lobbyist's standing is their clients' added up —
    // six likely donors are a better morning than one.
    g.likelihood = Math.round(g.rows.reduce((s, r) => s + r.score, 0) * 10) / 10;
    g.tier = lobbyistTier(g.rows.map(r => ({
      given: 0, cycles: {},
      comp_gifts: r.per_cycle.flatMap(c => c.recipients.map(x => ({ filer: x.filer, amount: x.amount }))),
    })));
  }
  out.sort(listGroupOrder);
  return out;
}

/** Look up who lobbies for each donor on the list. */
async function loadChamberAttribution(built) {
  window._listAttr = null;
  window._listIdentityIds = new Map();
  try {
    if (!lobbyistsById) {
      lobbyistsById = new Map((await LOB.loadLobbyists())
        .map(l => [l.lobbyist_id, { ...l, name: donorDisplayName(l.name) }]));
    }
    if (typeof LP !== "undefined") LP.load().catch(() => {});
    // Both bands: the tranche below the top LIST_SIZE needs looking up too,
    // or no lobbyist can ever be shown to carry one of them.
    const rows = [...built.rows, ...(built.context || [])]
      .flatMap(r => (r.ids || [r.donor_id]).filter(Boolean)
        .map(id => ({ name: r.donor, donor_id: id, key: r.donor_key })));
    const { byKey } = await LOB.planAttribution(rows, lobbyistsById);
    window._listAttr = byKey;
  } catch (e) {
    console.warn("Lobbyist attribution unavailable for the standing list:", e);
    window._listAttr = new Map();
    throw e;
  }
}

function initChamberList() {
  const chamberSel = document.getElementById("list-chamber");
  const partySel = document.getElementById("list-party");
  const cycleSel = document.getElementById("list-cycle");
  if (!chamberSel || !partySel || !cycleSel) return;

  chamberSel.innerHTML = LIST_CHAMBERS.map(c => `<option value="${c.key}">${c.label}</option>`).join("");
  partySel.innerHTML = LIST_PARTIES.map(p => `<option value="${p.key}">${p.label}</option>`).join("");
  const cur = currentCycle();
  for (let c = cur; c >= 2010; c -= 2) {
    cycleSel.insertAdjacentHTML("beforeend",
      `<option value="${c}"${c === cur ? " selected" : ""}>${cycleName(c)}</option>`);
  }
  document.getElementById("list-run-btn").addEventListener("click", runChamberList);
  for (const [id, fmt, scope] of [["list-export-csv", "csv", "one"], ["list-export-xlsx", "xlsx", "one"],
                                  ["list-export-all-xlsx", "xlsx", "all"]]) {
    document.getElementById(id).addEventListener("click", () => exportChamberList(fmt, scope));
  }
}

function wireListControls() {
  if (listControlsWired) return;
  listControlsWired = true;
  document.getElementById("list-search").addEventListener("input", renderChamberRows);
  document.getElementById("list-include-suggested").addEventListener("change", renderChamberRows);
}

async function runChamberList() {
  const button = document.getElementById("list-run-btn");
  const chamberKey = document.getElementById("list-chamber").value;
  const partyKey = document.getElementById("list-party").value;
  const cycle = parseInt(document.getElementById("list-cycle").value, 10);
  button.disabled = true;
  try {
    const built = await buildChamberList(chamberKey, partyKey, cycle, msg => showStatus(msg, "loading"));
    window._chamberList = built;
    wireListControls();
    showStatus("Looking up lobbyists…", "loading");
    const status = document.getElementById("list-status");
    try {
      await loadChamberAttribution(built);
      status.textContent = "";
    } catch (e) {
      status.textContent = `Lobbyist attribution is unavailable (${e.message}). `
        + "Donors are listed without a lobbyist.";
    }
    hideStatus();
    renderChamberList(built);
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
    console.error(err);
  } finally {
    button.disabled = false;
  }
}

// Donors nobody carries are not ranked, but they are the whole reason to open
// /admin/lobbyists, so the list leaves them where that page can pick them up.
// Per-browser and plainly labelled with when it was written — this is a note
// to the person who builds the list, not a record anyone else depends on.
const LIST_UNATTRIBUTED_KEY = "orestar.unattributedTopDonors.v1";

function recordUnattributed(built, rows) {
  try {
    const store = JSON.parse(localStorage.getItem(LIST_UNATTRIBUTED_KEY) || "{}");
    store[`${built.chamber.key}|${built.party.short}|${built.cycle}`] = {
      chamber: built.chamber.label, party: built.party.label, cycle: built.cycle,
      built_at: new Date().toISOString(),
      donors: rows.map(r => ({ donor_id: r.donor_id, ids: r.ids || [], donor: r.donor,
                               ask: r.ask, score: r.score,
                               rank: built.rows.findIndex(x => x.donor_key === r.donor_key) + 1 })),
    };
    localStorage.setItem(LIST_UNATTRIBUTED_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn("Could not record unattributed donors for the admin page:", e.message);
  }
}

function renderChamberList(built) {
  document.getElementById("list-results").hidden = false;
  document.getElementById("list-title").textContent =
    `${listTitle(built.chamber, built.party, built.cycle)} — top ${built.rows.length} organizations`;
  const asks = built.rows.map(r => r.ask).sort((a, b) => a - b);
  const attributed = built.rows.filter(r => listLobbyistsFor(r).length).length;
  document.getElementById("list-summary").innerHTML = `
    <div class="summary-card"><span class="sc-label">Total of the asks
      <span class="sc-help" title="Every donor's suggested ask added up — one ask each, for one candidate.">?</span></span><br>
      <span class="sc-value">${fmt$(built.rows.reduce((s, r) => s + r.ask, 0))}</span>
      <div class="sc-sub">one candidate, one ask each</div></div>
    <div class="summary-card"><span class="sc-label">Middle ask
      <span class="sc-help" title="The middle donor's suggested ask: the recency-weighted median of what it gives one candidate of this kind across a cycle.">?</span></span><br>
      <span class="sc-value">${fmt$(percentile(asks, 0.5))}</span>
      <div class="sc-sub">${fmt$(asks[0])} to ${fmt$(asks[asks.length - 1])} across the list</div></div>
    <div class="summary-card sc-muted"><span class="sc-label">Not ranked
      <span class="sc-help" title="Donors with nobody on file to call. They are left out of the ranking and listed below, and flagged on the Unmatched donors tab at /admin/lobbyists.">?</span></span><br>
      <span class="sc-value">${fmtNum(built.rows.length - attributed)}</span>
      <div class="sc-sub">of ${fmtNum(built.rows.length)} donors have no lobbyist ·
        assign them at <a href="/admin/lobbyists">/admin/lobbyists</a></div></div>
    <div class="summary-card sc-muted"><span class="sc-label">Drawn from</span><br>
      <span class="sc-value">${fmtNum(built.committees)}</span>
      <div class="sc-sub">${built.party.label} ${built.chamber.label} committees ·
        ${fmtNum(built.ranked)} donors ranked</div></div>`;
  renderChamberRows();
}

/** The donors nobody carries: listed, not ranked, and handed to the admin. */
function renderUnranked() {
  const box = document.getElementById("list-unranked");
  const built = window._chamberList;
  const rows = window._listUnattributed || [];
  if (!box || !built) return;
  recordUnattributed(built, rows);
  if (!rows.length) { box.hidden = true; return; }
  box.hidden = false;
  const total = rows.reduce((sum, r) => sum + r.ask, 0);
  box.innerHTML = `
    <h4>Not ranked — nobody on file to call <span class="list-unranked-count">${rows.length} donors ·
      ${fmt$(total)} of asks</span></h4>
    <p class="section-desc">These gave enough to make the top ${built.rows.length}, but there is no
      lobbyist attached, so they are left out of the order above. They are flagged on the
      <a href="/admin/lobbyists">Unmatched donors</a> tab, newest build first.</p>
    <div class="list-unranked-rows">${[...rows].sort((a, b) => b.ask - a.ask).map(r =>
      `<div class="list-unranked-row"><strong>${esc(r.donor)}</strong>: ${fmt$(r.ask)}</div>`).join("")}</div>`;
}

function renderChamberRows() {
  const built = window._chamberList;
  const tbody = document.getElementById("list-tbody");
  if (!built || !tbody) return;
  const groups = chamberGroups();
  document.getElementById("list-count").textContent =
    `${groups.filter(g => g.lobbyist).length} lobbyists · `
    + `${groups.reduce((s, g) => s + g.rows.length, 0)} donors`;
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="plan-empty">No lobbyists or donors match.</td></tr>';
    return;
  }
  const cycles = [built.cycle, built.cycle - 2];
  tbody.innerHTML = groups.map(g => {
    const l = g.lobbyist;
    const who = l ? lobbyistHeader(l)
      : `<div class="plan-lobbyist plan-none">No lobbyist on file</div>
         <div class="plan-contact">Assign these at <a href="/admin/lobbyists">/admin/lobbyists</a></div>`;
    const byClient = g.rows.map(r => `<div class="list-ask"><strong>${esc(r.donor)}</strong>: ${
      fmt$(r.ask)}</div>`).join("");
    const donors = g.rows.map(r => esc(r.donor)).join("; ")
      + (g.context?.length
        ? `<div class="list-also-represents">also represents: ${
            esc(g.context.map(r => r.donor).join("; "))}</div>` : "");
    const giving = cy => groupGivingRows(g).map(r => {
      const parts = givingParts(r, cy);
      return parts ? `<div class="list-giving"><strong>${esc(parts.donor)}</strong>${
        esc(parts.rest)}</div>` : "";
    }).join("");
    return `<tr class="list-row">
      <td class="plan-tier-cell">${l ? tierChip(g.tier) : ""}</td>
      <td class="list-who">${who}${(also => also.length
        ? `<div class="list-also"><span class="list-also-head">also lobbied by</span>${also.map(a =>
            `<div class="list-also-row"><strong>${esc(a.name)}</strong>
               <span class="list-also-for">(${esc(a.clients.join(", "))})</span>
               ${a.reach ? `<span class="list-also-reach">${esc(a.reach)}</span>` : ""}</div>`).join("")}</div>`
        : "")(alsoContacts(g))}</td>
      <td class="list-asks">${byClient}</td>
      <td class="list-donors">${donors}</td>
      <td class="list-giving-cell">${giving(cycles[0])}</td>
      <td class="list-giving-cell">${giving(cycles[1])}</td>
    </tr>`;
  }).join("");
  document.getElementById("list-cycle-head-0").textContent = `${cycleName(cycles[0])} giving`;
  document.getElementById("list-cycle-head-1").textContent = `${cycleName(cycles[1])} giving`;
  renderUnranked();
}

// ── The standing list as a file ───────────────────────────────────────────
//
// Column for column the shape of the lobby list the team already works from:
// tier, portrait, name, the asks, the clients, then a column of giving per
// cycle, then how to reach them. One row per lobbyist.

/** A lobbyist's name split the way the lobby list splits it. */
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts.length < 2 ? { first: parts[0] || "", last: "" }
                          : { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

const LIST_SHEET_CYCLES = 3;          // cycles of giving printed, newest first

/** Header labels, left to right, for a built list. */
function listSheetHeaders(built) {
  const cycles = Array.from({ length: LIST_SHEET_CYCLES }, (_, i) => built.cycle - 2 * i);
  const labels = ["Tier", "Photo", "First Name", "Last Name",
                  `Suggested Ask ${built.cycle} by client`, "Donor clients",
                  ...cycles.map(c => `${cycleName(c)} giving`),
                  "Also lobbied by", "Firm", "Email", "Cell", "Work"];
  // Column numbers are read off the labels rather than counted by hand: the
  // writer addresses cells one-based, and an off-by-one silently overwrites
  // the neighbouring column.
  const at = label => labels.indexOf(label) + 1;
  return {
    cycles, labels,
    byClientCol: at(`Suggested Ask ${built.cycle} by client`),
    givingFrom: at(`${cycleName(cycles[0])} giving`),
    alsoCol: at("Also lobbied by"),
    // Money columns are the ones the fundraiser reads; the rest are contact.
    moneyFrom: 4, moneyTo: 6 + cycles.length,
  };
}

/** One row per lobbyist, in call order. */
function listSheetRows(built, groups) {
  const { cycles, byClientCol, givingFrom, alsoCol } = listSheetHeaders(built);
  return groups.map(g => {
    const l = g.lobbyist;
    const contact = l ? planContact(l) : { name: "", email: "", phone: "", others: "" };
    const { first, last } = splitName(contact.name || (l ? l.name : ""));
    return {
      tier: l ? g.tier.label : "",
      person: portraitPerson(l),
      // Cells that name donors are kept as {donor, rest} pairs so the writer
      // can bold the donor — a call list is read by eye, down the column.
      rich: { [byClientCol]: g.rows.map(askParts),
              [alsoCol]: alsoContacts(g).map(alsoParts),
              ...Object.fromEntries(cycles.map((c, i) =>
                [givingFrom + i, groupGivingRows(g).map(r => givingParts(r, c)).filter(Boolean)])) },
      cells: [
        l ? g.tier.label : "",
        "",                                   // the portrait is drawn into this cell
        l ? first : "No lobbyist on file",
        l ? last : "",
        g.rows.map(askLine).join("\n"),
        [g.rows.map(r => r.donor).join("; "),
         ...(g.context?.length ? [`also represents: ${g.context.map(r => r.donor).join("; ")}`] : []),
        ].join("\n"),
        ...cycles.map(c => groupGivingRows(g).map(r => givingLine(r, c)).filter(Boolean).join("\n")),
        alsoContacts(g).map(alsoLine).join("\n"),
        l ? (l.kind === "firm" ? l.name : l.affiliation || l.firm || "") : "",
        contact.email || "",
        l && l.kind !== "firm" ? l.phone || "" : contact.phone || "",
        contact.others || "",
      ],
    };
  });
}

/** The flat one-row-per-donor table, for pivoting. */
function chamberListRows(built) {
  const byDonor = new Map();
  for (const g of chamberGroups()) {
    for (const r of g.rows) byDonor.set(r.donor_key, { group: g, row: r });
  }
  return built.rows.map((r, i) => {
    const hit = byDonor.get(r.donor_key);
    const l = hit?.group.lobbyist;
    return {
      "Rank": i + 1,
      "Donor": r.donor,
      "Suggested Ask": r.ask,
      "Ask Low": r.ask_low,
      "Ask High": r.ask_high,
      "Ask From": r.ask_from,
      "Leaders Set Aside": r.ask_set_aside,
      "Ask Note": r.ask_all_leaders ? "gives only leaders — priced on all of its giving" : "",
      "Lobbyist": l ? (planContact(l).name || l.name) : "",
      "Tier": l ? hit.group.tier.label : "",
      "Category": r.book_type || "",
      "Chamber": built.chamber.label,
      "Party": built.party.label,
      "Score": r.score,
      "Cycles Given": `${r.cycles_given} of ${r.cycles_in_window}`,
      "Campaigns Supported": r.campaigns,
      "Campaigns Per Cycle": Math.round(r.breadth * 10) / 10,
      "Given Per Cycle": Math.round(r.magnitude),
      "Last Cycle Given": r.last_cycle ? cycleName(r.last_cycle) : "",
      "Largest Recipients Last Cycle": (r.per_cycle[0]?.top || [])
        .map(t => `${t.filer} (${fmt$(t.amount)})`).join("; "),
      "Why On The List": listWhy(r),
    };
  });
}

function chamberMethodRows(built) {
  return [
    { Item: "List", Value: listTitle(built.chamber, built.party, built.cycle),
      Detail: `Top ${built.rows.length} organizations, drawn from ${fmtNum(built.committees)} candidate `
        + `committees that raised at least ${fmt$(LIST_MIN_RAISED)}. ${fmtNum(built.ranked)} donors were `
        + `scored and the top ${fmtNum(built.considered)} checked against ORESTAR's contributor category `
        + "until the list was full." },
    { Item: "Suggested ask", Value: "median gift to one candidate, one cycle",
      Detail: `Contributions to the same candidate inside a cycle are added up first, so instalments read `
        + `as one relationship. The median across those relationships is weighted by how recent each is, `
        + `then rounded: to the nearest ${fmt$(LIST_ASK_SMALL_STEP)} below ${fmt$(LIST_ASK_SMALL_BELOW)} `
        + `and to the nearest ${fmt$(LIST_ASK_STEP)} above it, never below ${fmt$(LIST_ASK_FLOOR)}. `
        + `A small ask has to stay small: a donor whose giving sits at ${fmt$(LIST_ASK_FLOOR)} is asked `
        + `that, not rounded up for tidiness.` },
    { Item: "Recency weights", Value: CYCLE_WEIGHTS.join(" · "),
      Detail: `Weight by cycles ago, newest first. The first `
        + `${CYCLE_WEIGHTS.filter(w => w === 1).length} count in full; giving older than `
        + `${CYCLE_WEIGHTS.length} cycles is outside the window entirely.` },
    { Item: "Window", Value: CYCLE_WEIGHTS.map((_, i) => cycleName(built.cycle - 2 * i)).join(", "),
      Detail: "The cycles the list is built from." },
    { Item: "Score", Value: "0–100",
      Detail: `${LIST_WEIGHTS.consistency} × consistency (weighted share of those cycles with a gift) + `
        + `${LIST_WEIGHTS.breadth} × breadth (campaigns per cycle, full marks at ${LIST_BREADTH_FULL}) + `
        + `${LIST_WEIGHTS.magnitude} × size (given per cycle, full marks at ${fmt$(LIST_MAGNITUDE_FULL)}). `
        + "Breadth and size are logarithmic: the step from 2 campaigns to 6 counts for more than 26 to 30." },
    { Item: "Who is on it", Value: "organizations",
      Detail: `ORESTAR's own contributor category decides it, never the shape of a name. Among the donors `
        + `checked, ${fmtNum(built.dropped.people)} individuals and candidate families were dropped and `
        + `${fmtNum(built.dropped.unresolved)} had no resolved identity to read a category from. `
        + `A donor must also have given in at least ${LIST_MIN_CYCLES} cycles in the window.` },
    { Item: "Who sets the ask", Value: "ordinary members",
      Detail: "The median leaves out giving to the Speaker, the Senate President, the Majority and "
        + "Minority Leaders and the Ways and Means Co-Chairs, and to a senior member who both holds a "
        + "leadership post or a committee gavel and raises far above the rest of the caucus (above "
        + `Q3 + 1.5 × IQR of what its members raised in the two completed cycles; senior means `
        + `${LIST_SENIOR_CYCLES} or more completed cycles of giving). They are given money on a scale a `
        + "first call will not match. They keep their place in the giving columns and still count "
        + "toward a donor's breadth, consistency and size — only the median leaves them out. A donor "
        + "that gives nobody else is priced on its whole history, and its row says so." },
    { Item: "Clients with no ask", Value: `ranked ${LIST_SIZE + 1}–${LIST_CONTEXT_SIZE}`,
      Detail: `A lobbyist already on the list may also carry donors from the tranche below the top `
        + `${LIST_SIZE}. Those appear in the giving columns and under "also represents" in the donor `
        + `clients column, because they are part of the same call — but they carry no suggested ask, `
        + `and they do not count toward the lobbyist's tier or their place in the order.` },
    { Item: "Who carries a donor", Value: "one lobbyist per donor",
      Detail: "An admin's filing at /admin/lobbyists wins, then a link marked primary, then a confirmed "
        + "link over an unreviewed one, then the stronger match — the same order the candidate plan uses. "
        + "Anyone else attached to the donor is listed under \u2018Also lobbied by\u2019, with the "
        + "clients they are an additional contact for in brackets and their firm, email and phone." },
    { Item: "Row order", Value: "tier, then combined client likelihood",
      Detail: "Rows are grouped by tier, so each colour band runs together down the sheet. Inside a "
        + "tier the order is the donor scores of everyone that lobbyist carries, added up: who to "
        + "call first is a question about the donors, and six likely ones are a better morning than "
        + "one, so the total rather than the average." },
    { Item: "Tier", Value: "1–4, all computed",
      Detail: "6 × donors carried (max 30) + 2 × like candidates their donors support (max 30) + what "
        + "those donors gave them ÷ 5,000 (max 20). The candidate plan's two remaining bonuses need a "
        + "single committee to have given to, so they do not apply here." },
    { Item: "Giving history", Value: "sitting members only",
      Detail: "The giving columns name only members who currently hold the seat, checked against the "
        + "chamber roster in docs/assets/current_legislators.json. Money given to someone who lost or "
        + "retired is no guide to who to ring now. Candidates read as a surname, or a surname and first "
        + "initial where the chamber seats two of them." },
    { Item: "Outsized gifts", Value: `dropped above ${fmt$(OUTSIZED_GIFT_MIN)} and `
        + `${OUTSIZED_GIFT_RATIO}\u00d7 the next gift`,
      Detail: "A cheque far out of scale with everything else a donor wrote that cycle is left out of "
        + "the giving columns: it is not a number a caller can open on. UFCW Local 555 put $70,000 into "
        + "one member in 2024 and again in 2026, against $5,000 and $25,000 for the next name on its "
        + "list. Both tests have to hold — far larger than the second largest, and large in itself — so "
        + `${fmt$(2000)} against ${fmt$(500)} stays, being ordinary giving. The gift still counts `
        + "toward the donor's score, its tier and its suggested ask, and the per-donor sheet still "
        + "reports it under Largest Recipients Last Cycle." },
    { Item: "What it is not", Value: "not a plan for one candidate",
      Detail: "No seat, no margin, no relationship with a particular committee is in these numbers. "
        + "For a named candidate, use the candidate view — it benchmarks against comparable seats and "
        + "subtracts what the donor has already given." },
  ];
}

/** Sheet 1: the lobby list itself, styled to be read rather than pivoted. */
async function writeListSheet(wb, built, groups, imageCache) {
  const { labels, cycles, moneyFrom, moneyTo } = listSheetHeaders(built);
  const ws = wb.addWorksheet(`${built.chamber.label} ${built.party.short}`,
    { views: [{ state: "frozen", ySplit: 2, xSplit: 4 }] });

  const title = ws.addRow([`${listTitle(built.chamber, built.party, built.cycle)} — who to call, and for how much`]);
  title.font = { bold: true, size: 13 };
  ws.mergeCells(1, 1, 1, labels.length);

  const header = ws.addRow(labels);
  header.height = 28;
  labels.forEach((_, i) => {
    const cell = header.getCell(i + 1);
    styleHeaderCell(cell, { center: i < 2 });
    // The lobby list colours the money columns apart from the contact ones.
    if (i < moneyFrom || i >= moneyTo) cell.fill =
      { type: "pattern", pattern: "solid", fgColor: { argb: INK.contact } };
  });

  const rows = listSheetRows(built, groups);
  for (const entry of rows) {
    const row = ws.addRow(entry.cells);
    row.alignment = { vertical: "top", wrapText: true };
    const lines = Math.max(...entry.cells.map(c => String(c || "").split("\n").length), 1);
    row.height = Math.max(84, Math.min(320, lines * 14 + 8));
    const tierCell = row.getCell(1);
    const fill = tierFill(entry.tier);
    if (fill) tierCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    tierCell.font = { bold: true, size: 18 };
    tierCell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    // Donor names in bold, so a column of them can be scanned.
    for (const [column, parts] of Object.entries(entry.rich)) {
      if (!parts.length) continue;
      row.getCell(Number(column)).value = { richText: parts.flatMap((part, i) => [
        ...(i ? [{ text: "\n" }] : []),
        { font: { bold: true }, text: part.donor },
        { text: part.rest },
      ]) };
    }
    if (entry.person) await addPortrait(wb, ws, entry.person, row.number, 2, imageCache);
  }

  const widths = [8, 13, 14, 16, 36, 34, ...cycles.map(() => 46), 52, 24, 30, 16, 16];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: labels.length } };
  return ws;
}

async function exportChamberList(format, scope) {
  const built = window._chamberList;
  if (!built) return;
  const stamp = `${built.chamber.key}_${built.party.short.toLowerCase()}_${built.cycle}`;

  if (format === "csv") {
    const rows = chamberListRows(built);
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","), ...rows.map(row => headers.map(h => {
      const v = String(row[h] ?? "");
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(","))].join("\n");
    downloadFile(csv, `top_donors_${stamp}.csv`, "text/csv");
    return;
  }

  const button = document.getElementById(scope === "all" ? "list-export-all-xlsx" : "list-export-xlsx");
  button.disabled = true;
  try {
    const ExcelJS = await loadExcelJs();
    const builds = [{ built, groups: chamberGroups() }];
    if (scope === "all") {
      const current = window._chamberList, currentAttr = window._listAttr;
      for (const chamber of LIST_CHAMBERS) {
        for (const party of LIST_PARTIES) {
          if (chamber.key === current.chamber.key && party.key === current.party.key) continue;
          showStatus(`Building ${chamber.label} ${party.label}…`, "loading");
          const other = await buildChamberList(chamber.key, party.key, current.cycle,
            msg => showStatus(`${chamber.label} ${party.label}: ${msg}`, "loading"));
          window._chamberList = other;
          await loadChamberAttribution(other).catch(() => {});
          builds.push({ built: other, groups: chamberGroups() });
        }
      }
      window._chamberList = current;
      window._listAttr = currentAttr;
      builds.sort((a, b) => a.built.chamber.label.localeCompare(b.built.chamber.label)
        || a.built.party.label.localeCompare(b.built.party.label));
      hideStatus();
    }

    const wb = new ExcelJS.Workbook();
    const imageCache = new Map();
    for (const b of builds) await writeListSheet(wb, b.built, b.groups, imageCache);
    for (const b of builds) {
      writeTable(wb, `${b.built.chamber.label} ${b.built.party.short} donors`, chamberListRows(b.built),
        { money: ["Suggested Ask", "Ask Low", "Ask High", "Given Per Cycle"],
          note: "One row per donor — the sheet to pivot." });
    }
    writeTable(wb, "How these were set", builds.flatMap(b => chamberMethodRows(b.built)),
      { widths: { Detail: 120 } });
    const buffer = await wb.xlsx.writeBuffer();
    downloadFile(new Blob([buffer],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      scope === "all" ? `top_donors_all_${built.cycle}.xlsx` : `top_donors_${stamp}.xlsx`);
  } catch (err) {
    console.error(err);
    showStatus(`Could not build the file: ${err.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function exportData(format, scope = "new", waited = false) {
  // Lobbyists load a few seconds after the plan does. An export before then
  // filed every donor under "nobody on file" in one collapsed group: a call
  // list that opened looking empty. Wait for them, once.
  if (scope === "lobbyist" && !window._lobbyAttr && window._lobbyPlanLoad && !waited) {
    const status = document.getElementById("plan-status");
    if (status) status.textContent = "Waiting for lobbyist attribution before exporting…";
    window._lobbyPlanLoad.then(() => exportData(format, scope, true));
    return;
  }
  if (scope === "lobbyist" && window._lobbyAttrError
      && !confirm(`Lobbyist attribution is unavailable (${window._lobbyAttrError}). Export anyway, with every donor under "no lobbyist"?`)) return;
  const recs = window._recommendations || [];
  const repeats = window._repeatTargets || [];
  const target = window._targetProfile;
  const cycle = window._cycle;
  const cycleLabel = cycle ? `${cycle - 1}-${cycle}` : "";

  const repeatRows = repeats.map(r => ({
    "Type": "Donor Target",
    "Donor Name": r.donor,
    "Lobbyist": lobbyistNames(r),
    "Filer": target ? target.name : "",
    "Cycle": cycleLabel,
    "Score": "",
    "Tier": r.consistency === "high" ? "High" : r.consistency === "medium" ? "Med" : "Low",
    "Previous Cycles": r.prev_cycles,
    "Last Cycle Amount": r.last_cycle_amt,
    "Comparable Max": r.comp_max || "",
    "Target Ask": r.target,
    "Already Given This Cycle": r.current_cycle_amt,
    "Remaining Ask": r.remaining,
    "History": r.history.join("; "),
    "Notes": r.factors.join("; "),
  }));

  const newRows = recs.map(r => ({
    "Type": "New Prospect",
    "Donor Name": r.donor,
    "Lobbyist": lobbyistNames(r),
    "Filer": target ? target.name : "",
    "Cycle": cycleLabel,
    "Score": r.score,
    "Previous Cycles": "",
    "Last Cycle Amount": "",
    "Comparable Max": r.comp_max,
    "Target Ask": r.target_ask,
    "Already Given This Cycle": r.already_given,
    "Remaining Ask": r.remaining_ask,
    "History": r.comp_gifts.map(g => g.filer).join("; "),
    "Notes": r.why_summary,
  }));

  let exportRows;
  let fileLabel;
  if (scope === "lobbyist") {
    exportRows = lobbyistPlanExportRows();
    fileLabel = "lobbyist_plan";
  } else if (scope === "repeat") {
    exportRows = [...repeatRows, ...newRows];
    fileLabel = "donor_targets";
  } else if (scope === "new") {
    exportRows = newRows;
    fileLabel = "new_prospects";
  } else {
    // full: repeat donors first, then new prospects
    exportRows = [...repeatRows, ...newRows];
    fileLabel = "full_plan";
  }

  if (!exportRows.length) {
    alert("No data to export.");
    return;
  }

  if (format === "csv") {
    const headers = Object.keys(exportRows[0] || {});
    const csv = [
      headers.join(","),
      ...exportRows.map(row =>
        headers.map(h => {
          const v = String(row[h] ?? "");
          return v.includes(",") || v.includes('"') || v.includes("\n")
            ? `"${v.replace(/"/g, '""')}"`
            : v;
        }).join(",")
      ),
    ].join("\n");

    downloadFile(csv, `${fileLabel}_${target.slug}_${cycle}.csv`, "text/csv");

  } else if (format === "xlsx") {
    if (typeof XLSX === "undefined") {
      alert("Excel export library not loaded. Please try CSV instead.");
      return;
    }
    const wb = XLSX.utils.book_new();
    if (scope === "full") {
      // Separate sheets for repeat and new
      if (repeatRows.length) {
        const ws1 = XLSX.utils.json_to_sheet(repeatRows);
        XLSX.utils.book_append_sheet(wb, ws1, "Donor Targets");
      }
      if (newRows.length) {
        const ws2 = XLSX.utils.json_to_sheet(newRows);
        XLSX.utils.book_append_sheet(wb, ws2, "New Prospects");
      }
    } else if (scope === "lobbyist") {
      // A formatted workbook of its own (see writeCallList): frozen headers,
      // tier shading, currency. Asynchronous because the formatter loads on
      // demand; failures fall back to telling the user rather than a silent
      // empty download.
      exportLobbyistWorkbook(planGroups(), cycle, `${fileLabel}_${target.slug}_${cycle}.xlsx`)
        .catch(err => {
          console.error(err);
          alert(`Could not build the Excel file: ${err.message}. The CSV button still works.`);
        });
      return;
    } else {
      const ws = XLSX.utils.json_to_sheet(exportRows);
      XLSX.utils.book_append_sheet(wb, ws, scope === "repeat" ? "Donor Targets" : "New Prospects");
    }
    XLSX.writeFile(wb, `${fileLabel}_${target.slug}_${cycle}.xlsx`);
  }
}

function downloadFile(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

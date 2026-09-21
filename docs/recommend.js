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
    ids.filter(Boolean).forEach(id => filers.set(String(id), c));
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
    const ids = [...keysById.keys()].filter(id => !existing.has(keysById.get(id)) && breadth.get(keysById.get(id)) > 1);
    for (let i = 0; i < ids.length; i += 150) {
      const data = await LOB.fetchAll(() => sb.rpc("recommendation_first_gifts", {
        p_donor_ids: ids.slice(i, i + 150), p_filer_ids: [...filers.keys()], p_through: `${cycle}-12-31`,
      }));
      for (const r of data || []) {
        const key = keysById.get(r.donor_id), comp = filers.get(String(r.filer_id));
        if (!comp) continue;
        const pair = `${key}|${comp.slug}`;
        const prior = earliest.get(pair);
        if (!prior || r.first_date < prior.first_date || (r.first_date === prior.first_date && Number(r.amount) < prior.amount)) {
          earliest.set(pair, { key, first_date: r.first_date, amount: Number(r.amount),
            filer: comp.name, marginPts: comp.seat?.margin_pts ?? null });
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
function isDonorExcluded(name) {
  return EXCLUDED_DONORS.has(name.toLowerCase().trim());
}

async function runRecommendations() {
  const filer = window._getSelectedFiler();
  if (!filer) return;

  const cycle = parseInt(document.getElementById("cycle-select").value);
  const years = cycleYears(cycle).map(String);
  window._targetFiler = filer;   // chamber/party for partner designations

  document.getElementById("run-btn").disabled = true;
  showStatus("Finding comparable fundraisers…", "loading");

  try {
    // 1. Load the target filer's profile
    const targetProfile = await loadFilerProfile(filer.slug);

    // 2. Find comparable filers
    const comparables = await findComparables(targetProfile, filer, cycle);
    showStatus(`Loading donor data for ${comparables.length} comparable filers…`, "loading");

    // 3. Load profiles for all comparables
    const compProfiles = await Promise.all(
      comparables.map(c => loadFilerProfile(c.slug))
    );

    // Cached profiles may be rebuilt from raw labels between resolver runs.
    // Repair missing identities from the same scoped donor query as Donor Lookup
    // before scoring, classifying repeat donors, or building export history.
    await loadRecommendationIdentities([targetProfile, ...compProfiles], [filer, ...comparables]);

    showStatus("Combining donor identities…", "loading");
    await loadPlanningKeys([targetProfile, ...compProfiles]);

    showStatus("Checking first-time giving…", "loading");
    await loadFirstGifts([targetProfile, ...compProfiles], comparables, compProfiles, cycle);

    // 4. Build repeat donor targets (existing donors to THIS filer)
    showStatus("Analyzing repeat donors…", "loading");
    targetProfile._leadershipTier = filer.leadership_tier || 0;
    const targetSeat = seatCompetitiveness(filer);
    const { targets: repeatTargets, notRecommended: repeatNotRec } = buildRepeatDonorTargets(targetProfile, comparables, compProfiles, years, cycle, targetSeat);

    // 5. Build new donor scoring
    showStatus("Scoring new donors…", "loading");
    const { prospects: recommendations, notRecommended: prospectNotRec } = scoreDonors(targetProfile, comparables, compProfiles, years, cycle, targetSeat);
    const allNotRecommended = [...repeatNotRec, ...prospectNotRec];

    // 6. Display results, with what seats of this closeness actually raise
    window._compCycles = buildCompCycleIndex(comparables, compProfiles);
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
 * - state_rep ↔ state_senate: always comparable (bidirectional)
 * - legislative → statewide: comparable (donors flow up)
 * - statewide → legislative: NOT comparable (donors don't flow down)
 * - same office: always comparable
 */
function isOfficeComparable(targetOffice, fOffice) {
  if (!targetOffice || !fOffice) return false;
  if (targetOffice === fOffice) return true;
  // state_rep ↔ state_senate: bidirectional
  if (LEGISLATIVE_OFFICES.has(targetOffice) && LEGISLATIVE_OFFICES.has(fOffice)) return true;
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

/**
 * The subset of a donor's comparable gifts made in seats about as contested
 * as the target's, using the narrowest window that holds enough of them.
 * Returns null when the target seat has no margin on record, or when even the
 * widest window is too thin to say anything.
 */
function peerMarginGifts(gifts, targetMargin) {
  if (targetMargin == null) return null;
  for (const window of PEER_WINDOWS) {
    const peers = gifts.filter(g => g.marginPts != null && Math.abs(g.marginPts - targetMargin) <= window);
    if (peers.length >= MIN_PEER_GIFTS) return { gifts: peers, window };
  }
  return null;
}

/** "Friends of X (0.8 pt margin): $2,500" — a gift behind a benchmarked ask. */
function peerGiftLabel(g) {
  return `${g.filer} (${g.marginPts != null ? `${g.marginPts.toFixed(1)} pt margin` : "no margin"}): ${fmt$(g.amount)}`;
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

async function findComparables(targetProfile, targetFiler, cycle) {
  await loadRaceMargins();
  const targetSeat = seatCompetitiveness(targetFiler);
  if (targetSeat) {
    console.log(`[recommend] target seat: ${targetSeat.label} (${targetSeat.year})`);
  }
  const officeType = getOffice(targetFiler);
  const party = getParty(targetFiler);
  const chamber = getChamber(targetFiler);
  const targetTier = targetFiler.leadership_tier || 0;
  const isTargetLeadership = targetTier > 0;

  console.log(`[recommend] Target: office=${officeType}, party=${party}, chamber=${chamber}, leadership_tier=${targetTier}`);

  const scored = [];

  for (const f of filerIndex) {
    if (f.slug === targetFiler.slug) continue;

    // Must have some fundraising activity
    if (f.total_in < 100) continue;

    const fOffice = getOffice(f);
    const fParty = getParty(f);
    const fChamber = getChamber(f);
    const fTier = f.leadership_tier || 0;

    // Party filter: if target has a known party, SKIP filers from other parties.
    // PACs/committees without party affiliation are allowed through.
    if (party && fParty && fParty !== party) continue;

    let similarity = 0;

    // Office comparability (asymmetric: legislative → statewide but not reverse)
    if (officeType && fOffice) {
      if (officeType === fOffice) {
        similarity += 40;  // Exact same office
      } else if (isOfficeComparable(officeType, fOffice)) {
        similarity += 30;  // state_rep ↔ state_senate or legislative → statewide
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
    const fTags = adminTags[f.slug] || [];
    if (fTags.some(t => t.tag === "exclude")) continue;
    if (fTags.some(t => t.tag === "prolific") && !isTargetLeadership) {
      similarity -= 10;
    }

    if (similarity > 20) {
      scored.push({ ...f, similarity, officeType: fOffice, party: fParty, chamber: fChamber, seat: fSeat });
    }
  }

  // Sort by similarity descending, take top 50
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, 50);
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
  for (const window of PEER_WINDOWS) {
    const peers = withSeats.filter(c => Math.abs(c.seat.margin_pts - targetSeat.margin_pts) <= window);
    if (peers.length < 3) continue;
    const totals = peers.map(p => p.total).sort((a, b) => a - b);
    return {
      window, n: peers.length,
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
    const peers = peerMarginGifts(actual, seat?.margin_pts ?? null);
    const sample = peers?.gifts || actual;
    return { amount: percentile(sample.map(g => g.amount).sort((a,b) => a-b), 0.5), n: sample.length, actual: true };
  }
  const gifts = [];
  profiles.forEach((profile, i) => {
    if (comparables[i].committee_type && comparables[i].committee_type !== "Candidate Committee") return;
    const years = Object.keys(profile.top_donors_by_year || {}).map(Number).filter(y => y <= cycle).sort((a,b) => a-b);
    for (const year of years) {
      const amount = (profile.top_donors_by_year[year] || []).filter(d => donorKey(d) === key)
        .reduce((sum, d) => sum + Number(d.total || 0), 0);
      if (amount > 0) {
        gifts.push({ amount, filer: comparables[i].name, marginPts: comparables[i].seat?.margin_pts ?? null, year });
        break;
      }
    }
  });
  const peer = peerMarginGifts(gifts, seat?.margin_pts ?? null);
  const sample = peer?.gifts || gifts;
  return { amount: percentile(sample.map(g => g.amount).sort((a,b) => a-b), 0.5), n: sample.length };
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

  // Get comparable giving for upside adjustment — track per-filer details
  // compDonorDetails: lowered name → [{ filer, maxCycleAmt }]
  const compDonorDetails = new Map();
  for (let i = 0; i < compProfiles.length; i++) {
    const profile = compProfiles[i];
    const comp = comparables[i];
    const compByYear = profile.top_donors_by_year || {};
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
      const maxCy = Math.max(...Object.values(cyMap));
      if (!compDonorDetails.has(key)) compDonorDetails.set(key, []);
      compDonorDetails.get(key).push({ filer: comp.name, amount: maxCy, isLeadership: compIsLeadership,
                                       leadershipTier: compTier, marginPts: comp.seat?.margin_pts ?? null,
                                       cycles: cyMap });
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

    // Single-cycle donors must also have given to comparable candidates
    if (cycleNums.length < 2 && !compDonorDetails.has(key)) continue;

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

    // Base target: 5% increase from last cycle (or current if no prior)
    let target = Math.round(lastCycleAmt * 1.05 * 100) / 100;

    // Same-tier leadership floor: if a same-tier leader received more from this
    // donor, use that as the starting point (not just a blend).
    const compGifts = compDonorDetails.get(key) || [];
    const targetTier = targetProfile._leadershipTier || 0;
    if (targetTier > 0) {
      const sameTierGifts = compGifts
        .filter(g => g.leadershipTier === targetTier)
        .sort((a, b) => b.amount - a.amount);
      if (sameTierGifts.length > 0) {
        // Outlier check within same-tier
        const stRef = (sameTierGifts.length >= 2 && sameTierGifts[0].amount > sameTierGifts[1].amount * 1.5)
          ? sameTierGifts[1].amount
          : sameTierGifts[0].amount;
        if (stRef > target) {
          target = Math.round(stRef * 100) / 100;
        }
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
    const peer = peerMarginGifts(compGifts, targetSeat?.margin_pts ?? null);
    const refGifts = peer ? peer.gifts : compGifts;
    // Discount single-filer outliers: if the max is >1.5x the second-highest,
    // it's an outlier — use the second-highest as the reference instead.
    const sortedAmts = refGifts.map(g => g.amount).sort((a, b) => b - a);
    const compRef = (sortedAmts.length >= 2 && sortedAmts[0] > sortedAmts[1] * 1.5)
      ? sortedAmts[1]
      : (sortedAmts[0] || 0);
    const refGift = refGifts.find(g => g.amount === compRef);
    const maxFromNonLeadership = refGift && !refGift.isLeadership;
    const hasUplift = compRef > target;
    let compWeight = 0;
    if (hasUplift) {
      // Scale blend weight INVERSELY with the gap ratio:
      // Small gap (< 2x) → 35% weight (realistic uplift)
      // Medium gap (2-4x) → 20% weight (stretch goal)
      // Large gap (4-8x) → 10% weight (aspirational, stay close to history)
      // Huge gap (8x+) → 5% weight (almost entirely history-based)
      const gapRatio = compRef / Math.max(target, 1);
      if (gapRatio >= 8) compWeight = 0.05;
      else if (gapRatio >= 4) compWeight = 0.10;
      else if (gapRatio >= 2) compWeight = 0.20;
      else compWeight = 0.35;
      // Non-leadership max gets +5% weight (stronger signal of donor capacity)
      if (maxFromNonLeadership) compWeight = Math.min(compWeight + 0.05, 0.40);
      target = Math.round((target * (1 - compWeight) + compRef * compWeight) * 100) / 100;
    }

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
      factors.push(`Last cycle (${lastCycle - 1}–${lastCycle}): ${fmt$(lastCycleAmt)} → target: ${fmt$(target)} (+5%${hasUplift ? " + comparable uplift" : ""})`);
    } else {
      factors.push(`Current cycle donor: ${fmt$(currentCycleAmt)} given so far`);
      factors.push(`Base target: ${fmt$(target)} (+5%${hasUplift ? " + comparable uplift" : ""})`);
    }

    // Say which giving the benchmark came from before quoting a number from it.
    if (targetSeat && targetSeat.margin_pts != null && compGifts.length) {
      factors.push(peer
        ? `Benchmark: ${peer.gifts.length} gift${peer.gifts.length === 1 ? "" : "s"} to seats within `
          + `${peer.window} pts of this one (${targetSeat.margin_pts.toFixed(1)} pt margin, ${targetSeat.year})`
        : `Benchmark: all comparable giving — fewer than ${MIN_PEER_GIFTS} gifts to seats of similar closeness`);
    }

    // Show comparable uplift details
    if (hasUplift) {
      const upliftGifts = refGifts
        .filter(g => g.amount > lastCycleAmt * 1.05)
        .sort((a, b) => b.amount - a.amount);
      const pct = Math.round(compWeight * 100);
      const nlTag = maxFromNonLeadership ? " — non-leadership benchmark" : "";
      const outlierNote = (compRef < sortedAmts[0]) ? ` — top gift ${fmt$(sortedAmts[0])} discounted as outlier` : "";
      factors.push(`Comparable uplift (${pct}% weight, ref: ${fmt$(compRef)}${nlTag}${outlierNote}):`);
      upliftGifts.forEach(g => {
        const tag = g.isLeadership ? "" : " ★";
        const seat = g.marginPts != null ? ` [${g.marginPts.toFixed(1)} pt seat]` : "";
        factors.push(`  • ${g.filer}: ${fmt$(g.amount)}${seat}${tag}`);
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
      avg_prev: Math.round(avgPrev * 100) / 100,
      comp_max: compRef,
      comp_max_filers: refGifts.filter(g => g.amount === compRef).map(g => g.filer),
      target,
      current_cycle_amt: currentCycleAmt,
      remaining,
      consistency,
      history: historyParts,
      cycles: donor.cycles,          // {cycle: amount} to THIS committee
      comp_gifts: compGifts,         // gifts to comparables, with seat margins
      benchmark: peer ? { window: peer.window, n: peer.gifts.length } : null,
      factors,
    });
  }

  // Filter out donors with target below $500
  const filtered = results.filter(r => r.target >= 500).sort((a, b) => b.target - a.target);
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
    const donors = mergeDonorsByYear(profile.top_donors_by_year || {}, years);

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
        marginPts: comp.seat?.margin_pts ?? null,
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

    if (donor.distinctComps <= 1) {
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
    const peer = peerMarginGifts(donor.compGifts, targetSeat?.margin_pts ?? null);
    const askAmounts = (peer ? peer.gifts.map(g => g.amount) : compAmounts).sort((a, b) => a - b);
    const median = percentile(askAmounts, 0.5);
    const p75 = percentile(askAmounts, 0.75);

    // Target = upper-median (between median and 75th) capped by donor's own max
    const maxGift = Math.max(...compAmounts);
    let targetAsk = Math.min(Math.round(((median + p75) / 2) * 100) / 100, maxGift);

    const firstGiving = firstGivingBenchmark(key, compProfiles, comparables, cycle, targetSeat);
    // A new relationship should not start at an established donor's ask.
    // Annual aggregates cannot identify a single first gift: label that limit.
    targetAsk = Math.round(Math.min(targetAsk * 0.5, firstGiving.amount || targetAsk * 0.5) * 100) / 100;
    const remainingAsk = Math.max(0, targetAsk - alreadyGiven);

    // Comparable giving range
    const compMin = Math.min(...compAmounts);
    const compMax = maxGift;

    // ── Explainable score components ──────────────────────────────────
    let score = 0;
    const factors = [];

    factors.push(`First-time ask: ${fmt$(targetAsk)} — capped at 50% of the established-giving benchmark`);
    if (firstGiving.n) factors.push(firstGiving.actual
      ? `Median first observed cash contribution to ${firstGiving.n} comparable recipients: ${fmt$(firstGiving.amount)}`
      : `Median earliest observed annual giving to ${firstGiving.n} comparable recipients: ${fmt$(firstGiving.amount)}; annual totals are a proxy, not individual first gifts`);

    // Show what the ask was measured against, so the number is traceable to
    // real gifts rather than to a rule.
    if (peer) {
      factors.push(`Ask set by ${peer.gifts.length} gifts to seats within ${peer.window} pts of this one`
        + ` (${targetSeat.margin_pts.toFixed(1)} pt margin, ${targetSeat.year}) — median ${fmt$(median)}`);
      [...peer.gifts].sort((a, b) => b.amount - a.amount).slice(0, 4)
        .forEach(g => factors.push(`  • ${peerGiftLabel(g)}`));
    } else if (targetSeat && targetSeat.margin_pts != null) {
      factors.push(`Ask set by all comparable giving — under ${MIN_PEER_GIFTS} gifts to seats within`
        + ` ${PEER_WINDOWS[PEER_WINDOWS.length - 1]} pts of this ${targetSeat.label} seat`);
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
      benchmark: peer ? { window: peer.window, n: peer.gifts.length } : null,
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

  // Summary cards
  const repeatRemaining = repeatTargets.reduce((s, r) => s + r.remaining, 0);
  const newRemaining = recommendations.reduce((s, r) => s + r.remaining_ask, 0);
  const summaryEl = document.getElementById("results-summary");
  summaryEl.innerHTML = `
    <div class="summary-card sc-muted"><span class="sc-label">Cycle Contributions <span class="sc-help" title="Total cash contributions received by this committee during the selected election cycle.">?</span></span><br><span class="sc-value">${fmt$(cycleContributions)}</span></div>
    <div class="summary-card"><span class="sc-label">Donor Target Total <span class="sc-help" title="Sum of recommended ask amounts for all existing donors who gave in the most recent previous cycle.">?</span></span><br><span class="sc-value">${fmt$(repeatRemaining)}</span></div>
    <div class="summary-card"><span class="sc-label">New Prospect Target <span class="sc-help" title="Sum of recommended ask amounts for new donors identified from comparable filer giving patterns.">?</span></span><br><span class="sc-value">${fmt$(newRemaining)}</span></div>
    <div class="summary-card"><span class="sc-label">Comparable Filers <span class="sc-help" title="Number of similar candidates used as benchmarks for donor targeting and prospect identification.">?</span></span><br><span class="sc-value">${fmtNum(comparables.length)}</span></div>
    <div class="summary-card"><span class="sc-label">Total Fundraising Target <span class="sc-help" title="Combined target from existing donor asks plus new prospect asks. Represents the total recommended fundraising goal.">?</span></span><br><span class="sc-value">${fmt$(repeatRemaining + newRemaining)}</span></div>
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
  loadLobbyistPlan();

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
  return `<div class="summary-card"><span class="sc-label">Similar-margin seats
      <span class="sc-help" title="Comparable committees whose last general finished within ${ctx.window} points of this seat's ${targetSeat.margin_pts.toFixed(1)}-point margin, and what they raised this cycle. Targets are benchmarked against giving in seats like these rather than scaled by a multiplier.">?</span></span><br>
    <span class="sc-value">${fmt$(ctx.median)}</span>
    <div class="sc-sub">${esc(targetSeat.label)} · median of ${ctx.n}
      ${ctx.leadershipOnly ? "leadership " : ""}seats within ${ctx.window} pts · ${standing}</div></div>`;
}

// ── Lobbyist tiers ─────────────────────────────────────────────────────────
//
// The fundraising sheets rank lobbyists before they are called: the 2024 lobby
// list is worked Partner → Tier 1 → Tier 2 → Tier 3. A tier is a claim about
// likelihood to give, and it rests on two observable things:
//
//   volume   — how many donors in this plan they carry, and how much those
//              donors are worth;
//   fit      — whether their donors give to candidates like this one at all
//              (the comparables are already filtered to the target's party and
//              office, so "gave to 9 comparables" means nine like-members).
//
// PARTNER is not computed. It is a standing relationship with a caucus, set by
// an admin per chamber and party at /admin/lobbyists (lobbyist_partners).
const TIER_RULES = [
  { tier: 1, min: 70, label: "Tier 1" },
  { tier: 2, min: 45, label: "Tier 2" },
  { tier: 3, min: 20, label: "Tier 3" },
  { tier: 4, min: -Infinity, label: "Tier 4" },
];

/**
 * Score and tier one lobbyist group.
 *   rows        the plan rows filed under them
 *   isPartner   designated a partner of this chamber+party
 * Returns { tier, label, score, donors, likeComps, likeTotal, toCandidate, why }.
 */
function lobbyistTier(rows, isPartner) {
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
    tier: isPartner ? 0 : rule.tier,
    label: isPartner ? "PARTNER" : rule.label,
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
let partnersById = null;      // lobbyist_id → Set("house|D")
let planControlsWired = false;

/** Which caucus this plan is for: "house|D" for a House Democrat. */
function planPartnerKey() {
  const f = window._targetFiler;
  if (!f) return null;
  const chamber = getChamber(f), party = getParty(f);
  return chamber && party ? `${chamber}|${party}` : null;
}

function isPartner(lobbyistId) {
  const key = planPartnerKey();
  return !!(key && partnersById?.get(lobbyistId)?.has(key));
}

async function loadLobbyistPlan() {
  const status = document.getElementById("plan-status");
  window._lobbyAttr = null;
  window._donorContacts = new Map();
  window._donorTypes = new Map();
  wirePlanControls();
  status.textContent = "Looking up lobbyists…";
  renderLobbyistPlan();
  const runCycle = window._cycle;
  const runFiler = window._targetProfile;
  try {
    if (!lobbyistsById) {
      lobbyistsById = new Map((await LOB.loadLobbyists()).map(l => [l.lobbyist_id, { ...l, name: String(l.name || "").trim().replace(/\s+/g, " ") }]));
    }
    if (!partnersById) partnersById = await LOB.loadPartners();
    const rows = [...(window._repeatTargets || []), ...(window._recommendations || [])]
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

// ORESTAR files every contributor under a category. A lobbyist plan is a call
// list for organizations, so the people — including a candidate's own family —
// are dropped from it rather than filtered by name. They are still in Donor
// Targets and New Donor Prospects, which is where an individual belongs.
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

function planGroups() {
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
    if (!list.length) { none.rows.push(entry); continue; }
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
      return lobHit ? g : { ...g, rows: g.rows.filter(r => r.donor.toLowerCase().includes(q)) };
    }).filter(g => g.rows.length);
  }
  for (const g of out) {
    g.rows.sort((a, b) => b.remaining - a.remaining || b.target - a.target);
    g.last_cycle = g.rows.reduce((s, r) => s + Number(r.last_cycle || 0), 0);
    g.target = g.rows.reduce((s, r) => s + r.target, 0);
    g.given = g.rows.reduce((s, r) => s + r.given, 0);
    g.remaining = g.rows.reduce((s, r) => s + r.remaining, 0);
    g.partner = g.lobbyist ? isPartner(g.lobbyist.lobbyist_id) : false;
    g.tier = lobbyistTier(g.rows, g.partner);
  }
  // Partners first, then tier, then the size of the ask — the order the lobby
  // list is worked. Donors with no lobbyist sit at the bottom.
  out.sort((a, b) => (!a.lobbyist - !b.lobbyist) || (a.tier.tier - b.tier.tier)
    || (b.remaining - a.remaining));
  return out;
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

function lobbyistHeader(l) {
  if (l.kind !== "firm") {
    return `<div class="plan-lobbyist">${esc(l.name)}</div>
            <div class="plan-contact">${esc(lobbyistContact(l))}</div>`;
  }
  const { primary, others } = firmContacts(l);
  const own = contactLine(l);
  const lead = primary
    ? `<div class="plan-contact"><span class="plan-primary">${esc(primary.name)}</span>${own || contactLine(primary) ? " · " : ""}${esc(own || contactLine(primary))}</div>`
    : own ? `<div class="plan-contact">${esc(own)}</div>` : "";
  const item = m => `<li>${esc(m.name)}${contactLine(m) ? ` <span>${esc(contactLine(m))}</span>` : ""}</li>`;
  const more = others.length
    ? `<details class="plan-members" open><summary>${others.length} other${others.length === 1 ? "" : "s"} at the firm</summary>
         <ul>${others.map(item).join("")}</ul></details>`
    : "";
  return `<div class="plan-lobbyist">${esc(l.name)} <span class="plan-firm">firm</span></div>${lead}${more}`;
}

/** The tier chip in front of a lobbyist: PARTNER, Tier 1 … Tier 4. */
function tierChip(t) {
  if (!t) return "";
  const cls = t.tier === 0 ? "is-partner" : `is-t${t.tier}`;
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
  const withLobbyist = groups.filter(g => g.lobbyist).length;
  document.querySelectorAll(".tab-btn[data-tab='tab-lobbyist-plan'] .tab-badge").forEach(el => el.textContent = withLobbyist);
  if (!groups.length) {
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
      <td class="plan-why">${l ? esc(g.tier.why) : ""}</td>
    </tr>`;
    const rows = g.rows.map(r => `<tr class="plan-donor" data-group="${groupIndex}">
      <td></td>
      <td>${esc(r.donor)}${contactsCell(r)}${r.also.length ? `<div class="plan-also">also: ${esc(r.also.map(a => a.lobbyist.name).join(", "))}</div>` : ""}</td>
      <td><span class="plan-type ${r.type === "Donor Target" ? "is-target" : "is-prospect"}">${r.type === "Donor Target" ? "Target" : "Prospect"}</span></td>
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
  }).join("");
  tbody.querySelectorAll(".plan-group-toggle").forEach(button => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    button.textContent = (open ? "▾" : "▸") + button.textContent.slice(1);
    tbody.querySelectorAll(`.plan-donor[data-group="${button.dataset.group}"]`).forEach(row => { row.hidden = !open; });
  }));
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
function planCycleColumns(groups, cycle) {
  const cycles = [cycle, cycle - 2, cycle - 4];
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
  const comps = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  return { cycles, comps };
}

/**
 * The call list, as rows plus a role for each one so the writer can style it.
 *
 * Column layout, left to right: who to call, then one band per cycle. The
 * current cycle carries the ask and what has come in; the two before it carry
 * what these same donors gave this candidate and the handful of comparable
 * candidates they gave most to — the evidence for the ask, sitting next to it.
 */
function planSheetAoa(groups, cycle) {
  const self = window._targetProfile?.name || "This committee";
  const { cycles, comps } = planCycleColumns(groups, cycle);

  const fixed = ["Lobbyist", "Lobbyist or firm", "Donor", "Tier", "Who to call", "Email", "Phone",
                 "Why them"];
  const bands = [];
  let width = fixed.length + 1;                       // +1 spacer
  bands.push({ cycle: cycles[0], start: width, current: true,
               cols: [{ filer: PLAN_SELF, kind: "Ask" }, { filer: PLAN_SELF, kind: "Given" }] });
  width += 2;
  for (const c of cycles.slice(1)) {
    width += 1;                                       // spacer
    const cols = [{ filer: PLAN_SELF, kind: "Gave" },
                  ...comps.map(f => ({ filer: f, kind: "Gave" }))];
    bands.push({ cycle: c, start: width, cols });
    width += cols.length;
  }
  const blank = () => new Array(width).fill("");
  const label = f => (f === PLAN_SELF ? self : f);
  const rows = [], roles = [];
  const push = (row, role) => { rows.push(row); roles.push(role); };

  const seat = window._targetSeat, ctx = window._seatContext;
  const title = blank();
  title[0] = `${self} — who to ask, and for how much (${cycle - 1}–${cycle})`;
  push(title, "title");
  const sub = blank();
  sub[0] = seat
    ? `This seat was ${seat.label.replace(/ \(.*\)/, "")} in ${seat.year}`
      + (seat.margin_pts != null ? ` — decided by ${seat.margin_pts.toFixed(1)} points` : "")
      + (ctx ? `. Committees in seats that close raised a median of ${fmt$(ctx.median)} this cycle.` : ".")
    : "No general-election margin on record for this seat.";
  push(sub, "note");
  const method = blank();
  method[0] = "Prior-donor asks use giving history and comparable seats. First-time asks use initial giving, capped at half the established benchmark. "
    + "The columns on the right show that giving.";
  push(method, "note");
  push(blank(), "blank");

  const rCycle = blank(), rName = blank(), rKind = blank();
  for (const b of bands) {
    rCycle[b.start] = b.current ? `This cycle (${b.cycle - 1}–${b.cycle})` : `${b.cycle - 1}–${b.cycle}`;
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
    lead[7] = l ? g.tier.why : "";
    body.push(lead); bodyRoles.push(l && g.partner ? "lobbyist-partner" : "lobbyist");
    const groupSums = new Array(width).fill(0);
    for (const r of g.rows) {
      const row = blank();
      row[0] = name;
      row[2] = r.donor;
      row[3] = r.type === "Donor Target" ? "Gave before" : "New prospect";
      const dc = donorContact(r);
      row[4] = dc.name; row[5] = dc.email; row[6] = dc.phone;
      row[7] = [plainAttribution(r.attribution), ...(r.factors || []).filter(f => /First-time ask|first observed|earliest observed/.test(f))].filter(Boolean).join(" · ");
      for (const b of bands) {
        b.cols.forEach((c, i) => {
          const at = b.start + i;
          const v = c.kind === "Ask" ? r.target
            : b.current && c.filer === PLAN_SELF ? r.given
            : givenInCycle(r.donor_key, c.filer, b.cycle, r);
          if (!v) return;
          row[at] = Math.round(v);
          groupSums[at] += v;
          totals[at] += v;
        });
      }
      body.push(row); bodyRoles.push("donor");
    }
    for (let i = 0; i < width; i++) if (groupSums[i]) lead[i] = Math.round(groupSums[i]);
    for (const b of bands.filter(b => !b.current)) lead[b.start] = Math.round(groupSums[b.start]);
  }
  for (let i = 0; i < width; i++) if (totals[i]) totalsRow[i] = Math.round(totals[i]);
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
    for (const r of g.rows) {
      const dc = donorContact(r);
      out.push({
        "Tier": l ? g.tier.label : "",
        "Lobbyist": name,
        "Contact": c.name, "Email": c.email, "Phone": c.phone, "Other Firm Contacts": c.others,
        "Donor": r.donor,
        "Donor Contact": dc.name, "Donor Contact Email": dc.email, "Donor Contact Phone": dc.phone,
        "Type": r.type,
        "Target": Math.round(r.target),
        "Given This Cycle": Math.round(r.given),
        "Remaining": Math.round(r.remaining),
        "Last Cycle": r.last_cycle ?? "",
        "Comparable Max": r.comp_max || "",
        "Benchmark": r.benchmark ? `${r.benchmark.n} gifts to seats within ${r.benchmark.window} pts` : "all comparable giving",
        "Ask calculation": (r.factors || []).join("; "),
        "Attribution": attributionText(r.attribution),
        "Also Lobbied By": r.also.map(a => a.lobbyist.name).join("; "),
      });
    }
  }
  return out;
}

/** Sheet 4: how every number on the other sheets was arrived at. */
function methodSheetRows(groups, cycle) {
  const seat = window._targetSeat, ctx = window._seatContext;
  const rows = [
    { Item: "Committee", Value: window._targetProfile?.name || "", Detail: `${cycle - 1}–${cycle} cycle` },
    { Item: "Seat", Value: seat ? seat.label : "no margin on record",
      Detail: seat && seat.margin_pts != null ? `${seat.margin_pts.toFixed(1)} pt margin, ${seat.year} general` : "" },
  ];
  if (ctx) {
    rows.push({ Item: "Similar-margin seats", Value: fmt$(ctx.median),
      Detail: `median raised this cycle by ${ctx.n} comparable committees within ${ctx.window} pts of this margin` });
    rows.push({ Item: "This committee", Value: fmt$(ctx.raised),
      Detail: ctx.median ? `${Math.round((ctx.raised / ctx.median) * 100)}% of that median` : "" });
    for (const p of ctx.peers.slice(0, 10)) {
      rows.push({ Item: "  peer", Value: p.name, Detail: `${p.seat.margin_pts.toFixed(1)} pt margin · ${fmt$(p.total)} this cycle` });
    }
  }
  rows.push({ Item: "Established giving benchmark", Value: "comparable seats",
    Detail: `A donor's ask is the upper-median of what they gave candidates in seats within ${PEER_WINDOWS[0]}–`
      + `${PEER_WINDOWS[PEER_WINDOWS.length - 1]} pts of this one, never above their own largest gift. `
      + `Under ${MIN_PEER_GIFTS} such gifts, all comparable giving is used and the donor row says so.` });
  rows.push({ Item: "First-time ask", Value: "lower introductory ask",
    Detail: "Median first observed cash contribution to comparable candidates, capped at 50% of the established-giving benchmark. If first transactions are unavailable, earliest observed annual totals serve as an explicitly labeled proxy. The first observed record may not be the donor’s first-ever gift." });
  for (const t of TIER_RULES) {
    rows.push({ Item: t.label, Value: `score ≥ ${t.min === -Infinity ? "0" : t.min}`,
      Detail: "6 × donors in plan (max 30) + 2 × like candidates supported (max 30) + giving to them ÷ 5,000 (max 20) + 15 if they have given here before + 5 if they have given this cycle" });
  }
  rows.push({ Item: "PARTNER", Value: "set by an admin",
    Detail: "A standing relationship with this chamber and party, designated at /admin/lobbyists. Never computed." });
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
  partner: "FFFDE68A",
  tier1: "FFDCFCE7",
  lobbyist: "FFEFF3FA",
  total: "FFD9E2F3",
  rule: "FFBFBFBF",
  muted: "FF595959",
};
const MONEY = '"$"#,##0';

function styleHeaderCell(cell, { center = false } = {}) {
  cell.font = { bold: true, color: { argb: INK.headText }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.head } };
  cell.alignment = { vertical: "middle", horizontal: center ? "center" : "left", wrapText: true };
}

function tierFill(label) {
  if (label === "PARTNER") return INK.partner;
  if (label === "Tier 1") return INK.tier1;
  return null;
}

/** Sheet 1 of the workbook: the call list, styled. */
function writeCallList(wb, groups, cycle) {
  const { rows, roles, merges, cols, moneyFrom, headerRows } = planSheetAoa(groups, cycle);
  const ws = wb.addWorksheet("Call list", {
    views: [{ state: "frozen", xSplit: 3, ySplit: headerRows }],
    properties: { defaultRowHeight: 16, outlineLevelRow: 1, outlineProperties: { summaryBelow: false } },
  });
  rows.forEach(r => ws.addRow(r));
  ws.columns.forEach((col, i) => { col.width = cols[i]?.wch || 12; });
  for (const m of merges) ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);

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
    } else if (role === "total") {
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK.total } };
      });
    } else if (role === "lobbyist" || role === "lobbyist-partner") {
      row.font = { bold: true };
      const tier = String(row.getCell(4).value || "");
      const fill = tierFill(tier) || INK.lobbyist;
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        cell.border = { top: { style: "thin", color: { argb: INK.rule } } };
      });
    } else if (role === "donor") {
      row.outlineLevel = 1;
      row.hidden = true;
      row.getCell(3).alignment = { indent: 1 };
    }
    if (role === "donor" || role === "lobbyist" || role === "lobbyist-partner" || role === "total") {
      for (let c = moneyFrom + 1; c <= rows[0].length; c++) row.getCell(c).numFmt = MONEY;
      row.getCell(8).alignment = { wrapText: true, vertical: "top" };
    }
  });
  // The "Lobbyist" repeat in column A is there for filtering and sorting, not
  // for reading; it would otherwise be the first thing the eye lands on.
  ws.getColumn(1).hidden = true;
  ws.getColumn(1).width = 24;
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
  ws.columns.forEach((col, i) => {
    const h = headers[i];
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
function writeCover(wb, groups, cycle) {
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

  const facts = [
    ["Lobbyists to call", withLob.length],
    ["Donors covered", donors],
    ["Still to ask", ask],
    ["Seat", seat ? `${seat.label.replace(/ \(.*\)/, "")}${seat.margin_pts != null
      ? `, decided by ${seat.margin_pts.toFixed(1)} points in ${seat.year}` : ""}` : "no margin on record"],
  ];
  if (ctx) facts.push(["What seats this close raise", ctx.median]);
  for (const [k, v] of facts) {
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (typeof v === "number" && (k === "Still to ask" || k.startsWith("What seats"))) {
      row.getCell(2).numFmt = MONEY;
    }
  }
  ws.addRow([]);

  const heading = t => { const r = ws.addRow([t]); r.font = { bold: true, size: 12 }; r.height = 20; };
  const para = t => { const r = ws.addRow([t]); r.font = { size: 11 }; r.alignment = { wrapText: true }; r.height = 30; };

  heading("What's in this file");
  for (const [sheet, what] of [
    ["Call list", "Every lobbyist to call, in the order to call them, with their donors underneath and what to ask each one for."],
    ["Lobbyists", "The same lobbyists, one line each — sort or filter this one."],
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
  para("Lobbyists are listed best-prospect first: PARTNER, then Tier 1 through Tier 4. The tier reflects how many donors they carry here and how much those donors give to candidates like this one — the reason is spelled out in the “Why them” column.");
  para("Under each lobbyist are the donors they handle. “Ask” is what to ask for this cycle; “Given” is what has already come in. The columns further right show what those same donors gave this candidate and a few comparable candidates in past cycles — that is the case for the ask.");
  para("Individual people are not in this plan. It lists organizations, PACs and businesses only, using ORESTAR's own category for each contributor.");

  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 96;
  return ws;
}

async function exportLobbyistWorkbook(groups, cycle, filename) {
  const ExcelJSLib = await loadExcelJs();
  const wb = new ExcelJSLib.Workbook();
  wb.creator = "Oregon Campaign Finance";
  wb.created = new Date();

  writeCover(wb, groups, cycle);
  writeCallList(wb, groups, cycle);

  const lobRows = lobbyistSheetRows(groups, cycle);
  if (lobRows.length) {
    writeTable(wb, "Lobbyists", lobRows, {
      money: ["Suggested ask", `Given ${cycle - 1}–${cycle}`, "Remaining", "Last Cycle",
              "Given to this committee to date", "Given to like candidates"],
      widths: { "Lobbyist / Firm": 30, "Firm / Title": 24, Contact: 24, Email: 30,
                "Other contacts": 44, Clients: 60, "Why this tier": 60 },
      note: "One line per lobbyist. Sort by tier or by what is still to ask.",
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
function exportData(format, scope = "new") {
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

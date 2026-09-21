"use strict";

// Run with: node --test tests/plan_frontend.test.cjs
//
// The parts of the Recommend page that decide a number rather than draw one:
// which gifts benchmark an ask (competitiveness), what tier a lobbyist lands
// in, and the shape of the exported plan sheet.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(root, "docs/recommend.js"), "utf8");

/** The source between two markers, both of which must exist. */
function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a !== -1, `missing marker: ${from}`);
  assert.ok(b > a, `missing marker after ${from}: ${to}`);
  return src.slice(a, b);
}

const peerCode = slice("const PEER_WINDOWS = [", "async function findComparables(");
const tierCode = slice("const TIER_RULES = [", "function renderRepeatDonors(");
const exportCode = slice("/** Contact details for a lobbyist row", "/** Sheet 2: one line per lobbyist");
const keyCode = slice("/** Oregon cycles run odd→even", "function _getAllYearGifts(");

function context(extra = {}) {
  const ctx = vm.createContext({
    fmt$: n => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`,
    esc: String,
    percentile: (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0),
    firmContacts: () => ({ primary: null, others: [] }),
    attributionText: a => (a ? "Confirmed" : ""),
    window: {},
    ...extra,
  });
  vm.runInContext(fs.readFileSync(path.join(root, "docs/lib/donor-names.js"), "utf8") + keyCode + peerCode + tierCode + exportCode, ctx);
  return ctx;
}

const gift = (filer, amount, marginPts) => ({ filer, amount, marginPts });

// ── Competitiveness as a benchmark ─────────────────────────────────────────
test("the narrowest window holding three gifts wins", () => {
  const ctx = context();
  const gifts = [gift("A", 5000, 2), gift("B", 4000, 4), gift("C", 6000, 6),
                 gift("D", 1000, 40), gift("E", 1000, 45)];
  const peer = ctx.peerMarginGifts(gifts, 3);
  assert.equal(peer.window, 5);
  assert.deepEqual(peer.gifts.map(g => g.filer), ["A", "B", "C"]);
});

test("the window widens when the narrow one is too thin", () => {
  const ctx = context();
  const gifts = [gift("A", 5000, 2), gift("B", 4000, 12), gift("C", 6000, 14)];
  const peer = ctx.peerMarginGifts(gifts, 5);
  assert.equal(peer.window, 10);
  assert.equal(peer.gifts.length, 3);
});

test("too few comparable seats falls back to every gift", () => {
  const ctx = context();
  const gifts = [gift("A", 5000, 2), gift("B", 4000, 80)];
  assert.equal(ctx.peerMarginGifts(gifts, 3), null);
});

test("a seat with no margin on record has no peers", () => {
  const ctx = context();
  const gifts = [gift("A", 5000, 2), gift("B", 4000, 3), gift("C", 6000, 4)];
  assert.equal(ctx.peerMarginGifts(gifts, null), null);
});

test("gifts with no margin never count as peers", () => {
  const ctx = context();
  const gifts = [gift("A", 5000, null), gift("B", 4000, null), gift("C", 6000, 3)];
  assert.equal(ctx.peerMarginGifts(gifts, 3), null);
});

// ── Tiers ──────────────────────────────────────────────────────────────────
const row = (over = {}) => ({ given: 0, cycles: {}, comp_gifts: [], ...over });

test("a big book that gives to many like candidates is Tier 1", () => {
  const ctx = context();
  const comps = Array.from({ length: 15 }, (_, i) => ({ filer: `F${i}`, amount: 5000 }));
  const t = ctx.lobbyistTier([row({ comp_gifts: comps }), row(), row(), row(), row()], false);
  assert.equal(t.label, "Tier 1");
  assert.equal(t.likeComps, 15);
});

test("one donor and one like candidate lands at the bottom", () => {
  const ctx = context();
  const t = ctx.lobbyistTier([row({ comp_gifts: [{ filer: "F", amount: 500 }] })], false);
  assert.equal(t.label, "Tier 4");
});

test("a prior gift to this committee moves a thin book up", () => {
  const ctx = context();
  const comps = [{ filer: "A", amount: 1000 }, { filer: "B", amount: 1000 }];
  const cold = ctx.lobbyistTier([row({ comp_gifts: comps })], false);
  const warm = ctx.lobbyistTier([row({ comp_gifts: comps, cycles: { 2024: 2500 }, given: 500 })], false);
  assert.ok(warm.score > cold.score);
  assert.match(warm.why, /\$2,500 to this committee to date/);
});

test("a partner outranks every computed tier", () => {
  const ctx = context();
  const t = ctx.lobbyistTier([row()], true);
  assert.equal(t.label, "PARTNER");
  assert.equal(t.tier, 0);   // sorts above Tier 1
});

// ── The exported plan sheet ────────────────────────────────────────────────
function planFixture() {
  const compCycles = new Map([
    ["grocery pac", new Map([["Fahey", { 2024: 5000, 2022: 2500 }], ["Lieber", { 2024: 1000 }]])],
    ["foresight", new Map([["Fahey", { 2024: 250 }]])],
  ]);
  const ctx = context({
    window: {
      _targetProfile: { name: "Friends of A" },
      _targetSeat: { label: "competitive (<10 pt margin)", margin_pts: 3.2, year: 2024 },
      _seatContext: { n: 4, window: 5, median: 120000 },
      _compCycles: compCycles,
    },
  });
  const groups = [{
    lobbyist: { lobbyist_id: 1, name: "Amanda Dalton", kind: "person", email: "a@d.com", phone: "503-000-0000" },
    tier: { label: "Tier 1", why: "2 donors in this plan" }, partner: false,
    rows: [
      { donor: "Grocery PAC", donor_key: "grocery pac", type: "Donor Target", target: 1100, given: 500,
        cycles: { 2026: 500, 2024: 1000 }, contacts: [], attribution: null, also: [] },
      { donor: "Foresight", donor_key: "foresight", type: "New Prospect", target: 1000, given: 0,
        cycles: {}, contacts: [], attribution: null, also: [] },
    ],
  }];
  return { ctx, groups };
}

test("the sheet is banded by cycle, with the candidate and its comparables", () => {
  const { ctx, groups } = planFixture();
  const { rows, merges, roles } = ctx.planSheetAoa(groups, 2026);
  assert.match(String(rows[0][0]), /Friends of A — who to ask/);
  assert.match(String(rows[1][0]), /35\.5|3\.2 points/);
  const [cycleRow, nameRow, kindRow] = [rows[4], rows[5], rows[6]];
  assert.deepEqual(Array.from(cycleRow.filter(Boolean).slice(-3)),
                   ["This cycle (2025–2026)", "2023–2024", "2021–2022"]);
  assert.equal(nameRow.filter(Boolean)[0], "Friends of A");
  assert.ok(nameRow.includes("Fahey"));
  assert.deepEqual([...new Set(kindRow.filter(Boolean))], ["Ask", "Given", "Gave"]);
  assert.equal(merges.length, 3);          // one per cycle band
  // Roles drive the formatting, so every row must carry one.
  assert.equal(roles.length, rows.length);
  assert.deepEqual(Array.from(roles.slice(0, 8)),
    ["title", "note", "note", "blank", "head-band", "head-name", "head-kind", "total"]);
});

test("the lobbyist row totals its donors and the totals row totals everything", () => {
  const { ctx, groups } = planFixture();
  const { rows, roles, moneyFrom } = ctx.planSheetAoa(groups, 2026);
  const total = rows.find(r => r[1] === "Everyone");
  const lead = rows.find(r => r[1] === "Amanda Dalton");
  const donor = rows.find(r => r[2] === "Grocery PAC");
  const askCol = rows[6].indexOf("Ask");
  assert.ok(askCol > moneyFrom);
  assert.equal(donor[askCol], 1100);
  assert.equal(lead[askCol], 2100);        // 1,100 + 1,000
  assert.equal(total[askCol], 2100);
  assert.equal(lead[3], "Tier 1");
  assert.equal(roles[rows.indexOf(donor)], "donor");
});

test("a donor's row says in words why that lobbyist has it", () => {
  const ctx = context();
  assert.equal(ctx.plainAttribution(null), "");
  assert.equal(
    ctx.plainAttribution({ status: "confirmed", methods: ["client:name_exact"],
                           client_names: ["Oregon Health Care Association"] }),
    "Lobbies for Oregon Health Care Association · donor name matches a client of theirs");
  assert.match(
    ctx.plainAttribution({ status: "suggested", methods: ["email_domain"], client_names: [] }),
    /^Not yet reviewed — shares the committee's email domain$/);
  // The same method name means different things on the two link tables.
  assert.equal(
    ctx.plainAttribution({ status: "confirmed", methods: ["name_exact"], client_names: [] }),
    "named on the committee's filing");
});

test("a donor's giving to a comparable lands in the right cycle band", () => {
  const { ctx, groups } = planFixture();
  const { rows } = ctx.planSheetAoa(groups, 2026);
  const names = rows[5], cycles = rows[4];
  assert.ok(cycles.some(c => String(c).includes("2023–2024")));
  // Column for Fahey in the 2023–2024 band.
  let band = null, col = -1;
  for (let i = 0; i < names.length; i++) {
    if (cycles[i]) band = cycles[i];
    if (names[i] === "Fahey" && band === "2023–2024") { col = i; break; }
  }
  assert.ok(col > 0, "no Fahey column in the 2023–2024 band");
  assert.equal(rows.find(r => r[2] === "Grocery PAC")[col], 5000);
  assert.equal(rows.find(r => r[2] === "Foresight")[col], 250);
});

test("only the five comparables this plan's donors gave most to get columns", () => {
  const { ctx } = planFixture();
  const many = new Map();
  for (let i = 0; i < 8; i++) many.set(`F${i}`, { 2024: 1000 * (i + 1) });
  ctx.window._compCycles = new Map([["d", many]]);
  const groups = [{ lobbyist: null, tier: { label: "", why: "" }, partner: false,
                    rows: [{ donor: "d", donor_key: "d", type: "Donor Target", target: 0, given: 0,
                             cycles: {}, contacts: [], attribution: null, also: [] }] }];
  const { comps } = ctx.planCycleColumns(groups, 2026);
  assert.deepEqual(Array.from(comps), ["F7", "F6", "F5", "F4", "F3"]);
});

// ── First-time asks and shared identity ──────────────────────────────────
function scoringContext(extra = {}) {
  const ctx = context({ filerIndex: [], isDonorExcluded: () => false, ...extra });
  vm.runInContext(slice('function _getAllYearGifts(', '// ── Step 6: Display results'), ctx);
  return ctx;
}

test('first-time targets use observed first gifts and stay below established giving', () => {
  const ctx = scoringContext();
  const comps = ['A', 'B', 'C'].map(slug => ({ slug, name: slug, similarity: 100 }));
  const profiles = comps.map(() => ({ top_donors_by_year: {
    2022: [{ name: 'Northwest Grocery Assoc. PAC (152)', donor_id: 'c152', total: 1000 }],
    2026: [{ name: 'Northwest Grocery Assoc. PAC (152)', donor_id: 'c152', total: 10500 }],
  } }));
  ctx.window._firstGifts = new Map([['c152', [{ amount: 500 }, { amount: 1000 }, { amount: 1500 }]]]);
  const { prospects } = ctx.scoreDonors({ top_donors_by_year: {} }, comps, profiles, ['2026'], 2026, null);
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].target_ask, 1000);
  assert.ok(prospects[0].factors.some(f => f.includes('first observed cash contribution')));
});

test('annual fallback uses earliest years, combines aliases, and excludes future years', () => {
  const ctx = scoringContext();
  const profiles = [{ top_donors_by_year: {
    2022: [{ name: 'Genentech', total: 200 }, { name: 'Genentech USA', total: 300 }],
    2024: [{ name: 'Genentech', total: 10000 }],
    2028: [{ name: 'Genentech', total: 50000 }],
  } }];
  const result = ctx.firstGivingBenchmark('family:genentech', profiles, [{ name: 'A' }], 2026, null);
  assert.equal(result.amount, 500);
  assert.equal(result.n, 1);
  assert.ok(!result.actual);
});

test('Amazon and Genentech variants combine before scoring and export history', () => {
  const ctx = scoringContext();
  const variants = ['Amazon.Com', 'Amazon.Com Services LLC', 'Amazon Services LLC'];
  const profiles = [{ top_donors_by_year: { 2026: variants.map((name, i) => ({ name, donor_id: `id${i}`, total: 1000 })) } }];
  const merged = ctx.mergeDonorsByYear(profiles[0].top_donors_by_year, ['2026']);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total, 3000);
  assert.equal(ctx.donorKey({ name: 'Genentech USA', donor_id: 'other' }), ctx.donorKey({ name: 'Genentech' }));
  assert.notEqual(ctx.donorKey({ name: 'Amazon Web Services', donor_id: 'aws' }), merged[0].donor_key);
  const idx = ctx.buildCompCycleIndex([{ name: 'A' }], profiles);
  assert.equal(idx.get('family:amazon').get('A')[2026], 3000);
  // A different spelling already giving to the candidate must not become a new prospect.
  const result = ctx.scoreDonors({ top_donors_by_year: { 2024: [{ name: 'Amazon Services LLC', total: 100 }] } },
    [{ name: 'A', similarity: 100 }, { name: 'B', similarity: 100 }], [profiles[0], profiles[0]], ['2026'], 2026, null);
  assert.equal(result.prospects.length, 0);
});

test('display spelling preserves acronyms and corrects Cooperative', () => {
  const ctx = context();
  assert.equal(ctx.donorDisplayName('Oregon Beverage Recycling CoOperative'), 'Oregon Beverage Recycling Cooperative');
  assert.equal(ctx.donorDisplayName('NORTHWEST GROCERY ASSOC. PAC (152)'), 'Northwest Grocery Assoc. PAC (152)');
  assert.equal(ctx.donorDisplayName('SEIU Local 503'), 'SEIU Local 503');
});

test('Donor Targets includes prospects without changing the plan source lists', () => {
  const ctx = context();
  vm.runInContext(slice('function allDonorTargets()', 'function renderRepeatDonors('), ctx);
  ctx.window._repeatTargets = [{ donor: 'Repeat', target: 2000 }];
  ctx.window._recommendations = [{ donor: 'New', target_ask: 500, already_given: 0, remaining_ask: 500 }];
  const rows = ctx.allDonorTargets();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].target, 500);
  assert.equal(rows[1].consistency, 'new');
  assert.equal(ctx.window._repeatTargets.length, 1);
});

test('OBRC canonical name wins over Beverage PAC raw alias regardless of pool order', () => {
  const code = fs.readFileSync(path.join(root, 'docs/lib/lobbyists.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(code + '\nthis.lob = LOB;', ctx);
  const rows = [
    { donor_id: 'c126', display_name: 'Oregon Beverage PAC', names: ['oregon beverage recycling cooperative'] },
    { donor_id: 'obrc1', display_name: 'Oregon Beverage Recycling Cooperative', names: ['oregon beverage recycling cooperative'] },
    { donor_id: 'obrc2', display_name: 'Oregon Beverage Recycling Cooperative', names: ['oregon beverage recycling cooperative'] },
  ];
  const ids = ctx.lob.poolIdsForLabels(rows, ['oregon beverage recycling cooperative']).get('oregon beverage recycling cooperative');
  assert.deepEqual(Array.from(ids).sort(), ['obrc1', 'obrc2']);
  assert.equal(ctx.lob.poolIdsForLabels([
    { donor_id: 'a', display_name: 'A', names: ['ambiguous'] },
    { donor_id: 'b', display_name: 'B', names: ['ambiguous'] },
  ], ['ambiguous']).size, 0);
});

test('name-only cached profiles are repaired by scoped identity queries before scoring', async () => {
  const calls = [];
  const ctx = context({ DL: { async getDonors(args) {
    calls.push(args);
    return { by_year: { 2026: [{ name: 'Resolved', donor_id: 'd1', donor_key: 'd1', total: 500 }] } };
  } } });
  vm.runInContext(slice('async function loadRecommendationIdentities(', '// ── Status helpers'), ctx);
  const old = { filer_ids: ['1', '2'], top_donors_by_year: { 2026: [{ name: 'Alias', total: 500 }] } };
  const current = { top_donors_by_year: { 2026: [{ name: 'Resolved', donor_key: 'd2' }] } };
  await ctx.loadRecommendationIdentities([old, current], [{ filer_id: '1' }, { filer_id: '3' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filerIds, ['1', '2']);
  assert.equal(old.top_donors_by_year[2026][0].donor_key, 'd1');
});

test('first-gift requests exclude repeat donors and pool family identities per recipient', async () => {
  const calls = [];
  const ctx = context({ cycleYears: c => [c - 1, c], getSupabase: async () => ({ rpc: async (name, params) => {
    calls.push(params);
    return { data: [
      { donor_id: 'amazon1', filer_id: '1', first_date: '2020-01-01', amount: '500' },
      { donor_id: 'amazon2', filer_id: '1', first_date: '2022-01-01', amount: '5000' },
      { donor_id: 'amazon2', filer_id: '2', first_date: '2021-01-01', amount: '1000' },
    ] };
  } }), LOB: { fetchAll: async build => (await build()).data } });
  vm.runInContext(slice('async function loadRecommendationIdentities(', '// ── Status helpers'), ctx);
  const donor = (name, donor_id) => ({ name, donor_id, total: 1000 });
  const target = { top_donors_by_year: { 2024: [donor('Repeat', 'repeat')] } };
  const profile = { top_donors_by_year: { 2026: [donor('Repeat', 'repeat'), donor('Amazon.Com', 'amazon1'), donor('Amazon Services LLC', 'amazon2')] } };
  const comps = ['1', '2'].map(filer_id => ({ filer_id, name: filer_id, slug: filer_id }));
  await ctx.loadFirstGifts([target, profile, profile], comps, [profile, profile], 2026);
  assert.deepEqual(Array.from(calls[0].p_donor_ids).sort(), ['amazon1', 'amazon2']);
  const gifts = ctx.window._firstGifts.get('family:amazon');
  assert.equal(gifts.length, 2);
  assert.deepEqual(Array.from(gifts, g => g.amount), [500, 1000]);
  assert.equal(ctx.window._planIdentityIds.get('family:amazon').size, 2);
});

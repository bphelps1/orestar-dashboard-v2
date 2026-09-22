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

/**
 * A host-realm copy of a value built inside the vm sandbox.
 *
 * Sandbox objects carry the sandbox's Object.prototype, so
 * assert.deepStrictEqual — which `node:assert/strict` makes deepEqual — fails
 * them against a literal written here with "same structure but not
 * reference-equal", however identical the contents. Compare the plain shape.
 */
const plain = value => JSON.parse(JSON.stringify(value));

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
const listCode = slice("const LIST_SIZE = 125;", "// ── The standing list, shaped like the lobby list");
// The lobby-list shaping: asks, giving lines and the name/committee tidying.
const listShapeCode = slice("// \u2500\u2500 The standing list, shaped like the lobby list",
                            "let listControlsWired = false;")
  + slice("/** A lobbyist's name split the way", "/** Sheet 1: the lobby list itself");

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
  const t = ctx.lobbyistTier([row({ comp_gifts: comps }), row(), row(), row(), row()]);
  assert.equal(t.label, "Tier 1");
  assert.equal(t.likeComps, 15);
});

test("one donor and one like candidate lands at the bottom", () => {
  const ctx = context();
  const t = ctx.lobbyistTier([row({ comp_gifts: [{ filer: "F", amount: 500 }] })]);
  assert.equal(t.label, "Tier 4");
});

test("a prior gift to this committee moves a thin book up", () => {
  const ctx = context();
  const comps = [{ filer: "A", amount: 1000 }, { filer: "B", amount: 1000 }];
  const cold = ctx.lobbyistTier([row({ comp_gifts: comps })]);
  const warm = ctx.lobbyistTier([row({ comp_gifts: comps, cycles: { 2024: 2500 }, given: 500 })]);
  assert.ok(warm.score > cold.score);
  assert.match(warm.why, /\$2,500 to this committee to date/);
});

test("every lobbyist lands on a computed tier", () => {
  const ctx = context();
  // There is no standing designation above the score any more: a thin book
  // is Tier 4 whoever holds it.
  assert.equal(ctx.lobbyistTier([row()]).label, "Tier 4");
  assert.equal(ctx.lobbyistTier([row()]).tier, 4);
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
    tier: { label: "Tier 1", why: "2 donors in this plan" },
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
  assert.deepEqual([...new Set(kindRow.filter(Boolean))],
                   ["Ask", "Given", "This candidate", "Comparable"]);
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
  const groups = [{ lobbyist: null, tier: { label: "", why: "" },
                    rows: [{ donor: "d", donor_key: "d", type: "Donor Target", target: 0, given: 0,
                             cycles: {}, contacts: [], attribution: null, also: [] }] }];
  const { comps } = ctx.planCycleColumns(groups, 2026);
  assert.deepEqual(Array.from(comps, c => c.filer), ["F7", "F6", "F5", "F4", "F3"]);
});

// ── First-time asks and shared identity ──────────────────────────────────
function scoringContext(extra = {}) {
  // limitedHistoryWeight() asks a profile for its office; a bare fixture has
  // none, and a null office simply skips the legislative special-case. Without
  // the stub the whole call throws ReferenceError — getOffice is declared
  // outside every slice.
  const ctx = context({ filerIndex: [], isDonorExcluded: () => false,
                        getOffice: () => null, ...extra });
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

test('final targets round to the nearest $250, with halfway values rounded up', () => {
 const ctx=context();
 for (const [amount,expected] of [[5124.99,5000],[5125,5250],[5249,5250],[5375,5500],[0,0]])
  assert.equal(ctx.roundTarget(amount),expected);
});

test('first-time asks round after the initial-gift adjustment', () => {
 const ctx=scoringContext();
 const comps=['A','B','C'].map(name=>({name,slug:name,similarity:100}));
 const profiles=comps.map(()=>({top_donors_by_year:{2026:[{name:'Acme',donor_id:'a',total:10000}]}}));
 ctx.window._firstGifts=new Map([['a',[{amount:1125},{amount:1125},{amount:1125}]]]);
 const result=ctx.scoreDonors({top_donors_by_year:{}},comps,profiles,['2026'],2026,null).prospects[0];
 assert.equal(result.target_ask,1250);assert.equal(result.remaining_ask,1250);
});

// ── Recency: an ask is argued from what a donor does now ───────────────────
//
// Oregon Nurses gave Susan McLain $25,000 in the 2013–14 cycle and
// $1,000–$2,000 in each of the last three. Taking a comparable's lifetime
// maximum asked every candidate for $25,000 on a relationship that had ended.
const NURSES_TO_MCLAIN = { 2014: 25000, 2016: 7500, 2018: 6000, 2022: 2000, 2024: 2000, 2026: 1000 };

test("a comparable is benchmarked on the recent window, not a lifetime maximum", () => {
  const ctx = context();
  const pick = ctx.benchmarkCycle(NURSES_TO_MCLAIN, 2026);
  assert.deepEqual(plain(pick), { cycle: 2024, amount: 2000, stale: false });
  assert.equal(Math.max(...Object.values(NURSES_TO_MCLAIN)), 25000);   // the old rule
});

test("the cycle being planned is not a benchmark for a peer", () => {
  const ctx = context();
  // $9,000 in the in-progress cycle is ignored; the window is the two completed ones.
  assert.equal(ctx.benchmarkCycle({ 2026: 9000, 2024: 1500 }, 2026).cycle, 2024);
});

test("with nothing recent, older giving stands in and is flagged", () => {
  const ctx = context();
  const pick = ctx.benchmarkCycle({ 2018: 6000, 2020: 4000 }, 2026);
  assert.deepEqual(plain(pick), { cycle: 2020, amount: 4000, stale: true });
  assert.match(ctx.recencyNote(true, 2026), /Nothing in 2021–2022 and 2023–2024/);
  assert.match(ctx.recencyNote(false, 2026), /Benchmarked on 2021–2022 and 2023–2024/);
});

test("giving older than the stale window is history, not evidence", () => {
  const ctx = context();
  assert.equal(ctx.benchmarkCycle({ 2012: 9000 }, 2026), null);
  assert.equal(ctx.cycleWeight(2012, 2026), 0);
  assert.equal(ctx.cycleWeight(2028, 2026), 0, "a future cycle never prices an ask");
  assert.deepEqual([2026, 2024, 2022, 2020, 2018, 2016].map(c => ctx.cycleWeight(c, 2026)),
                   [1, 1, 1, 0.5, 0.25, 0.1]);
});

test("the weighted median answers what a donor gives now", () => {
  const ctx = context();
  // Three large relationships that ended, two small ones that are current.
  const history = { 2016: 5000, 2018: 5000, 2020: 5000, 2024: 1000, 2026: 1000 };
  const entries = Object.entries(history)
    .map(([c, amount]) => ({ amount, weight: ctx.cycleWeight(Number(c), 2026) }));
  assert.equal(ctx.weightedMedian(entries), 1000);
  assert.equal(ctx.weightedMedian(entries.map(e => ({ ...e, weight: 1 }))), 5000,
               "unweighted, the giving that stopped still sets the number");
  assert.equal(ctx.weightedMedian([]), 0);
});

test("the stale fallback takes the last thing known, not the biggest", () => {
  const ctx = context();
  // Reaching back for a maximum is how one decade-old gift priced every ask.
  assert.deepEqual(plain(ctx.benchmarkCycle({ 2016: 25000, 2020: 4000 }, 2026)),
                   { cycle: 2020, amount: 4000, stale: true });
});

// ── Every ask is a blend ───────────────────────────────────────────────────
function blendFixture(compCycles, { tier = 3 } = {}) {
  const ctx = scoringContext();
  const NAME = "Some PAC";
  const rows = perCycle => Object.fromEntries(Object.entries(perCycle)
    .map(([c, amount]) => [c, [{ name: NAME, donor_id: "d1", total: amount }]]));
  const target = { top_donors_by_year: rows({ 2022: 2000, 2024: 2000, 2026: 2000 }),
                   _leadershipTier: tier };
  const comp = { top_donors_by_year: rows(compCycles), _leadershipTier: tier };
  const comparables = [{ name: "Peer", slug: "peer", leadership_tier: tier,
                         committee_type: "Candidate Committee",
                         seat: { band: "unopposed", margin_pts: null } }];
  const seat = { band: "unopposed", margin_pts: null, year: 2024 };
  return ctx.buildRepeatDonorTargets(target, comparables, [comp], ["2025", "2026"], 2026, seat);
}

test("a same-tier peer's gift no longer becomes the whole ask", () => {
  // The real shape of the Kropf case: a peer that once received $25,000.
  const { targets } = blendFixture(NURSES_TO_MCLAIN);
  assert.equal(targets.length, 1);
  const row = targets[0];
  assert.equal(row.comp_max, 2000, "the 2014 gift is history, not a benchmark");
  assert.ok(row.target < 3000, `ask was ${row.target}`);
  assert.ok(row.factors.some(f => f.startsWith("Benchmarked on 2021–2022 and 2023–2024")));
});

test("the row spells out the blend that produced the ask", () => {
  const { targets } = blendFixture({ 2022: 20000, 2024: 20000 });
  const row = targets[0];
  const blend = row.factors.find(f => f.startsWith("Ask = "));
  assert.ok(blend, `no blend line in ${JSON.stringify(row.factors)}`);
  // Both sides, both weights and the result, in one sentence.
  assert.match(blend, /Ask = \d+% × \$[\d,]+ \(own giving here, \+5%\) \+ \d+% × \$[\d,]+/);
  assert.match(blend, /= \$[\d,]+ → \$[\d,]+/);
  assert.ok(row.target > 2100 && row.target < 20000,
            `a blend must sit between history and reference, got ${row.target}`);
  assert.equal(row.same_tier_ref, 20000);
});

test("stale comparable giving still prices an ask, and says so", () => {
  const { targets } = blendFixture({ 2016: 7500, 2018: 6000 });
  assert.equal(targets[0].benchmark_stale, true);
  assert.ok(targets[0].factors.some(f => f.startsWith("Nothing in 2021–2022 and 2023–2024")));
});

// ── The fundraising ladder ─────────────────────────────────────────────────
//
// The columns must span the ladder rather than repeat the five biggest
// fundraisers: a back-bencher's sheet is useless benchmarked only on leaders.
function ladderContext(extra = {}) {
  const seat = pts => ({ band: pts < 10 ? "competitive" : pts < 20 ? "lean" : "safe",
                         margin_pts: pts, year: 2024 });
  const rung = (slug, name, tier, total, over = {}) => ({
    slug, name, committee_type: "Candidate Committee", office: "State Representative",
    party: "Democrat", total_in: total, leadership_tier: tier,
    office_district: `State Representative, ${slug} District`,
    election: "2026 Primary Election", ...over,
  });
  const index = [
    rung("target", "Target", 0, 600000),
    rung("speaker", "Speaker", 1, 2000000),
    rung("senior", "Senior", 0, 1700000),
    rung("middle", "Middle", 0, 700000),
    rung("swing", "Swing", 0, 750000),
    rung("bench", "Bench", 0, 200000),
    rung("gone", "Gone", 0, 900000, { election: "2014 General Election" }),
    rung("other", "Other Party", 0, 900000, { party: "Republican" }),
  ];
  const ctx = context({ filerIndex: index, adminTags: {}, LIST_MIN_RAISED: 5000, ...extra });
  // peerCode declares `let raceMarginIndex`, a lexical binding the sandbox
  // object cannot reach — it has to be assigned from inside the context.
  ctx.__margins = index.map(f =>
    [`State Representative|${f.slug} District`, seat(f.slug === "swing" ? 5 : 60)]);
  vm.runInContext("raceMarginIndex = new Map(__margins);", ctx);
  return { ctx, index, target: index[0] };
}

test("every rung of the chamber's ladder gets a place, the target does not", () => {
  const { ctx, target } = ladderContext();
  const ladder = ctx.fundraiserLadder(target, 2026);
  assert.deepEqual(["Speaker", "Senior", "Middle", "Swing", "Bench"].map(n => ladder.get(n).level),
                   [1, 2, 3, 4, 5]);
  assert.equal(ladder.has("Target"), false, "the plan already has its own column");
  assert.equal(ladder.has("Gone"), false, "a committee that stopped running is not a benchmark");
  assert.equal(ladder.has("Other Party"), false);
  assert.equal(ctx.ladderCandidates(ladder).length, 5);
});

test("an archetype tag pins a committee to a rung", () => {
  const { ctx, target } = ladderContext();
  ctx.adminTags = { bench: [{ tag: "archetype", value: "2" }] };
  const pinned = ctx.fundraiserLadder(target, 2026).get("Bench");
  assert.equal(pinned.level, 2);
  assert.equal(pinned.pinned, true);
});

test("one column per rung, named for the rung it stands for", () => {
  const { ctx, target } = ladderContext();
  const ladder = ctx.fundraiserLadder(target, 2026);
  ctx.window._fundraiserLevels = ladder;
  ctx.window._compCycles = new Map([["d", new Map([...ladder.values()].map(s =>
    [s.name, { 2024: 1000 }]))]]);
  const { comps } = ctx.planCycleColumns([{ rows: [{ donor_key: "d" }] }], 2026);
  assert.deepEqual(Array.from(comps, c => c.level), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(comps, c => c.filer), ["Speaker", "Senior", "Middle", "Swing", "Bench"]);
  assert.equal(comps[0].rung, "Caucus leadership");
});

test("a ladder committee's giving folds into the index the columns read", () => {
  const { ctx, target } = ladderContext();
  const ladder = ctx.fundraiserLadder(target, 2026);
  ctx.window._compCycles = new Map();
  ctx.indexLadderGiving(
    new Map([["speaker", { 2023: [{ name: "Big PAC", donor_id: "d9", total: 5000 }],
                           2024: [{ name: "Big PAC", donor_id: "d9", total: 1500 }] }]]), ladder);
  assert.deepEqual(plain(ctx.window._compCycles.get("d9").get("Speaker")), { 2024: 6500 });
});

// ── The standing donor list, by chamber and party ──────────────────────────
//
// Not "who should this candidate call?" but "who gives to candidates of this
// kind, and how much does one of them get?" — so the unit is a candidate-cycle
// relationship, and old money counts for less.
function listContext(extra = {}) {
  const ctx = context({
    fmtNum: n => String(n),
    cycleYears: c => [c - 1, c],
    isDonorExcluded: () => false,
    PERSON_BOOK_TYPES: new Set(["Individual", "Candidate & Immediate Family",
                                "Candidate's Immediate Family"]),
    filerIndex: [], adminTags: {}, DL: {}, LOB: {},
    // currentMemberFor() asks which chamber a committee sits in; the cohort
    // is one chamber by construction here.
    getChamber: () => "house",
    ...extra,
  });
  vm.runInContext(listCode, ctx);        // context() already ran the rest
  // Seeding the roster skips the fetch inside loadCurrentLegislators, and a
  // `let` from the sliced code has to be assigned from a script in the same
  // context rather than from a property on the sandbox.
  // Seeding both rosters skips the fetches inside loadCurrentLegislators and
  // loadCommitteeChairs; an empty chair list is truthy, so it still short-
  // circuits. A `let` from the sliced code has to be assigned from a script in
  // the same context rather than from a property on the sandbox.
  ctx.__roster = { house: ["Julie Fahey", "Bobby Levy", "Emerson Levy"], senate: [] };
  vm.runInContext("currentLegislators = __roster; committeeChairs = committeeChairs || [];"
                  + " leadershipRoles = leadershipRoles || {};", ctx);
  return ctx;
}

function chamberFixture() {
  const committee = (slug, name, party, total_in, candidate_name) => ({
    slug, name, committee_type: "Candidate Committee",
    office: "State Representative", party, total_in, candidate_name,
  });
  const rows = donors => donors.map(([name, donor_id, total]) => ({ name, donor_id, total }));
  const history = {
    a: { 2022: rows([["Big PAC", "d1", 2000], ["Jane Doe", "d2", 1500], ["Once PAC", "d3", 9000]]),
         2024: rows([["Big PAC", "d1", 2000]]),
         // Two cheques inside one cycle are one $2,000 relationship.
         2026: rows([["Big PAC", "d1", 1000], ["Big PAC", "d1", 1000]]) },
    b: { 2014: rows([["Big PAC", "d1", 25000]]),
         2022: rows([["Big PAC", "d1", 3000]]),
         2024: rows([["Big PAC", "d1", 2500], ["Jane Doe", "d2", 500]]),
         2026: rows([["Big PAC", "d1", 2000]]) },
    r: { 2024: rows([["Other PAC", "d4", 5000]]) },
  };
  return listContext({
    filerIndex: [
      committee("a", "Friends of Julie Fahey", "Democrat", 500000, "Julie Fahey"),
      committee("b", "Friends of Emerson Levy", "Democrat", 300000, "Emerson Levy"),
      committee("paper", "Paper Committee", "Democrat", 900, "Nobody At All"),
      committee("r", "Friends of R", "Republican", 400000, "Someone Else"),
    ],
    DL: { getFilerDonorYears: async slugs => new Map(slugs.map(s => [s, history[s] || {}])) },
    LOB: { loadBookTypes: async ids => new Map(ids.map(id => [id, {
      d1: "Political Committee", d2: "Individual", d3: "Business Entity", d4: "Political Committee",
    }[id]])) },
  });
}

test("the list is drawn from one chamber and one party, minus paper committees", async () => {
  const built = await chamberFixture().buildChamberList("house", "Democrat", 2026);
  assert.equal(built.committees, 2);
  assert.equal(built.chamber.label, "House");
  assert.equal(built.party.label, "Democratic");
});

test("the generic ask is what a donor gives one candidate across a cycle", async () => {
  const built = await chamberFixture().buildChamberList("house", "Democrat", 2026);
  assert.deepEqual(Array.from(built.rows, r => r.donor), ["Big PAC"]);
  const big = built.rows[0];
  // 2026: $2,000 to A (two cheques) and $2,000 to B — two relationships, not four.
  assert.deepEqual(Array.from(big.gifts.filter(g => g.cycle === 2026), g => g.amount), [2000, 2000]);
  assert.equal(big.ask, 2000);
  assert.equal(big.campaigns, 2);
  assert.deepEqual([big.cycles_given, big.cycles_in_window], [3, 6]);
});

test("a decade-old gift does not set the generic ask", async () => {
  const built = await chamberFixture().buildChamberList("house", "Democrat", 2026);
  assert.ok(built.rows[0].gifts.every(g => g.cycle >= 2016), "2013–14 is outside the window");
  assert.equal(built.rows[0].ask, 2000);
});

test("individuals and one-cycle donors stay off the list", async () => {
  const built = await chamberFixture().buildChamberList("house", "Democrat", 2026);
  assert.equal(built.dropped.people, 1, "Jane Doe is an individual");
  assert.equal(built.rows.some(r => r.donor === "Once PAC"), false);
});

test("a candidate committee is never listed as a donor to its own chamber", () => {
  const ctx = listContext({ filerIndex: [
    { slug: "x", name: "Friends of X", committee_type: "Candidate Committee" },
  ] });
  assert.equal(ctx.isCandidateCommittee("k", "Friends of X (12345)"), true);
  assert.equal(ctx.isCandidateCommittee("k", "Some PAC"), false);
});

test("the list is cached per chamber, party and cycle", async () => {
  let calls = 0;
  const ctx = chamberFixture();
  const inner = ctx.DL.getFilerDonorYears;
  ctx.DL.getFilerDonorYears = async slugs => { calls++; return inner(slugs); };
  await ctx.buildChamberList("house", "Democrat", 2026);
  await ctx.buildChamberList("house", "Democrat", 2026);
  assert.equal(calls, 1);
});

// ── The standing list, in the shape of the lobby list ──────────────────────
//
// The team works from a lobby list: one row per lobbyist, their donors and a
// number for each. These are the pieces that turn a donor row into that line.
function shapeContext() {
  const ctx = listContext();
  vm.runInContext(listShapeCode, ctx);
  return ctx;
}

test("an ask is one number, as a call list quotes it", () => {
  const ctx = shapeContext();
  assert.equal(ctx.askLine({ donor: "Oregon Nurses PAC", ask: 2500 }), "Oregon Nurses PAC: $2,500");
  // The donor is kept apart from the rest so a sheet can bold it.
  assert.deepEqual(plain(ctx.askParts({ donor: "Kroger", ask: 1000 })),
                   { donor: "Kroger", rest: ": $1,000" });
});

test("asks round coarsely above $1,000 and finely below it", () => {
  const ctx = listContext();
  // At or above $1,000 the step is $500.
  assert.equal(ctx.roundAsk(2400), 2500);
  assert.equal(ctx.roundAsk(2600), 2500);
  assert.equal(ctx.roundAsk(2750), 3000);
  assert.equal(ctx.roundAsk(1750), 2000);
  // Below it the step is $250, so a small ask stays small rather than being
  // rounded up to $500 for tidiness.
  assert.equal(ctx.roundAsk(900), 1000);
  assert.equal(ctx.roundAsk(700), 750);
  assert.equal(ctx.roundAsk(600), 500);
  assert.equal(ctx.roundAsk(250), 250);
  // And the floor is one small step, never nothing.
  assert.equal(ctx.roundAsk(10), 250);
  assert.equal(ctx.roundAsk(0), 250);
});

test("a giving line names sitting members by surname", () => {
  const ctx = shapeContext();
  const row = { donor: "Oregon Nurses PAC", per_cycle: [{ cycle: 2026, recipients: [
    { filer: "Friends of Julie Fahey", member: "Fahey", amount: 20000 },
    { filer: "Friends of Emerson Levy", member: "Levy E", amount: 2000 },
  ] }] };
  assert.equal(ctx.givingLine(row, 2026), "Oregon Nurses PAC: $20,000 Fahey, $2,000 Levy E");
  assert.equal(ctx.givingLine(row, 2024), "", "a cycle with no giving has no line");
  assert.equal(ctx.givingLine({ donor: "X", per_cycle: [{ cycle: 2026, recipients: [] }] }, 2026), "",
               "a cycle whose recipients all left has no line either");
  assert.deepEqual(plain(ctx.givingParts(row, 2026)),
                   { donor: "Oregon Nurses PAC", rest: ": $20,000 Fahey, $2,000 Levy E" });
});

test("a surname alone, unless the chamber seats two of them", () => {
  const ctx = context({ getChamber: () => "house" });
  ctx.__roster = { house: ["Julie Fahey", "Bobby Levy", "Emerson Levy", "Rob Nosse"], senate: [] };
  vm.runInContext("currentLegislators = __roster;", ctx);
  const short = ctx.memberShortNames("house");
  assert.equal(short.get("Julie Fahey"), "Fahey");
  assert.equal(short.get("Rob Nosse"), "Nosse");
  assert.equal(short.get("Bobby Levy"), "Levy B");
  assert.equal(short.get("Emerson Levy"), "Levy E");
});

test("a committee resolves to the sitting member, or to nobody", () => {
  // currentMemberFor() asks getChamber(), which is declared outside every
  // slice — the cohort is one chamber by construction wherever it is called.
  const ctx = context({ getChamber: () => "house" });
  ctx.__roster = { house: ["Julie Fahey"], senate: [] };
  vm.runInContext("currentLegislators = __roster;", ctx);
  const house = { office: "State Representative" };
  assert.equal(ctx.currentMemberFor({ ...house, candidate_name: "Julianne Fahey", name: "Friends of Julie Fahey" }),
               "Julie Fahey");
  // Brian Clem and RJ Navarro no longer hold seats; neither can be called.
  assert.equal(ctx.currentMemberFor({ ...house, candidate_name: "Brian Clem", name: "Friends of Brian Clem" }), null);
  assert.equal(ctx.currentMemberFor({ ...house, candidate_name: "RJ Navarro", name: "Friends of RJ Navarro" }), null);
});

test("a lobbyist's name splits into the list's two columns", () => {
  const ctx = shapeContext();
  assert.deepEqual(plain(ctx.splitName("Jack Dempsey")), { first: "Jack", last: "Dempsey" });
  assert.deepEqual(plain(ctx.splitName("Kirsten Larson Adams")), { first: "Kirsten Larson", last: "Adams" });
  assert.deepEqual(plain(ctx.splitName("Cher")), { first: "Cher", last: "" });
  assert.deepEqual(plain(ctx.splitName("")), { first: "", last: "" });
});

test("every sheet the workbook writes can actually be built", async () => {
  const built = await chamberFixture().buildChamberList("house", "Democrat", 2026);
  const ctx = shapeContext();
  // These run only when someone presses Excel, so a constant renamed
  // elsewhere goes unnoticed until the download fails. It has happened twice
  // — RECENT_CYCLES, then LIST_ASK_ROUNDING — both only in the method sheet.
  const method = ctx.chamberMethodRows(built);
  assert.ok(method.length > 5);
  for (const row of method) {
    assert.ok(row.Item && row.Value !== undefined && row.Detail,
              `incomplete method row: ${JSON.stringify(row)}`);
    assert.doesNotMatch(String(row.Detail), /undefined|NaN|\[object/,
                        `method row did not render: ${row.Item}`);
  }
  // The flat sheet has to survive a built list with no DOM behind it too.
  assert.ok(ctx.listSheetHeaders(built).labels.length > 10);
});

test("the sheet's column numbers come from its own headers", () => {
  const ctx = shapeContext();
  const h = ctx.listSheetHeaders({ cycle: 2026, chamber: { label: "House" }, party: { short: "D" } });
  // Counting these by hand put the bolded donor lists one column left, over
  // Donors. They are read off the labels instead.
  assert.equal(h.labels[h.byClientCol - 1], "Suggested Ask 2026 by client");
  assert.equal(h.labels[h.givingFrom - 1], "2025–2026 giving");
  assert.equal(h.labels[h.givingFrom], "2023–2024 giving");
  assert.equal(h.labels.includes("Suggested Ask 2026"), false,
               "the standalone per-lobbyist ask column is gone");
});

test("donor identities survive for the lobbyist lookup", async () => {
  const ctx = chamberFixture();
  const built = await ctx.buildChamberList("house", "Democrat", 2026);
  // planAttribution needs the ids; dropping them is what left every donor
  // unattributed the first time round.
  assert.deepEqual(plain(built.rows[0].ids), ["d1"]);
});

test("giving history names only members who still hold the seat", async () => {
  const seat = (slug, name, candidate_name) => ({
    slug, name, candidate_name, committee_type: "Candidate Committee",
    office: "State Representative", party: "Democrat", total_in: 400000,
  });
  const gave = amount => ({ 2024: [{ name: "Big PAC", donor_id: "d1", total: amount }],
                            2026: [{ name: "Big PAC", donor_id: "d1", total: amount }] });
  const ctx = listContext({
    filerIndex: [seat("sitting", "Friends of Julie Fahey", "Julie Fahey"),
                 // Brian Clem left the House; his giving is not a call to make.
                 seat("gone", "Friends of Brian Clem", "Brian Clem")],
    DL: { getFilerDonorYears: async slugs =>
      new Map(slugs.map(s => [s, s === "gone" ? gave(7500) : gave(2000)])) },
    LOB: { loadBookTypes: async ids => new Map(ids.map(id => [id, "Political Committee"])) },
  });
  const built = await ctx.buildChamberList("house", "Democrat", 2026);
  const named = built.rows[0].per_cycle.flatMap(c => Array.from(c.recipients, r => r.member));
  assert.equal(named.includes("Clem"), false);
  assert.deepEqual([...new Set(named)], ["Fahey"]);
  // The money still counts toward what the donor gives a candidate of this
  // kind — it is the history column that names people you can ring.
  assert.ok(built.rows[0].gifts.some(g => g.amount === 7500),
            "Clem's giving still informs the ask, it just has no name on it");
});

test("every ask is a round number a caller can say out loud", async () => {
  const ctx = listContext();
  const asks = [2400, 250, 1750, 40].map(ctx.roundAsk);
  assert.deepEqual(asks, [2500, 250, 2000, 250]);
  // Whatever the step used, every ask is a multiple of the small one, so a
  // lobbyist's total is too.
  for (const a of asks) assert.equal(a % 250, 0, `${a} is not a round ask`);
  assert.equal(asks.reduce((a, b) => a + b, 0) % 250, 0);
});

// ── The tranche below the top 125 ──────────────────────────────────────────
//
// A lobbyist already on the list may also carry donors ranked just below the
// cut. Those ride along in the giving columns so the caller knows what else
// is in the conversation — but they carry no ask and move nobody up the order.
test("the build returns both bands, and only the first one is asked for", async () => {
  // 130 organizations, so the cut at 125 actually bites.
  const donors = Array.from({ length: 130 }, (_, i) => [`PAC ${String(i).padStart(3, "0")}`, `d${i}`]);
  const year = amount => donors.map(([name, donor_id]) => ({ name, donor_id, total: amount }));
  const ctx = listContext({
    filerIndex: [{ slug: "a", name: "Friends of Julie Fahey", candidate_name: "Julie Fahey",
                   committee_type: "Candidate Committee", office: "State Representative",
                   party: "Democrat", total_in: 500000 }],
    // Descending totals keep the ranking stable and the split predictable.
    DL: { getFilerDonorYears: async () => new Map([["a", {
      2024: donors.map(([name, donor_id], i) => ({ name, donor_id, total: 10000 - i * 10 })),
      2026: donors.map(([name, donor_id], i) => ({ name, donor_id, total: 10000 - i * 10 })),
    }]]) },
    LOB: { loadBookTypes: async ids => new Map(ids.map(id => [id, "Political Committee"])) },
  });
  const built = await ctx.buildChamberList("house", "Democrat", 2026);
  assert.equal(built.rows.length, 125);
  assert.equal(built.context.length, 5);
  for (const row of built.context) {
    assert.equal(row.context, true);
    assert.equal(row.ask, 0, "a client below the cut is never asked for a number");
  }
  assert.deepEqual(Array.from(built.context, r => r.list_rank), [126, 127, 128, 129, 130]);
  // The ranked band keeps its asks.
  assert.ok(built.rows.every(r => r.ask >= 250));
});

test("a client with no ask says so wherever it appears", () => {
  const ctx = shapeContext();
  const row = { donor: "Zillow Group", per_cycle: [{ cycle: 2026, recipients: [
    { filer: "Friends of Ben Bowman", member: "Bowman", amount: 1000 },
  ] }] };
  assert.equal(ctx.givingLine(row, 2026), "Zillow Group: $1,000 Bowman");
  assert.equal(ctx.givingLine({ ...row, context: true }, 2026),
               "Zillow Group (no ask): $1,000 Bowman");
});

test("a lobbyist's giving columns cover both bands, their asks only one", () => {
  const ctx = shapeContext();
  const asked = { donor: "Big PAC", ask: 2500, per_cycle: [] };
  const alongside = { donor: "Small PAC", ask: 0, context: true, per_cycle: [] };
  const group = { rows: [asked], context: [alongside] };
  assert.deepEqual(Array.from(ctx.groupGivingRows(group), r => r.donor), ["Big PAC", "Small PAC"]);
  // The ask column is built from group.rows alone, so it never names the other.
  assert.equal(group.rows.map(ctx.askLine).join("\n"), "Big PAC: $2,500");
});

// ── Who sets a typical ask ─────────────────────────────────────────────────
//
// A Speaker is given money on a different scale from a back-bencher, and so
// is a veteran chair who has raised for a decade. Leaving them in the median
// opens a first call at a number only a leader ever sees.
function leadershipContext(roles = {}, chairs = []) {
  const ctx = listContext();
  ctx.__roles = roles;
  ctx.__chairs = chairs;
  vm.runInContext("leadershipRoles = __roles; committeeChairs = __chairs;", ctx);
  return ctx;
}
const seat = (candidate_name, leadership_role) => ({
  candidate_name, name: `Friends of ${candidate_name}`, leadership_role,
  office: "State Representative", party: "Democrat",
});

test("chamber leadership never sets a typical ask", () => {
  const ctx = leadershipContext();
  for (const title of ["Speaker of the House", "House Majority Leader", "House Minority Leader",
                       "Ways and Means Co-Chair"]) {
    assert.equal(ctx.askMedianExclusion(seat("A Member", title), { senior: false, outlier: false }),
                 "chamber leadership", title);
  }
});

test("a deputy is not a leader for this purpose", () => {
  const ctx = leadershipContext();
  for (const title of ["House Assistant Minority Leader", "House Deputy Minority Leader",
                       "House Assistant Majority Leader", "House Minority Whip"]) {
    assert.equal(ctx.askMedianExclusion(seat("A Member", title), { senior: false, outlier: false }),
                 null, title);
  }
});

test("a senior chair is set aside only when they also raise like an outlier", () => {
  const ctx = leadershipContext({}, [{ chamber: "house", name: "Dacia Grayber",
                                       committees: ["Labor and Workforce Development"] }]);
  const chair = seat("Dacia Grayber", "");
  // The gavel and the seniority are common; the money is what distorts a median.
  assert.equal(ctx.askMedianExclusion(chair, { senior: true, outlier: true }),
               "senior leader or chair, outsized");
  assert.equal(ctx.askMedianExclusion(chair, { senior: true, outlier: false }), null);
  assert.equal(ctx.askMedianExclusion(chair, { senior: false, outlier: true }), null);
  // A first-term member with no gavel is ordinary however much they raise.
  assert.equal(ctx.askMedianExclusion(seat("New Member", ""), { senior: true, outlier: true }), null);
});

test("an outsized raiser is one the rest of the caucus is measured against", () => {
  const ctx = listContext();
  // Eleven ordinary members and one far above them.
  const totals = new Map(Array.from({ length: 11 }, (_, i) => [`m${i}`, 100000 + i * 10000]));
  totals.set("leader", 900000);
  assert.deepEqual([...ctx.outsizedRaisers(totals)], ["leader"]);
  // Too few to judge: nobody is called an outlier on four observations.
  assert.equal(ctx.outsizedRaisers(new Map([["a", 1], ["b", 2], ["c", 3], ["d", 9999]])).size, 0);
});

test("a leader's giving is left out of the ask but not out of the donor", async () => {
  const member = (slug, candidate_name, leadership_role) => ({
    slug, candidate_name, name: `Friends of ${candidate_name}`, leadership_role,
    committee_type: "Candidate Committee", office: "State Representative",
    party: "Democrat", total_in: 400000,
  });
  const gave = amount => Object.fromEntries([2022, 2024, 2026].map(c =>
    [c, [{ name: "Big PAC", donor_id: "d1", total: amount }]]));
  const ctx = listContext({
    filerIndex: [member("speaker", "Julie Fahey", "Speaker of the House"),
                 member("backbench", "Emerson Levy", "")],
    DL: { getFilerDonorYears: async slugs => new Map(slugs.map(s =>
      [s, s === "speaker" ? gave(20000) : gave(1000)])) },
    LOB: { loadBookTypes: async ids => new Map(ids.map(id => [id, "Political Committee"])) },
  });
  ctx.__roster = { house: ["Julie Fahey", "Emerson Levy"], senate: [] };
  vm.runInContext("currentLegislators = __roster; committeeChairs = [];", ctx);
  const built = await ctx.buildChamberList("house", "Democrat", 2026);
  const row = built.rows[0];
  // $1,000 to the back-bencher, not the $20,000 the Speaker gets.
  assert.equal(row.ask, 1000);
  assert.equal(row.ask_set_aside, 3, "the Speaker's three cycles are set aside");
  // The Speaker's money still counts toward what this donor is: it is in the
  // gift list, the cycle totals and the giving history.
  assert.ok(row.gifts.some(g => g.amount === 20000));
  assert.ok(row.per_cycle.some(c => c.recipients.some(r => r.member === "Fahey")));
});

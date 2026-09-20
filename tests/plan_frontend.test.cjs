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
  vm.runInContext(peerCode + tierCode + exportCode, ctx);
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
    tier: { label: "Tier 1", why: "2 donors in this plan" },
    rows: [
      { donor: "Grocery PAC", type: "Donor Target", target: 1100, given: 500, cycles: { 2026: 500, 2024: 1000 },
        contacts: [], attribution: null, also: [] },
      { donor: "Foresight", type: "New Prospect", target: 1000, given: 0, cycles: {},
        contacts: [], attribution: null, also: [] },
    ],
  }];
  return { ctx, groups };
}

test("the sheet is banded by cycle, with the candidate and its comparables", () => {
  const { ctx, groups } = planFixture();
  const { rows, merges } = ctx.planSheetAoa(groups, 2026);
  assert.match(String(rows[0][0]), /Friends of A — fundraising plan, 2025–2026/);
  assert.match(String(rows[1][0]), /3\.2 pt margin/);
  const [cycleRow, nameRow, kindRow] = [rows[4], rows[5], rows[6]];
  assert.deepEqual(cycleRow.filter(Boolean).slice(-3), ["2025–2026", "2023–2024", "2021–2022"]);
  assert.equal(nameRow.filter(Boolean)[0], "Friends of A");
  assert.ok(nameRow.includes("Fahey"));
  assert.deepEqual([...new Set(kindRow.filter(Boolean))], ["Target", "Actual"]);
  assert.equal(merges.length, 3);          // one per cycle band
});

test("the lobbyist row totals its donors and the TOTAL row totals everything", () => {
  const { ctx, groups } = planFixture();
  const { rows } = ctx.planSheetAoa(groups, 2026);
  const total = rows.find(r => r[1] === "TOTAL");
  const lead = rows.find(r => r[1] === "Amanda Dalton");
  const donor = rows.find(r => r[2] === "Grocery PAC");
  const targetCol = rows[6].indexOf("Target");
  assert.equal(donor[targetCol], 1100);
  assert.equal(lead[targetCol], 2100);     // 1,100 + 1,000
  assert.equal(total[targetCol], 2100);
  assert.equal(lead[3], "Tier 1");
});

test("a donor's giving to a comparable lands in the right cycle band", () => {
  const { ctx, groups } = planFixture();
  const { rows } = ctx.planSheetAoa(groups, 2026);
  const names = rows[5], cycles = rows[4];
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
                    rows: [{ donor: "d", type: "Donor Target", target: 0, given: 0, cycles: {}, contacts: [], attribution: null, also: [] }] }];
  const { comps } = ctx.planCycleColumns(groups, 2026);
  assert.deepEqual(comps, ["F7", "F6", "F5", "F4", "F3"]);
});

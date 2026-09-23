/**
 * data.js — dashboard data access layer.
 *
 * The dashboard used to fetch static JSON files from data/aggregated/. It now
 * reads the same aggregate blobs from Supabase:
 *   • dashboard_cache(key, data)   — summary, timeline, top_donors, …
 *   • filer_detail(slug, detail)   — one row per filer
 *
 * Each helper returns the exact same object shape the old JSON files had, so
 * the rendering code in app.js / recommend.js is unchanged apart from swapping
 * `fetchJSON('…/x.json')` for `DL.getBlob('x')`.
 *
 * Requires lib/supabase.js (getSupabase) to be loaded first.
 */
"use strict";

const DL = (() => {
  const donorRequests = new Map();
  const names = value => typeof DN === "undefined" ? value : DN.tree(value);

  /** Fetch a whole-dashboard aggregate blob by key from dashboard_cache. */
  async function getBlob(key) {
    if (typeof DN !== "undefined") await DN.load();
    if (key === "top_donors" && typeof ID !== "undefined" && await ID.hasMerges()) return getDonors();
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("dashboard_cache")
      .select("data")
      .eq("key", key)
      .single();
    if (error) throw new Error(`Failed to load '${key}': ${error.message}`);
    return typeof ID !== "undefined" && ["by_contributor_type", "activity_snapshot"].includes(key)
      ? names(await ID.rekeyBlob(data.data)) : names(data.data);
  }

  /** Fetch a single filer's detail blob by slug from filer_detail. */
  async function getFilerDetail(slug) {
    if (typeof DN !== "undefined") await DN.load();
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("filer_detail")
      .select("detail,filer_id")
      .eq("slug", slug)
      .single();
    if (error) throw new Error(`Failed to load filer '${slug}': ${error.message}`);
    const detail = names(data.detail);
    const ids = detail.filer_ids?.length ? detail.filer_ids : [data.filer_id].filter(Boolean);
    if (typeof ID !== "undefined" && await ID.affectsFilers(ids)) {
      const donors = await getDonors({ filerIds: ids });
      return { ...detail, top_donors: donors.all_time, top_donors_by_year: donors.by_year };
    }
    return detail;
  }

  /**
   * Per-year donor tables for many filers at once.
   *
   * A whole chamber is 200–300 committees, and a filer_detail blob carries a
   * timeline, payees and contributor breakdowns none of which a donor roll-up
   * needs. Selecting the one jsonb path keeps a chamber near a megabyte on the
   * wire instead of forty. Returns Map<slug, {year: [donor rows]}>.
   */
  async function getFilerDonorYears(slugs, { chunk = 20, concurrency = 6 } = {}) {
    const sb = await getSupabase();
    // Merges an admin saved at /admin/donors apply here too: without them an
    // organization filed under two addresses ranks, and is asked for money,
    // twice. The map is read once and applied in memory, because a chamber is
    // hundreds of blobs and the per-filer re-query the detail page uses would
    // be hundreds of round trips.
    const merged = typeof ID !== "undefined" && await ID.hasMerges();
    const pending = [];
    for (let i = 0; i < slugs.length; i += chunk) pending.push(slugs.slice(i, i + chunk));
    const out = new Map();
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (pending.length) {
        const part = pending.shift();
        const { data, error } = await sb
          .from("filer_detail")
          .select("slug,detail->top_donors_by_year")
          .in("slug", part);
        if (error) throw new Error(`Failed to load donor history: ${error.message}`);
        for (const row of data || []) {
          const byYear = row.top_donors_by_year || {};
          out.set(row.slug, merged ? await ID.rekeyDonorYears(byYear) : byYear);
        }
      }
    }));
    return out;
  }

  /** Rank donors using inclusive transaction dates, rather than calendar totals. */
  function getDonors({ start = null, end = null, filerIds = null } = {}) {
    const ids = filerIds === null ? null : [...new Set(filerIds
      .filter(id => id !== null && id !== undefined && String(id).trim())
      .map(id => String(id).trim()))].sort();
    if (ids && !ids.length) {
      return Promise.reject(new Error("A selected committee has no filer ID."));
    }
    const params = { p_start: start || null, p_end: end || null, p_filer_ids: ids };
    const key = JSON.stringify(params);
    if (!donorRequests.has(key)) {
      const request = (async () => {
        if (typeof DN !== "undefined") await DN.load();
        const sb = await getSupabase();
        const { data, error } = await sb.rpc("donor_leaderboard", params);
        if (error) throw new Error(`Failed to load donors: ${error.message}`);
        return names(data);
      })().catch(error => {
        donorRequests.delete(key);
        throw error;
      });
      donorRequests.set(key, request);
    }
    return donorRequests.get(key);
  }

  return { getBlob, getFilerDetail, getFilerDonorYears, getDonors };
})();

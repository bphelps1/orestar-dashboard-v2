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

  /** Fetch a whole-dashboard aggregate blob by key from dashboard_cache. */
  async function getBlob(key) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("dashboard_cache")
      .select("data")
      .eq("key", key)
      .single();
    if (error) throw new Error(`Failed to load '${key}': ${error.message}`);
    return data.data;
  }

  /** Fetch a single filer's detail blob by slug from filer_detail. */
  async function getFilerDetail(slug) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("filer_detail")
      .select("detail")
      .eq("slug", slug)
      .single();
    if (error) throw new Error(`Failed to load filer '${slug}': ${error.message}`);
    return data.detail;
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
        const sb = await getSupabase();
        const { data, error } = await sb.rpc("donor_leaderboard", params);
        if (error) throw new Error(`Failed to load donors: ${error.message}`);
        return data;
      })().catch(error => {
        donorRequests.delete(key);
        throw error;
      });
      donorRequests.set(key, request);
    }
    return donorRequests.get(key);
  }

  return { getBlob, getFilerDetail, getDonors };
})();

/**
 * lobbyists.js — shared reads for lobbyist ↔ donor attribution.
 *
 * Used by /admin/lobbyists (review) and /recommend (the By Lobbyist plan).
 * Tables are defined in supabase/migrations/016_lobbyists.sql; everything is
 * readable only when signed in.
 *
 * Requires lib/supabase.js (getSupabase) to be loaded first.
 */
"use strict";

const LOB = (() => {
  const PAGE = 1000;   // Supabase caps every response at 1,000 rows

  /** Read every row of a query, 1,000 at a time. `build` returns a fresh query. */
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < PAGE) return out;
    }
  }

  /** Rows whose `col` is in `values`, chunked so the URL stays short. */
  async function fetchIn(table, select, col, values, chunk = 150) {
    const sb = await getSupabase();
    const uniq = [...new Set(values)].filter(v => v !== null && v !== undefined && v !== "");
    const out = [];
    for (let i = 0; i < uniq.length; i += chunk) {
      const part = uniq.slice(i, i + chunk);
      out.push(...await fetchAll(() => sb.from(table).select(select).in(col, part)));
    }
    return out;
  }

  /** Mirror of scraper/lobby_match.norm_org — the client_key storage key. */
  function normOrg(name) {
    let s = String(name || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase();
    s = s.replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    return s.replace(/^the /, "");
  }

  /** A Postgres array literal. supabase-js's own array form does not quote
   *  elements, so a donor label with a comma ("Leadership Fund, The") would
   *  split in two. */
  function pgArray(values) {
    return "{" + values.map(v => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",") + "}";
  }

  /** Same key the dashboard uses for donor labels (donor_labels.donor_label_key). */
  function labelKey(name) {
    return String(name || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  }

  async function loadLobbyists() {
    const sb = await getSupabase();
    return fetchAll(() => sb.from("lobbyists").select("*").order("lobbyist_id"));
  }

  async function loadClients() {
    const sb = await getSupabase();
    return fetchAll(() => sb.from("lobbyist_clients").select("*").order("lobbyist_id"));
  }

  /**
   * Attribution for a set of donor labels (as shown on the Recommend page).
   * Returns Map<labelKey, [{lobbyist, status, methods, client_names, donor_id}]>,
   * strongest first. Rejected pairs never appear (the view drops them).
   */
  async function attributionForLabels(labels, lobbyistsById) {
    const keys = [...new Set(labels.map(labelKey))];
    // names is a text[]; match with the array-overlap operator in chunks.
    const sb = await getSupabase();
    const poolRows = [];
    for (let i = 0; i < keys.length; i += 80) {
      const part = keys.slice(i, i + 80);
      poolRows.push(...await fetchAll(() => sb.from("lobby_donor_pool")
        .select("donor_id,display_name,names").overlaps("names", pgArray(part))));
    }
    const donorToLabels = new Map();
    const wanted = new Set(keys);
    for (const r of poolRows) {
      const hits = (r.names || []).filter(n => wanted.has(n));
      if (hits.length) donorToLabels.set(r.donor_id, hits);
    }
    const attr = await fetchIn("donor_lobbyists", "*", "donor_id", [...donorToLabels.keys()]);
    const out = new Map();
    for (const a of attr) {
      const lob = lobbyistsById.get(a.lobbyist_id);
      if (!lob) continue;
      for (const label of donorToLabels.get(a.donor_id) || []) {
        if (!out.has(label)) out.set(label, []);
        const list = out.get(label);
        const prior = list.find(x => x.lobbyist.lobbyist_id === a.lobbyist_id);
        if (prior) {
          if (a.status === "confirmed") prior.status = "confirmed";
          prior.methods = [...new Set([...prior.methods, ...a.methods])];
          prior.client_names = [...new Set([...prior.client_names, ...a.client_names])];
          prior.is_primary = prior.is_primary || a.is_primary;
        } else {
          list.push({ lobbyist: lob, status: a.status, methods: a.methods || [],
                      client_names: a.client_names || [], donor_id: a.donor_id,
                      is_primary: !!a.is_primary, score: Number(a.score || 0) });
        }
      }
    }
    for (const list of out.values()) {
      list.sort((x, y) => (y.is_primary - x.is_primary)
        || ((y.status === "confirmed") - (x.status === "confirmed"))
        || (y.score - x.score)
        || x.lobbyist.name.localeCompare(y.lobbyist.name));
    }
    return out;
  }

  /** Human description of how a pair was attributed. */
  function describeMethod(m) {
    const client = m.startsWith("client:");
    const base = client ? m.slice(7) : m;
    const text = {
      email_exact: "committee contact's email is theirs",
      name_exact: client ? "donor name = client name" : "committee contact has their name",
      email_domain: "committee contact shares their email domain",
      director: "committee director works for their client",
      committee_contact: "committee director works for this client",
      name_fuzzy: "donor name resembles client name",
      tracker: "Fundraising Tracker lobbyist key",
      sheet_2024: "2024 lobby list",
      manual: "added by an admin",
      reviewed: "reviewed match",
    }[base] || base;
    return client ? `client (${text})` : text;
  }

  return { fetchAll, fetchIn, normOrg, labelKey, pgArray, loadLobbyists, loadClients,
           attributionForLabels, describeMethod };
})();

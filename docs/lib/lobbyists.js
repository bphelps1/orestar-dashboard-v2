/**
 * lobbyists.js — shared reads for lobbyist ↔ donor attribution.
 *
 * Used by /admin/lobbyists (review) and /recommend (the By Lobbyist plan).
 * Tables are defined in supabase/migrations/016_lobbyists.sql and 017_plan_designations.sql;
 * everything is readable only when signed in.
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

  /** Partner designations (017): Map<lobbyist_id, Set<"house|D">>. */
  async function loadPartners() {
    const sb = await getSupabase();
    const rows = await fetchAll(() => sb.from("lobbyist_partners").select("*").order("lobbyist_id"));
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.lobbyist_id)) out.set(r.lobbyist_id, new Set());
      out.get(r.lobbyist_id).add(`${r.chamber}|${r.party}`);
    }
    return out;
  }

  /** The people to call for each donor: Map<donor_id, [contact]>, primary first. */
  async function loadDonorContacts(donorIds) {
    const rows = await fetchIn("donor_contacts", "*", "donor_id", donorIds);
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.donor_id)) out.set(r.donor_id, []);
      out.get(r.donor_id).push(r);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order)
        || a.name.localeCompare(b.name));
    }
    return out;
  }

  /**
   * Everything the plan needs, keyed by the donor's identity.
   *
   * `donors` is [{ name, donor_id }] as the Recommend page has them. Matching
   * on donor_id is the whole point: the pool stores the raw transaction labels
   * ("oregon health care association pac (275)") while the dashboard shows the
   * resolved name ("Oregon Health Care Association PAC"), so a label lookup
   * missed 253 attributed donors — every PAC whose ORESTAR id is part of its
   * filed name. Labels with no id still fall back to the pool's name variants.
   *
   *   byKey      Map<donorKey, [{lobbyist, status, methods, client_names, …}]>
   *   contacts   Map<donorKey, [donor_contacts row]> — primary first
   *   bookTypes  Map<donorKey, book_type> — ORESTAR's contributor category
   */
  async function planAttribution(donors, lobbyistsById) {
    const idsByKey = new Map();          // donorKey → Set(donor_id)
    const keysById = new Map();          // donor_id → Set(donorKey)
    const add = (key, id) => {
      if (!idsByKey.has(key)) idsByKey.set(key, new Set());
      idsByKey.get(key).add(id);
      if (!keysById.has(id)) keysById.set(id, new Set());
      keysById.get(id).add(key);
    };
    const unresolved = new Map();        // labelKey → donorKey, for the fallback
    for (const d of donors) {
      const key = d.key || labelKey(d.name);
      if (d.donor_id) add(key, d.donor_id);
      else unresolved.set(labelKey(d.name), key);
      if (!idsByKey.has(key)) idsByKey.set(key, new Set());
    }
    if (unresolved.size) {
      for (const [label, id] of await _poolIdsForLabels([...unresolved.keys()])) {
        add(unresolved.get(label), id);
      }
    }

    const ids = [...keysById.keys()];
    const [attr, contactsByDonor, bookTypes] = await Promise.all([
      fetchIn("donor_lobbyists", "*", "donor_id", ids),
      loadDonorContacts(ids),
      loadBookTypes(ids),
    ]);

    const byKey = new Map();
    for (const a of attr) {
      const lob = lobbyistsById.get(a.lobbyist_id);
      if (!lob) continue;
      for (const key of keysById.get(a.donor_id) || []) {
        if (!byKey.has(key)) byKey.set(key, []);
        const list = byKey.get(key);
        const prior = list.find(x => x.lobbyist.lobbyist_id === a.lobbyist_id);
        if (prior) {
          if (a.status === "confirmed") prior.status = "confirmed";
          prior.methods = [...new Set([...prior.methods, ...a.methods])];
          prior.client_names = [...new Set([...prior.client_names, ...a.client_names])];
          prior.is_primary = prior.is_primary || a.is_primary;
          prior.score = Math.max(prior.score, Number(a.score || 0));
        } else {
          list.push({ lobbyist: lob, status: a.status, methods: a.methods || [],
                      client_names: a.client_names || [], donor_id: a.donor_id,
                      is_primary: !!a.is_primary, score: Number(a.score || 0) });
        }
      }
    }
    for (const list of byKey.values()) sortAttribution(list);

    const contacts = new Map();
    const types = new Map();
    for (const [key, idSet] of idsByKey) {
      const seen = new Set();
      const list = [];
      for (const id of idSet) {
        for (const c of contactsByDonor.get(id) || []) {
          if (seen.has(c.contact_id)) continue;
          seen.add(c.contact_id);
          list.push(c);
        }
        if (bookTypes.has(id) && !types.has(key)) types.set(key, bookTypes.get(id));
      }
      list.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));
      if (list.length) contacts.set(key, list);
    }
    // Anything still without a category is looked up by name.
    const noType = donors.filter(d => !types.has(d.key || labelKey(d.name)));
    if (noType.length) {
      const byName = await loadBookTypesByName(noType.map(d => d.name));
      for (const d of noType) {
        const hit = byName.get(String(d.name || "").trim().toLowerCase());
        if (hit) types.set(d.key || labelKey(d.name), hit);
      }
    }
    return { byKey, contacts, bookTypes: types };
  }

  function sortAttribution(list) {
    list.sort((x, y) => (y.is_primary - x.is_primary)
      || ((y.status === "confirmed") - (x.status === "confirmed"))
      || (y.score - x.score)
      || x.lobbyist.name.localeCompare(y.lobbyist.name));
  }

  /** ORESTAR's contributor category per donor ("Individual", "Business Entity"…). */
  async function loadBookTypes(donorIds) {
    const rows = await fetchIn("donors", "donor_id,book_type", "donor_id", donorIds);
    return new Map(rows.map(r => [r.donor_id, r.book_type]));
  }

  /**
   * The same categories for donors we could not resolve to an id.
   *
   * A committee's cached donor table can predate the resolver, leaving only a
   * label — and the label is usually a person, because the lobbyist pool holds
   * no individuals to fall back on. Looking the label up in `donors` gets
   * ORESTAR's own category rather than guessing from the shape of a name.
   * Returns Map<lowercased name, book_type>.
   */
  async function loadBookTypesByName(names) {
    const sb = await getSupabase();
    const clean = [...new Set(names.map(n => String(n || "").trim()).filter(Boolean))]
      .filter(n => !n.includes('"'));          // unquotable in a PostgREST or()
    const out = new Map();
    for (let i = 0; i < clean.length; i += 25) {
      const part = clean.slice(i, i + 25);
      const filter = part.map(n => `display_name.ilike."${n.replace(/[*]/g, "")}"`).join(",");
      const { data, error } = await sb.from("donors").select("display_name,book_type").or(filter);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        const key = r.display_name.trim().toLowerCase();
        if (!out.has(key)) out.set(key, r.book_type);
      }
    }
    return out;
  }

  /** Pool ids for labels we have no donor_id for: Map<labelKey, donor_id>. */
  async function _poolIdsForLabels(keys) {
    const sb = await getSupabase();
    const out = new Map();
    const wanted = new Set(keys);
    for (let i = 0; i < keys.length; i += 80) {
      const part = keys.slice(i, i + 80);
      for (const r of await fetchAll(() => sb.from("lobby_donor_pool")
          .select("donor_id,names").overlaps("names", pgArray(part)))) {
        for (const n of r.names || []) if (wanted.has(n) && !out.has(n)) out.set(n, r.donor_id);
      }
    }
    return out;
  }

  /**
   * Attribution for a set of donor labels.
   * Returns Map<labelKey, [{lobbyist, status, methods, client_names, donor_id}]>,
   * strongest first. Rejected pairs never appear (the view drops them).
   */
  async function attributionForLabels(labels, lobbyistsById) {
    return (await _attribution(labels, lobbyistsById)).byLabel;
  }

  /** attributionForLabels, also handing back the pool ids behind each label. */
  async function _attribution(labels, lobbyistsById) {
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
    const donorIds = new Map();
    for (const [donorId, hits] of donorToLabels) {
      for (const label of hits) {
        if (!donorIds.has(label)) donorIds.set(label, []);
        donorIds.get(label).push(donorId);
      }
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
    for (const list of out.values()) sortAttribution(list);
    return { byLabel: out, donorIds };
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
           loadPartners, loadDonorContacts, loadBookTypes, loadBookTypesByName,
           planAttribution, attributionForLabels, describeMethod };
})();

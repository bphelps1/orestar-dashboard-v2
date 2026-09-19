/**
 * lobbyists.js — review lobbyist ↔ donor attribution (/admin/lobbyists).
 *
 * Suggestions come from scraper/match_lobbyists.py. This page records the
 * human decision on each: confirm, reject, or a manual link the matcher
 * could not find. It never recomputes suggestions itself.
 *
 *   donor_lobbyist_links — direct donor → lobbyist (committee contacts,
 *                          Fundraising Tracker, manual)
 *   donor_client_links   — donor → Capitol Club client; the client's current
 *                          lobbyists inherit the donor
 */
"use strict";

const PAGE_SIZE = 50;
const CONTACT_METHODS = new Set(["email_exact", "name_exact", "email_domain", "director"]);

const S = {
  canWrite: false,
  who: "",
  lobbyists: new Map(),        // id → row
  clientsByLobbyist: new Map(),// id → [client rows]
  lobbyistsByClient: new Map(),// client_key → Set(id)
  clientNames: new Map(),      // client_key → display name
  dll: [],                     // donor_lobbyist_links
  dcl: [],                     // donor_client_links
  pool: new Map(),             // donor_id → pool row (loaded on demand)
  queueKind: "all",
  queueShown: PAGE_SIZE,
  lobShown: PAGE_SIZE,
  unmatchedRows: null,
  unmatchedType: "all",
  unmatchedShown: PAGE_SIZE,
  decisionStatus: "all",
  decisionShown: PAGE_SIZE,
  openLobbyist: null,
};

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt$(n) {
  return Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function now() { return new Date().toISOString(); }

// ── Auth ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth();
  if (session) {
    document.getElementById("user-info").textContent = session.user.email;
    S.who = session.user.email;
    S.canWrite = await isAdminOrReviewer();
    document.getElementById("role-banner").hidden = S.canWrite;
    try {
      await loadAll();
      wireUi();
      renderAll();
      document.getElementById("load-status").hidden = true;
    } catch (e) {
      const el = document.getElementById("load-status");
      el.className = "status-msg error";
      el.textContent = `Could not load: ${e.message}`;
      console.error(e);
    }
  }
  document.getElementById("login-form-el").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    try {
      await signIn(document.getElementById("login-email").value,
                   document.getElementById("login-password").value);
      window.location.reload();
    } catch (err) {
      errEl.textContent = err.message || "Sign-in failed";
      errEl.hidden = false;
    }
  });
  document.getElementById("sign-out-btn").addEventListener("click", signOut);
});

// ── Loading ─────────────────────────────────────────────────────────────────
async function loadAll() {
  const sb = await getSupabase();
  const [lobbyists, clients, dll, dcl] = await Promise.all([
    LOB.loadLobbyists(),
    LOB.loadClients(),
    LOB.fetchAll(() => sb.from("donor_lobbyist_links").select("*").order("donor_id")),
    LOB.fetchAll(() => sb.from("donor_client_links").select("*").order("donor_id")),
  ]);
  S.lobbyists = new Map(lobbyists.map(l => [l.lobbyist_id, l]));
  indexClients(clients);
  S.dll = dll;
  S.dcl = dcl;
  await ensurePool([...dll, ...dcl].map(r => r.donor_id));
}

function indexClients(clients) {
  S.clientsByLobbyist = new Map();
  S.lobbyistsByClient = new Map();
  S.clientNames = new Map();
  for (const c of clients) {
    if (!S.clientsByLobbyist.has(c.lobbyist_id)) S.clientsByLobbyist.set(c.lobbyist_id, []);
    S.clientsByLobbyist.get(c.lobbyist_id).push(c);
    if (!S.clientNames.has(c.client_key) || c.source === "capitol_club") S.clientNames.set(c.client_key, c.client_name);
    if (c.active) {
      if (!S.lobbyistsByClient.has(c.client_key)) S.lobbyistsByClient.set(c.client_key, new Set());
      S.lobbyistsByClient.get(c.client_key).add(c.lobbyist_id);
    }
  }
}

async function ensurePool(donorIds) {
  const missing = [...new Set(donorIds)].filter(id => !S.pool.has(id));
  if (!missing.length) return;
  const rows = await LOB.fetchIn("lobby_donor_pool",
    "donor_id,display_name,book_type,committee_id,total_since_2021,recipients,last_date,city,state",
    "donor_id", missing);
  for (const r of rows) S.pool.set(r.donor_id, r);
}

// ── Derived views ───────────────────────────────────────────────────────────
function queueItems() {
  const items = [];
  for (const r of S.dll) {
    if (r.status !== "suggested") continue;
    items.push({ table: "dll", row: r,
                 kind: CONTACT_METHODS.has(r.method) ? "contact" : r.method,
                 score: Number(r.score || 0) });
  }
  for (const r of S.dcl) {
    if (r.status !== "suggested") continue;
    const kind = r.method === "name_exact" ? "exact" : r.method === "name_fuzzy" ? "fuzzy" : "contact";
    items.push({ table: "dcl", row: r, kind, score: Number(r.score || 0) });
  }
  const donorTotal = id => Number(S.pool.get(id)?.total_since_2021 || 0);
  items.sort((a, b) => (b.score - a.score) || (donorTotal(b.row.donor_id) - donorTotal(a.row.donor_id)));
  return items;
}

/** donor_id → Set(lobbyist_id) for every non-rejected path. */
function attributedDonors() {
  const rejectedPairs = new Set(S.dll.filter(r => r.status === "rejected").map(r => `${r.donor_id}|${r.lobbyist_id}`));
  const out = new Map();
  const add = (d, l) => {
    if (rejectedPairs.has(`${d}|${l}`)) return;
    if (!out.has(d)) out.set(d, new Set());
    out.get(d).add(l);
  };
  for (const r of S.dll) if (r.status !== "rejected") add(r.donor_id, r.lobbyist_id);
  for (const r of S.dcl) {
    if (r.status === "rejected") continue;
    for (const l of S.lobbyistsByClient.get(r.client_key) || []) add(r.donor_id, l);
  }
  return out;
}

/** One entry per donor reaching this lobbyist, with every path that does. */
function donorsForLobbyist(id) {
  const byDonor = new Map();
  const add = (donorId, how, status) => {
    if (!byDonor.has(donorId)) byDonor.set(donorId, { donor_id: donorId, hows: [], statuses: new Set() });
    const d = byDonor.get(donorId);
    if (!d.hows.includes(how)) d.hows.push(how);
    d.statuses.add(status);
  };
  for (const r of S.dll) if (r.lobbyist_id === id) add(r.donor_id, LOB.describeMethod(r.method), r.status);
  const keys = new Set((S.clientsByLobbyist.get(id) || []).filter(c => c.active).map(c => c.client_key));
  for (const r of S.dcl) {
    if (keys.has(r.client_key) && r.status !== "rejected") add(r.donor_id, `via client ${r.client_name}`, r.status);
  }
  return [...byDonor.values()].map(d => ({
    ...d,
    // A direct rejection vetoes the pair whatever else reaches it.
    status: d.statuses.has("rejected") && S.dll.some(r => r.lobbyist_id === id && r.donor_id === d.donor_id && r.status === "rejected")
      ? "rejected" : d.statuses.has("confirmed") ? "confirmed" : "suggested",
  }));
}

// ── Rendering ───────────────────────────────────────────────────────────────
function renderAll() {
  renderStats();
  renderQueue();
  renderLobbyists();
  renderDecisions();
  refreshDatalists();
  if (document.getElementById("tab-unmatched").classList.contains("active")) renderUnmatched();
}

function renderStats() {
  const attributed = attributedDonors();
  const confirmedDonors = new Set([
    ...S.dll.filter(r => r.status === "confirmed").map(r => r.donor_id),
    ...S.dcl.filter(r => r.status === "confirmed").map(r => r.donor_id),
  ]);
  const onCc = [...S.lobbyists.values()].filter(l => l.on_capitol_club).length;
  const queue = queueItems().length;
  document.getElementById("lob-stats").innerHTML = `
    <div class="summary-card"><span class="sc-label">Lobbyists</span><br><span class="sc-value">${S.lobbyists.size}</span>
      <div class="sc-sub">${onCc} on Capitol Club</div></div>
    <div class="summary-card"><span class="sc-label">Donors attributed</span><br><span class="sc-value">${attributed.size}</span>
      <div class="sc-sub">${confirmedDonors.size} confirmed</div></div>
    <div class="summary-card"><span class="sc-label">Awaiting review</span><br><span class="sc-value">${queue}</span></div>`;
  document.getElementById("count-queue").textContent = queue;
  document.getElementById("count-lobbyists").textContent = S.lobbyists.size;
  document.getElementById("count-decisions").textContent =
    S.dll.filter(r => r.status !== "suggested").length + S.dcl.filter(r => r.status !== "suggested").length;
}

function donorBlock(id) {
  const d = S.pool.get(id);
  if (!d) return `<span class="lob-donor">${esc(id)}</span>`;
  const bits = [d.book_type, d.committee_id ? `ORESTAR #${d.committee_id}` : "",
                `${fmt$(d.total_since_2021)} since 2021`, `${d.recipients} recipient${d.recipients === 1 ? "" : "s"}`]
    .filter(Boolean);
  return `<span class="lob-donor">${esc(d.display_name)}</span><span class="lob-meta">${esc(bits.join(" · "))}</span>`;
}

function lobbyistBlock(l) {
  if (!l) return `<span class="lob-meta">unknown lobbyist</span>`;
  const bits = [l.kind === "firm" ? "Firm" : "", l.affiliation || l.firm, l.email, l.phone].filter(Boolean);
  const cc = l.on_capitol_club ? "" : ` <span class="badge badge-gray">not on Capitol Club</span>`;
  return `<a href="#" class="lob-name" data-open-lobbyist="${l.lobbyist_id}">${esc(l.name)}</a>${cc}
          <span class="lob-meta">${esc(bits.join(" · "))}</span>`;
}

function evidenceText(ev) {
  return (ev || []).map(e => {
    switch (e.type) {
      case "email_exact": case "name_exact": case "email_domain":
        if (e.role) {
          const role = { treasurer: "Treasurer", correspondence: "Correspondence recipient", director: "Director" }[e.role] || e.role;
          const why = { email_exact: "same email", name_exact: "same name", email_domain: "same email domain" }[e.type];
          return `${role} ${e.person}${e.email ? ` (${e.email})` : ""} — ${why}`;
        }
        return `Names match: “${e.donor_core}”`;
      case "director_employer":
        return `Director ${e.person} works for ${e.employer}`;
      case "name_fuzzy":
        return `Similar names: “${e.donor_core}” ~ “${e.client_core}”`;
      case "tracker":
        return `Fundraising Tracker: ${e.contributor} → ${e.label}`;
      case "manual":
        return `Added by ${e.by || "an admin"}`;
      case "review_note":
        return e.note;
      default:
        return e.type;
    }
  }).map(t => `<li>${esc(t)}</li>`).join("");
}

const KIND_LABEL = {
  contact: "Committee contact", exact: "Client name — exact", fuzzy: "Client name — similar",
  tracker: "Fundraising Tracker", manual: "Manual",
};

function filteredQueue() {
  const q = document.getElementById("queue-search").value.trim().toLowerCase();
  return queueItems().filter(it => {
    if (S.queueKind !== "all" && it.kind !== S.queueKind) return false;
    if (!q) return true;
    const d = S.pool.get(it.row.donor_id);
    const hay = [d?.display_name, it.row.client_name,
                 it.table === "dll" ? S.lobbyists.get(it.row.lobbyist_id)?.name : "",
                 ...[...(S.lobbyistsByClient.get(it.row.client_key) || [])].map(id => S.lobbyists.get(id)?.name)]
      .join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderQueue() {
  const items = filteredQueue();
  const list = document.getElementById("queue-list");
  if (!items.length) {
    list.innerHTML = `<p class="empty-msg">Nothing waiting for review here.</p>`;
    document.getElementById("queue-more").innerHTML = "";
    return;
  }
  list.innerHTML = items.slice(0, S.queueShown).map((it, i) => {
    const r = it.row;
    let target;
    if (it.table === "dll") {
      target = `<div class="lob-arrow">→ lobbyist</div>${lobbyistBlock(S.lobbyists.get(r.lobbyist_id))}`;
    } else {
      const lobs = [...(S.lobbyistsByClient.get(r.client_key) || [])].map(id => S.lobbyists.get(id)).filter(Boolean);
      target = `<div class="lob-arrow">→ client</div><span class="lob-donor">${esc(r.client_name)}</span>
        <span class="lob-meta">${lobs.length ? "Listed by " + lobs.map(l =>
          `<a href="#" data-open-lobbyist="${l.lobbyist_id}">${esc(l.name)}</a>`).join(", ") : "No current lobbyist lists this client"}</span>`;
    }
    return `<div class="cluster-card lob-card" data-q="${i}">
      <div class="cluster-key">${esc([KIND_LABEL[it.kind] || it.kind,
        it.table === "dll" && it.kind === "contact" ? LOB.describeMethod(r.method) : "",
        `score ${Math.round(it.score * 100)}`].filter(Boolean).join(" · "))}</div>
      <div class="lob-pair">
        <div>${donorBlock(r.donor_id)}</div>
        <div>${target}</div>
      </div>
      <ul class="pair-evidence">${evidenceText(r.evidence)}</ul>
      <div class="cluster-actions">
        <button class="btn-primary btn-compact" data-act="confirm" data-q="${i}" ${S.canWrite ? "" : "disabled"}>Confirm</button>
        <button class="btn-small" data-act="reject" data-q="${i}" ${S.canWrite ? "" : "disabled"}>Reject</button>
      </div>
    </div>`;
  }).join("");
  list._items = items;
  const more = document.getElementById("queue-more");
  more.innerHTML = items.length > S.queueShown
    ? `<button class="btn-small" id="queue-more-btn">Show more (${items.length - S.queueShown} left)</button>` : "";
}

function filteredLobbyists() {
  const q = document.getElementById("lob-search").value.trim().toLowerCase();
  const onlyAttr = document.getElementById("lob-only-attributed").checked;
  const offCc = document.getElementById("lob-show-off-cc").checked;
  const attributed = attributedDonors();
  const counts = new Map();
  for (const lobs of attributed.values()) for (const l of lobs) counts.set(l, (counts.get(l) || 0) + 1);
  let rows = [...S.lobbyists.values()].map(l => ({ l, donors: counts.get(l.lobbyist_id) || 0 }));
  if (!offCc) rows = rows.filter(r => r.l.on_capitol_club);
  if (onlyAttr) rows = rows.filter(r => r.donors > 0);
  if (q) {
    rows = rows.filter(({ l }) => [l.name, l.firm, l.affiliation, l.email, ...(l.aliases || []),
      ...(S.clientsByLobbyist.get(l.lobbyist_id) || []).map(c => c.client_name)].join(" ").toLowerCase().includes(q));
  }
  rows.sort((a, b) => (b.donors - a.donors) || a.l.name.localeCompare(b.l.name));
  return rows;
}

function renderLobbyists() {
  const rows = filteredLobbyists();
  const tbody = document.getElementById("lob-tbody");
  tbody.innerHTML = rows.slice(0, S.lobShown).map(({ l, donors }) => {
    const clients = (S.clientsByLobbyist.get(l.lobbyist_id) || []).filter(c => c.active).length;
    const source = { capitol_club: "Capitol Club", manual: "Added by admin", sheet_2024: "2024 list",
                     tracker: "Fundraising Tracker" }[l.source] || l.source;
    return `<tr class="lob-row${S.openLobbyist === l.lobbyist_id ? " open" : ""}" data-lobbyist="${l.lobbyist_id}">
      <td><a href="#" data-open-lobbyist="${l.lobbyist_id}" class="lob-name">${esc(l.name)}</a>
        ${l.kind === "firm" ? '<span class="badge badge-blue">firm</span>' : ""}
        <div class="lob-meta">${esc(l.affiliation || l.firm || "")}</div></td>
      <td class="lob-meta">${esc([l.email, l.phone].filter(Boolean).join(" · "))}</td>
      <td class="num">${clients}</td>
      <td class="num">${donors}</td>
      <td class="lob-meta">${esc(source)}${l.on_capitol_club ? "" : ' · <span class="badge badge-gray">not on CC</span>'}</td>
    </tr>${S.openLobbyist === l.lobbyist_id ? `<tr class="detail-row"><td colspan="5">${lobbyistDetail(l)}</td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="5" class="empty-msg">No lobbyists match.</td></tr>`;
  document.getElementById("lob-more").innerHTML = rows.length > S.lobShown
    ? `<button class="btn-small" id="lob-more-btn">Show more (${rows.length - S.lobShown} left)</button>` : "";
  wireDonorPickers(tbody);
}

function lobbyistDetail(l) {
  const clients = (S.clientsByLobbyist.get(l.lobbyist_id) || [])
    .sort((a, b) => (b.active - a.active) || a.client_name.localeCompare(b.client_name));
  const donors = donorsForLobbyist(l.lobbyist_id)
    .sort((a, b) => Number(S.pool.get(b.donor_id)?.total_since_2021 || 0) - Number(S.pool.get(a.donor_id)?.total_since_2021 || 0));
  const dis = S.canWrite ? "" : "disabled";
  const field = (name, label, cls = "") =>
    `<label class="${cls}">${label} <input name="${name}" value="${esc(l[name] || "")}" ${dis} /></label>`;
  return `<div class="lob-detail">
    <form class="lob-form lob-edit" data-lobbyist="${l.lobbyist_id}">
      <div class="lob-form-grid">
        ${field("name", "Name")}${field("firm", "Firm")}${field("affiliation", "Title / affiliation")}
        ${field("email", "Email")}${field("phone", "Phone")}${field("phone_alt", "Other phone")}
        ${field("address", "Address", "span-2")}${field("city", "City")}
        ${field("state", "State")}${field("zip", "ZIP")}
        <label class="span-2">Other names <input name="aliases" value="${esc((l.aliases || []).join("; "))}" ${dis} /></label>
        <label class="span-3">Notes <textarea name="notes" rows="2" ${dis}>${esc(l.notes || "")}</textarea></label>
      </div>
      ${l.on_capitol_club ? `<p class="lob-meta">Contact details refresh from Capitol Club on each scrape; edits to them will be overwritten.</p>` : ""}
      <div class="cluster-actions"><button type="submit" class="btn-small" ${dis}>Save details</button></div>
    </form>

    <div class="lob-cols">
      <div>
        <h4>Clients (${clients.filter(c => c.active).length} current)</h4>
        <ul class="lob-client-list">${clients.map(c => `
          <li class="${c.active ? "" : "inactive"}">
            ${esc(c.client_name)}
            <span class="badge ${c.source === "capitol_club" ? "badge-blue" : "badge-gray"}">${esc({ capitol_club: "Capitol Club", sheet_2024: "2024 list", manual: "manual" }[c.source] || c.source)}</span>
            ${c.active ? "" : '<span class="lob-meta">not current</span>'}
            ${c.source !== "capitol_club" && S.canWrite ? `<button class="link-btn" data-toggle-client="${esc(c.client_key)}" data-source="${esc(c.source)}" data-lobbyist="${l.lobbyist_id}">${c.active ? "mark not current" : "mark current"}</button>` : ""}
          </li>`).join("") || '<li class="lob-meta">None listed.</li>'}
        </ul>
        <form class="lob-inline" data-add-client="${l.lobbyist_id}">
          <input name="client" list="client-options" placeholder="Add a client…" ${dis} />
          <button class="btn-small" ${dis}>Add</button>
        </form>
      </div>
      <div>
        <h4>Donors attributed (${donors.length})</h4>
        <ul class="lob-client-list">${donors.map(d => {
          const p = S.pool.get(d.donor_id);
          const how = d.hows.join("; ");
          const status = d.status === "confirmed" ? '<span class="badge badge-green">confirmed</span>'
            : d.status === "rejected" ? '<span class="badge badge-red">rejected</span>' : '<span class="badge badge-gray">suggested</span>';
          return `<li>${esc(p?.display_name || d.donor_id)} <span class="lob-meta">${fmt$(p?.total_since_2021)} · ${esc(how)}</span> ${status}
            ${S.canWrite && d.status !== "rejected" ? `<button class="link-btn" data-drop-donor="${esc(d.donor_id)}" data-lobbyist="${l.lobbyist_id}">not theirs</button>` : ""}</li>`;
        }).join("") || '<li class="lob-meta">None yet.</li>'}
        </ul>
        <div class="lob-inline donor-picker" data-link-lobbyist="${l.lobbyist_id}">
          <input type="search" placeholder="Link a donor… (type a name)" ${dis} />
          <ul class="filer-results-dropdown" hidden></ul>
        </div>
      </div>
    </div>
  </div>`;
}

function renderDecisions() {
  const q = document.getElementById("decision-search").value.trim().toLowerCase();
  const rows = [
    ...S.dll.filter(r => r.status !== "suggested").map(r => ({ table: "dll", r })),
    ...S.dcl.filter(r => r.status !== "suggested").map(r => ({ table: "dcl", r })),
  ].filter(({ r }) => S.decisionStatus === "all" || r.status === S.decisionStatus)
   .filter(({ table, r }) => !q || [S.pool.get(r.donor_id)?.display_name, r.client_name,
      table === "dll" ? S.lobbyists.get(r.lobbyist_id)?.name : "", r.decided_by].join(" ").toLowerCase().includes(q))
   .sort((a, b) => String(b.r.decided_at || "").localeCompare(String(a.r.decided_at || "")));
  const tbody = document.getElementById("decision-tbody");
  tbody.innerHTML = rows.slice(0, S.decisionShown).map(({ table, r }, i) => `
    <tr>
      <td>${esc(S.pool.get(r.donor_id)?.display_name || r.donor_id)}</td>
      <td>${table === "dll" ? esc(S.lobbyists.get(r.lobbyist_id)?.name || r.lobbyist_id) : `client: ${esc(r.client_name)}`}</td>
      <td class="lob-meta">${esc(LOB.describeMethod(table === "dcl" ? "client:" + r.method : r.method))}</td>
      <td><span class="badge ${r.status === "confirmed" ? "badge-green" : "badge-red"}">${esc(r.status)}</span></td>
      <td class="lob-meta">${esc(r.decided_by || "")}</td>
      <td>${S.canWrite ? `<button class="link-btn" data-undo="${i}">undo</button>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty-msg">No decisions yet.</td></tr>`;
  tbody._rows = rows;
  document.getElementById("decision-more").innerHTML = rows.length > S.decisionShown
    ? `<button class="btn-small" id="decision-more-btn">Show more (${rows.length - S.decisionShown} left)</button>` : "";
}

async function loadUnmatched() {
  const sb = await getSupabase();
  const { data, error } = await sb.from("lobby_donor_pool")
    .select("donor_id,display_name,book_type,committee_id,total_since_2021,recipients,last_date,city,state")
    .order("total_since_2021", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  for (const r of data) S.pool.set(r.donor_id, r);
  S.unmatchedRows = data;
}

async function renderUnmatched() {
  const tbody = document.getElementById("unmatched-tbody");
  if (!S.unmatchedRows) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-msg">Loading…</td></tr>`;
    await loadUnmatched();
  }
  const covered = new Set([...S.dll, ...S.dcl].filter(r => r.status !== "rejected").map(r => r.donor_id));
  const q = document.getElementById("unmatched-search").value.trim().toLowerCase();
  const main = new Set(["Political Committee", "Business Entity", "Labor Organization"]);
  const rows = S.unmatchedRows.filter(d => !covered.has(d.donor_id))
    .filter(d => S.unmatchedType === "all" || (S.unmatchedType === "other" ? !main.has(d.book_type) : d.book_type === S.unmatchedType))
    .filter(d => !q || d.display_name.toLowerCase().includes(q));
  const dis = S.canWrite ? "" : "disabled";
  tbody.innerHTML = rows.slice(0, S.unmatchedShown).map(d => `
    <tr>
      <td>${esc(d.display_name)}${d.committee_id ? ` <span class="lob-meta">#${esc(d.committee_id)}</span>` : ""}
        <div class="lob-meta">${esc([d.city, d.state].filter(Boolean).join(", "))}</div></td>
      <td class="lob-meta">${esc(d.book_type || "")}</td>
      <td class="num">${fmt$(d.total_since_2021)}</td>
      <td class="num">${d.recipients}</td>
      <td class="lob-meta">${esc(d.last_date || "")}</td>
      <td>
        <form class="lob-inline" data-assign="${esc(d.donor_id)}">
          <input name="target" list="assign-options" placeholder="Lobbyist or client…" ${dis} />
          <button class="btn-small" ${dis}>Assign</button>
        </form>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty-msg">Every one of the top 1,000 donors here has an attribution or a pending suggestion.</td></tr>`;
  document.getElementById("unmatched-more").innerHTML = rows.length > S.unmatchedShown
    ? `<button class="btn-small" id="unmatched-more-btn">Show more (${rows.length - S.unmatchedShown} left)</button>` : "";
}

function lobbyistOptionLabel(l) {
  return `${l.name}${l.kind === "firm" ? " (firm)" : ""}${l.email ? " — " + l.email : ""} #${l.lobbyist_id}`;
}

function refreshDatalists() {
  const lobs = [...S.lobbyists.values()].sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("lobbyist-options").innerHTML =
    lobs.map(l => `<option value="${esc(lobbyistOptionLabel(l))}"></option>`).join("");
  const clients = [...S.clientNames.values()].sort((a, b) => a.localeCompare(b));
  document.getElementById("client-options").innerHTML =
    clients.map(c => `<option value="${esc(c)}"></option>`).join("");
  let assign = document.getElementById("assign-options");
  if (!assign) {
    assign = document.createElement("datalist");
    assign.id = "assign-options";
    document.body.appendChild(assign);
  }
  assign.innerHTML = lobs.map(l => `<option value="${esc(lobbyistOptionLabel(l))}"></option>`).join("")
    + clients.map(c => `<option value="client: ${esc(c)}"></option>`).join("");
}

// ── Writes ──────────────────────────────────────────────────────────────────
async function decide(table, row, status) {
  const sb = await getSupabase();
  const t = table === "dll" ? "donor_lobbyist_links" : "donor_client_links";
  const q = sb.from(t).update({ status, decided_by: S.who, decided_at: now(), updated_at: now() })
    .eq("donor_id", row.donor_id);
  const { error } = table === "dll" ? await q.eq("lobbyist_id", row.lobbyist_id) : await q.eq("client_key", row.client_key);
  if (error) throw new Error(error.message);
  Object.assign(row, { status, decided_by: S.who, decided_at: now() });
}

async function linkDonorToLobbyist(donorId, lobbyistId, status = "confirmed") {
  const sb = await getSupabase();
  const existing = S.dll.find(r => r.donor_id === donorId && r.lobbyist_id === lobbyistId);
  const row = {
    donor_id: donorId, lobbyist_id: lobbyistId,
    method: existing?.method || "manual", score: existing?.score ?? 1,
    evidence: existing?.evidence || [{ type: "manual", by: S.who }],
    status, decided_by: S.who, decided_at: now(), updated_at: now(),
  };
  const { error } = await sb.from("donor_lobbyist_links").upsert(row, { onConflict: "donor_id,lobbyist_id" });
  if (error) throw new Error(error.message);
  if (existing) Object.assign(existing, row); else S.dll.push(row);
}

async function linkDonorToClient(donorId, clientName) {
  const sb = await getSupabase();
  const key = LOB.normOrg(clientName);
  const row = {
    donor_id: donorId, client_key: key, client_name: S.clientNames.get(key) || clientName,
    method: "manual", score: 1, evidence: [{ type: "manual", by: S.who }],
    status: "confirmed", decided_by: S.who, decided_at: now(), updated_at: now(),
  };
  const { error } = await sb.from("donor_client_links").upsert(row, { onConflict: "donor_id,client_key" });
  if (error) throw new Error(error.message);
  const existing = S.dcl.find(r => r.donor_id === donorId && r.client_key === key);
  if (existing) Object.assign(existing, row); else S.dcl.push(row);
}

async function undoDecision(table, row) {
  const sb = await getSupabase();
  const t = table === "dll" ? "donor_lobbyist_links" : "donor_client_links";
  let q;
  if (row.method === "manual") {
    q = sb.from(t).delete().eq("donor_id", row.donor_id);
  } else {
    q = sb.from(t).update({ status: "suggested", decided_by: null, decided_at: null, updated_at: now() })
      .eq("donor_id", row.donor_id);
  }
  const { error } = table === "dll" ? await q.eq("lobbyist_id", row.lobbyist_id) : await q.eq("client_key", row.client_key);
  if (error) throw new Error(error.message);
  if (row.method === "manual") {
    const list = table === "dll" ? S.dll : S.dcl;
    list.splice(list.indexOf(row), 1);
  } else {
    Object.assign(row, { status: "suggested", decided_by: null, decided_at: null });
  }
}

async function addClient(lobbyistId, clientName) {
  const sb = await getSupabase();
  const row = { lobbyist_id: lobbyistId, client_key: LOB.normOrg(clientName), client_name: clientName.trim(),
                source: "manual", active: true };
  const { error } = await sb.from("lobbyist_clients").upsert(row, { onConflict: "lobbyist_id,client_key,source" });
  if (error) throw new Error(error.message);
  indexClients([...[...S.clientsByLobbyist.values()].flat().filter(c =>
    !(c.lobbyist_id === lobbyistId && c.client_key === row.client_key && c.source === "manual")), row]);
}

async function setClientActive(lobbyistId, clientKey, source, active) {
  const sb = await getSupabase();
  const { error } = await sb.from("lobbyist_clients").update({ active })
    .eq("lobbyist_id", lobbyistId).eq("client_key", clientKey).eq("source", source);
  if (error) throw new Error(error.message);
  const all = [...S.clientsByLobbyist.values()].flat();
  const c = all.find(x => x.lobbyist_id === lobbyistId && x.client_key === clientKey && x.source === source);
  if (c) c.active = active;
  indexClients(all);
}

function splitList(s) {
  return String(s || "").split(";").map(x => x.trim()).filter(Boolean);
}

async function saveNewLobbyist(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const sb = await getSupabase();
  const parts = f.name.trim().split(/\s+/);
  const row = {
    kind: f.kind, name: f.name.trim(),
    first_name: f.kind === "person" ? parts[0] : null,
    last_name: f.kind === "person" && parts.length > 1 ? parts[parts.length - 1] : null,
    firm: f.firm || (f.kind === "firm" ? f.name.trim() : null),
    email: (f.email || "").trim().toLowerCase() || null, phone: f.phone || null, phone_alt: f.phone_alt || null,
    address: f.address || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
    aliases: splitList(f.aliases), notes: f.notes || null, source: "manual",
  };
  const { data, error } = await sb.from("lobbyists").insert(row).select().single();
  if (error) throw new Error(error.message);
  S.lobbyists.set(data.lobbyist_id, data);
  for (const c of splitList(f.clients)) await addClient(data.lobbyist_id, c);
  return data;
}

async function saveLobbyistEdits(form) {
  const id = Number(form.dataset.lobbyist);
  const f = Object.fromEntries(new FormData(form).entries());
  const patch = {};
  for (const k of ["name", "firm", "affiliation", "email", "phone", "phone_alt", "address", "city", "state", "zip", "notes"]) {
    patch[k] = (f[k] || "").trim() || null;
  }
  if (patch.email) patch.email = patch.email.toLowerCase();
  patch.aliases = splitList(f.aliases);
  patch.updated_at = now();
  const sb = await getSupabase();
  const { data, error } = await sb.from("lobbyists").update(patch).eq("lobbyist_id", id).select().single();
  if (error) throw new Error(error.message);
  S.lobbyists.set(id, data);
}

// ── Donor search (for "Link a donor") ───────────────────────────────────────
function wireDonorPickers(root) {
  root.querySelectorAll(".donor-picker").forEach(box => {
    const input = box.querySelector("input");
    const list = box.querySelector("ul");
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        const sb = await getSupabase();
        const { data } = await sb.from("lobby_donor_pool")
          .select("donor_id,display_name,book_type,committee_id,total_since_2021,recipients,last_date,city,state")
          .ilike("display_name", `%${q.replace(/[%_]/g, "")}%`)
          .order("total_since_2021", { ascending: false }).limit(12);
        (data || []).forEach(r => S.pool.set(r.donor_id, r));
        list.innerHTML = (data || []).map(r => `<li data-donor="${esc(r.donor_id)}">
          <span>${esc(r.display_name)}</span><span class="filer-meta">${esc(r.book_type || "")} · ${fmt$(r.total_since_2021)} since 2021</span></li>`).join("")
          || `<li class="lob-meta">No donor since 2021 matches.</li>`;
        list.hidden = false;
      }, 200);
    });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 200));
    list.addEventListener("mousedown", async (e) => {
      const li = e.target.closest("li[data-donor]");
      if (!li) return;
      await guarded(async () => {
        await linkDonorToLobbyist(li.dataset.donor, Number(box.dataset.linkLobbyist));
        renderAll();
      });
    });
  });
}

// ── Events ──────────────────────────────────────────────────────────────────
async function guarded(fn) {
  try { await fn(); } catch (e) { alert(`Could not save: ${e.message}`); console.error(e); }
}

function chipGroup(id, onPick) {
  document.getElementById(id).addEventListener("click", (e) => {
    const b = e.target.closest(".lob-chip");
    if (!b) return;
    document.querySelectorAll(`#${id} .lob-chip`).forEach(c => c.classList.toggle("active", c === b));
    onPick(b.dataset);
  });
}

function openLobbyist(id, toggle = true) {
  const l = S.lobbyists.get(id);
  if (!document.getElementById("tab-lobbyists").classList.contains("active")) {
    document.querySelector('[data-admin-tab="tab-lobbyists"]').click();
    toggle = false;
  }
  S.openLobbyist = toggle && S.openLobbyist === id ? null : id;
  renderLobbyists();
  if (S.openLobbyist && !document.querySelector(`tr[data-lobbyist="${id}"]`) && l) {
    // Hidden by the current filters: search for them instead.
    document.getElementById("lob-search").value = l.name;
    document.getElementById("lob-show-off-cc").checked = true;
    document.getElementById("lob-only-attributed").checked = false;
    renderLobbyists();
  }
  document.querySelector(`tr[data-lobbyist="${id}"]`)?.scrollIntoView({ block: "center" });
}

function wireUi() {
  document.querySelectorAll(".admin-tab-btn").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("active", t.id === btn.dataset.adminTab));
    if (btn.dataset.adminTab === "tab-unmatched") renderUnmatched();
  }));

  chipGroup("queue-kind", d => { S.queueKind = d.kind; S.queueShown = PAGE_SIZE; renderQueue(); });
  chipGroup("unmatched-type", d => { S.unmatchedType = d.type; S.unmatchedShown = PAGE_SIZE; renderUnmatched(); });
  chipGroup("decision-status", d => { S.decisionStatus = d.status; renderDecisions(); });
  document.getElementById("queue-search").addEventListener("input", () => { S.queueShown = PAGE_SIZE; renderQueue(); });
  document.getElementById("lob-search").addEventListener("input", () => { S.lobShown = PAGE_SIZE; renderLobbyists(); });
  document.getElementById("lob-only-attributed").addEventListener("change", renderLobbyists);
  document.getElementById("lob-show-off-cc").addEventListener("change", renderLobbyists);
  document.getElementById("unmatched-search").addEventListener("input", () => renderUnmatched());
  document.getElementById("decision-search").addEventListener("input", renderDecisions);

  document.body.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-open-lobbyist]")) {
      e.preventDefault();
      openLobbyist(Number(t.closest("[data-open-lobbyist]").dataset.openLobbyist));
      return;
    }
    if (t.dataset.act) {
      const it = document.getElementById("queue-list")._items[Number(t.dataset.q)];
      t.disabled = true;
      await guarded(async () => {
        await decide(it.table, it.row, t.dataset.act === "confirm" ? "confirmed" : "rejected");
        renderAll();
      });
      return;
    }
    if (t.id === "queue-bulk") {
      const items = filteredQueue();
      if (!items.length || !S.canWrite) return;
      if (!confirm(`Confirm all ${items.length} suggestions currently shown?`)) return;
      t.disabled = true;
      await guarded(async () => {
        for (const it of items) await decide(it.table, it.row, "confirmed");
      });
      t.disabled = false;
      renderAll();
      return;
    }
    if (t.id === "queue-more-btn") { S.queueShown += PAGE_SIZE; renderQueue(); return; }
    if (t.id === "lob-more-btn") { S.lobShown += PAGE_SIZE; renderLobbyists(); return; }
    if (t.id === "unmatched-more-btn") { S.unmatchedShown += PAGE_SIZE; renderUnmatched(); return; }
    if (t.id === "decision-more-btn") { S.decisionShown += PAGE_SIZE; renderDecisions(); return; }
    if (t.id === "lob-add-btn") { document.getElementById("lob-add-form").hidden = false; return; }
    if (t.id === "lob-add-cancel") { document.getElementById("lob-add-form").hidden = true; return; }
    if (t.dataset.undo !== undefined) {
      const { table, r } = document.getElementById("decision-tbody")._rows[Number(t.dataset.undo)];
      await guarded(async () => { await undoDecision(table, r); renderAll(); });
      return;
    }
    if (t.dataset.dropDonor) {
      // "Not theirs" rejects this donor for this lobbyist only; a client link
      // stays in force for the client's other lobbyists.
      await guarded(async () => {
        await linkDonorToLobbyist(t.dataset.dropDonor, Number(t.dataset.lobbyist), "rejected");
        renderAll();
      });
      return;
    }
    if (t.dataset.toggleClient) {
      const lid = Number(t.dataset.lobbyist);
      const c = (S.clientsByLobbyist.get(lid) || []).find(x => x.client_key === t.dataset.toggleClient && x.source === t.dataset.source);
      await guarded(async () => { await setClientActive(lid, c.client_key, c.source, !c.active); renderAll(); });
    }
  });

  document.body.addEventListener("submit", async (e) => {
    const form = e.target;
    e.preventDefault();
    if (form.id === "lob-add-form") {
      await guarded(async () => {
        const l = await saveNewLobbyist(form);
        form.reset();
        form.hidden = true;
        renderAll();
        openLobbyist(l.lobbyist_id, false);
      });
    } else if (form.classList.contains("lob-edit")) {
      await guarded(async () => { await saveLobbyistEdits(form); renderAll(); });
    } else if (form.dataset.addClient) {
      const name = form.client.value.trim();
      if (!name) return;
      await guarded(async () => { await addClient(Number(form.dataset.addClient), name); renderAll(); });
    } else if (form.dataset.assign) {
      const v = form.target.value.trim();
      if (!v) return;
      await guarded(async () => {
        if (v.startsWith("client: ")) {
          await linkDonorToClient(form.dataset.assign, v.slice(8));
        } else {
          const id = Number((v.match(/#(\d+)$/) || [])[1]);
          if (!S.lobbyists.has(id)) throw new Error("Pick a lobbyist from the list (or type “client: …”).");
          await linkDonorToLobbyist(form.dataset.assign, id);
        }
        renderAll();
        renderUnmatched();
      });
    }
  });
}

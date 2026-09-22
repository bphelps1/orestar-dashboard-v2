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
 *   donor_contacts       — the people to call for a donor (017)
 */
"use strict";

const PAGE_SIZE = 50;
const CONTACT_METHODS = new Set(["email_exact", "name_exact", "email_domain", "director"]);
// Fields Capitol Club supplies; editing one here pins it (lobbyists.manual_fields).
const CC_EDITABLE = ["name", "affiliation", "email", "phone", "phone_alt", "address", "city", "state", "zip"];

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
  contacts: new Map(),         // donor_id → [donor_contacts rows]
  donorShown: PAGE_SIZE,
  openDonor: null,
  editing: null,               // key of the decision row being edited
};

// Democrats and nothing to the Senate Republicans.

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
  await DN.load();
  const sb = await getSupabase();
  const [lobbyists, clients, dll, dcl, contacts] = await Promise.all([
    LOB.loadLobbyists(),
    LOB.loadClients(),
    LOB.fetchAll(() => sb.from("donor_lobbyist_links").select("*").order("donor_id")),
    LOB.fetchAll(() => sb.from("donor_client_links").select("*").order("donor_id")),
    LOB.fetchAll(() => sb.from("donor_contacts").select("*").order("donor_id")),
  ]);
  S.lobbyists = new Map(lobbyists.map(l => [l.lobbyist_id, l]));
  indexClients(clients);
  S.dll = dll;
  S.dcl = dcl;
  indexContacts(contacts);
  await ensurePool([...dll, ...dcl, ...contacts].map(r => r.donor_id));
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

function indexContacts(rows) {
  S.contacts = new Map();
  for (const r of rows) {
    if (!S.contacts.has(r.donor_id)) S.contacts.set(r.donor_id, []);
    S.contacts.get(r.donor_id).push(r);
  }
  for (const list of S.contacts.values()) {
    list.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order)
      || a.name.localeCompare(b.name));
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
  // A member's primary contact relationship is also a client of their firm.
  for (const r of S.dll) {
    if (!r.is_primary || r.status === "rejected" || r.lobbyist_id === id) continue;
    const person = S.lobbyists.get(r.lobbyist_id);
    if (LOB.owningFirm(person, S.lobbyists)?.lobbyist_id === id)
      add(r.donor_id, `primary contact ${person.name} at this firm`, r.status);
  }
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
  renderDonors();
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
  document.getElementById("count-donors").textContent = attributed.size;
}

/**
 * The lobbyist a plan files this donor under, by the same rule as the
 * donor_lobbyists view: an explicit primary link wins, then the lead of a
 * client the donor is linked to, then nothing.
 */
function primaryFor(donorId) {
  const direct = S.dll.find(r => r.donor_id === donorId && r.is_primary && r.status !== "rejected");
  if (direct) {
    const person = S.lobbyists.get(direct.lobbyist_id), firm = LOB.owningFirm(person, S.lobbyists);
    const veto = S.dll.some(r => r.donor_id === donorId && r.lobbyist_id === firm?.lobbyist_id && r.status === "rejected");
    return { lobbyist: veto ? person : firm, why: "primary contact / firm lead" };
  }
  for (const c of S.dcl) {
    if (c.donor_id !== donorId || c.status === "rejected") continue;
    for (const lc of [...S.clientsByLobbyist.values()].flat()) {
      if (lc.client_key === c.client_key && lc.active && lc.is_lead) {
        return { lobbyist: LOB.owningFirm(S.lobbyists.get(lc.lobbyist_id), S.lobbyists), why: `lead for ${lc.client_name}` };
      }
    }
  }
  return null;
}

function donorBlock(id) {
  const d = S.pool.get(id);
  if (!d) return `<span class="lob-donor">${esc(id)}</span>`;
  const bits = [d.book_type, d.committee_id ? `ORESTAR #${d.committee_id}` : "",
                `${fmt$(d.total_since_2021)} since 2021`, `${d.recipients} recipient${d.recipients === 1 ? "" : "s"}`]
    .filter(Boolean);
  return `<span class="lob-donor">${esc(DN.display(d.display_name))}</span><span class="lob-meta">${esc(bits.join(" · "))}</span>`;
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
    const clients = editableClients(l.lobbyist_id).filter(c => c.active).length;
    const source = { capitol_club: "Capitol Club", manual: "Added by admin", sheet_2024: "2024 list",
                     tracker: "Fundraising Tracker" }[l.source] || l.source;
    return `<tr class="lob-row${S.openLobbyist === l.lobbyist_id ? " open" : ""}" data-lobbyist="${l.lobbyist_id}">
      <td><a href="#" data-open-lobbyist="${l.lobbyist_id}" class="lob-name">${esc(l.name)}</a>
        ${l.kind === "firm" ? '<span class="badge badge-blue">firm</span>' : ""}
        <div class="lob-meta">${esc(l.kind === "firm" ? "" : (l.affiliation || l.firm || ""))}</div></td>
      <td class="lob-meta">${esc(contactSummary(l))}</td>
      <td class="num">${clients}</td>
      <td class="num">${donors}</td>
      <td class="lob-meta">${esc(source)}${l.on_capitol_club ? "" : ' · <span class="badge badge-gray">not on CC</span>'}</td>
    </tr>${S.openLobbyist === l.lobbyist_id ? `<tr class="detail-row"><td colspan="5">${lobbyistDetail(l)}</td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="5" class="empty-msg">No lobbyists match.</td></tr>`;
  document.getElementById("lob-more").innerHTML = rows.length > S.lobShown
    ? `<button class="btn-small" id="lob-more-btn">Show more (${rows.length - S.lobShown} left)</button>` : "";
  wireDonorPickers(tbody);
}

/** A firm's contacts in order: the primary, then the other members. */
function firmMembers(f) {
  const ids = [...new Set([f.firm_primary_id, ...(f.firm_member_ids || [])].filter(Boolean))];
  return ids.map(id => S.lobbyists.get(id)).filter(Boolean);
}

function contactSummary(l) {
  if (l.kind === "firm" && !(l.email || l.phone)) {
    const p = S.lobbyists.get(l.firm_primary_id);
    return p ? `via ${p.name} · ${[p.email, p.phone].filter(Boolean).join(" · ")}` : "";
  }
  return [l.email, l.phone].filter(Boolean).join(" · ");
}

function firmMembersBlock(f) {
  const members = firmMembers(f);
  const w = S.canWrite;
  return `<div class="lob-firm-members">
    <h4>Firm contacts</h4>
    <p class="lob-meta">The primary's email and phone lead this firm's rows in a plan and its export; the
      others are listed after. Seeded from the fundraising sheets, keeping only people Capitol Club still
      lists at the firm.</p>
    <ul class="lob-client-list">${members.map(m => `
      <li>
        ${m.lobbyist_id === f.firm_primary_id ? '<span class="badge badge-green">primary</span>' : ""}
        <a href="#" data-open-lobbyist="${m.lobbyist_id}">${esc(m.name)}</a>
        <span class="lob-meta">${esc([m.email, m.phone].filter(Boolean).join(" · "))}</span>
        ${w && m.lobbyist_id !== f.firm_primary_id
          ? `<button class="link-btn" data-firm-primary="${m.lobbyist_id}" data-firm="${f.lobbyist_id}">make primary</button>` : ""}
        ${w ? `<button class="link-btn" data-firm-remove="${m.lobbyist_id}" data-firm="${f.lobbyist_id}">remove</button>` : ""}
      </li>`).join("") || '<li class="lob-meta">No contacts yet.</li>'}
    </ul>
    <form class="lob-inline" data-add-member="${f.lobbyist_id}">
      <input name="member" list="person-options" placeholder="Add a lobbyist to this firm…" ${w ? "" : "disabled"} />
      <button class="btn-small" ${w ? "" : "disabled"}>Add</button>
    </form>
  </div>`;
}

/** The firms a person is a contact for, editable from their own entry. */
function firmsForPersonBlock(l) {
  const firms = [...S.lobbyists.values()].filter(f => f.kind === "firm"
    && (f.firm_primary_id === l.lobbyist_id || (f.firm_member_ids || []).includes(l.lobbyist_id)));
  const w = S.canWrite;
  return `<div class="lob-firm-members">
    <h4>Firms</h4>
    <p class="lob-meta">Which firm entries list this person. The firm's primary leads its rows in a plan
      and its export.</p>
    <ul class="lob-client-list">${firms.map(f => `
      <li>
        ${f.firm_primary_id === l.lobbyist_id ? '<span class="badge badge-green">primary</span>' : ""}
        <a href="#" data-open-lobbyist="${f.lobbyist_id}">${esc(f.name)}</a>
        ${w && f.firm_primary_id !== l.lobbyist_id
          ? `<button class="link-btn" data-firm-primary="${l.lobbyist_id}" data-firm="${f.lobbyist_id}">make primary</button>` : ""}
        ${w ? `<button class="link-btn" data-firm-remove="${l.lobbyist_id}" data-firm="${f.lobbyist_id}">remove</button>` : ""}
      </li>`).join("") || '<li class="lob-meta">Not listed at any firm.</li>'}
    </ul>
    <form class="lob-inline" data-join-firm="${l.lobbyist_id}">
      <input name="firm" list="firm-options" placeholder="Add them to a firm…" ${w ? "" : "disabled"} />
      <button class="btn-small" ${w ? "" : "disabled"}>Add</button>
    </form>
  </div>`;
}

function lobbyistDetail(l) {
  const clients = editableClients(l.lobbyist_id);
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
      ${l.on_capitol_club ? `<p class="lob-meta">Contact details refresh from Capitol Club each week. A field you
        edit here is pinned and keeps your value${(l.manual_fields || []).length
          ? `: <strong>${esc((l.manual_fields || []).join(", "))}</strong>` : "."}</p>` : ""}
      <div class="cluster-actions"><button type="submit" class="btn-small" ${dis}>Save details</button>
        ${(l.manual_fields || []).length && S.canWrite
          ? `<button type="button" class="btn-small" data-revert-edits="${l.lobbyist_id}">Revert to Capitol Club</button>` : ""}</div>
    </form>

    ${l.kind === "firm" ? firmMembersBlock(l) : firmsForPersonBlock(l)}

    <div class="lob-cols">
      <div>
        <h4>Clients (${clients.filter(c => c.active).length} current)</h4>
        <p class="lob-meta">Remove a client from this lobbyist's list. Removals stay in effect after imports and can be restored below.</p>
        ${clientEditorList(l.lobbyist_id, clients.filter(c => c.active))}
        ${clients.some(c => !c.active) ? `<details><summary>Removed / inactive clients</summary>${clientEditorList(l.lobbyist_id, clients.filter(c => !c.active))}</details>` : ""}
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
          return `<li>${esc(DN.display(p?.display_name) || d.donor_id)} <span class="lob-meta">${fmt$(p?.total_since_2021)} · ${esc(how)}</span> ${status}
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

// ── Donors ──────────────────────────────────────────────────────────────────
function donorRowsForTab() {
  const known = new Set([...S.dll, ...S.dcl].filter(r => r.status !== "rejected").map(r => r.donor_id));
  for (const id of S.contacts.keys()) known.add(id);
  const onlyAttr = document.getElementById("donor-only-attributed").checked;
  const pool = onlyAttr ? [...known].map(id => S.pool.get(id)).filter(Boolean)
                        : [...new Set([...known, ...(S.unmatchedRows || []).map(r => r.donor_id)])]
                            .map(id => S.pool.get(id)).filter(Boolean);
  const q = document.getElementById("donor-search").value.trim().toLowerCase();
  const rows = q ? pool.filter(d => d.display_name.toLowerCase().includes(q)) : pool;
  return rows.sort((a, b) => Number(b.total_since_2021 || 0) - Number(a.total_since_2021 || 0));
}

async function renderDonors() {
  const tbody = document.getElementById("donor-tbody");
  if (!tbody) return;
  if (!document.getElementById("donor-only-attributed").checked && !S.unmatchedRows) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">Loading…</td></tr>`;
    await loadUnmatched();
  }
  const rows = donorRowsForTab();
  tbody.innerHTML = rows.slice(0, S.donorShown).map(d => {
    const p = primaryFor(d.donor_id);
    const contacts = S.contacts.get(d.donor_id) || [];
    const first = contacts[0];
    return `<tr class="lob-row${S.openDonor === d.donor_id ? " open" : ""}" data-donor-row="${esc(d.donor_id)}">
      <td><a href="#" data-open-donor="${esc(d.donor_id)}" class="lob-name">${esc(DN.display(d.display_name))}</a>
        <div class="lob-meta">${esc([d.book_type, d.committee_id ? `#${d.committee_id}` : ""].filter(Boolean).join(" · "))}</div></td>
      <td>${p?.lobbyist ? `${esc(p.lobbyist.name)}<div class="lob-meta">${esc(p.why)}</div>` : '<span class="lob-meta">—</span>'}</td>
      <td>${first ? `${esc(first.name)}<div class="lob-meta">${esc([first.email, first.phone].filter(Boolean).join(" · "))}</div>`
                  : '<span class="lob-meta">none recorded</span>'}</td>
      <td class="num">${fmt$(d.total_since_2021)}</td>
      <td class="num">${contacts.length}</td>
    </tr>${S.openDonor === d.donor_id ? `<tr class="detail-row"><td colspan="5">${donorDetail(d)}</td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="5" class="empty-msg">No donors match.</td></tr>`;
  document.getElementById("donor-more").innerHTML = rows.length > S.donorShown
    ? `<button class="btn-small" id="donor-more-btn">Show more (${rows.length - S.donorShown} left)</button>` : "";
}

/** Who this donor is filed under, and the people to call for it. */
function donorDetail(d) {
  const dis = S.canWrite ? "" : "disabled";
  const p = primaryFor(d.donor_id);
  const contacts = S.contacts.get(d.donor_id) || [];
  const links = [
    ...S.dll.filter(r => r.donor_id === d.donor_id).map(r => ({
      what: S.lobbyists.get(r.lobbyist_id)?.name || r.lobbyist_id, how: LOB.describeMethod(r.method), status: r.status })),
    ...S.dcl.filter(r => r.donor_id === d.donor_id).map(r => ({
      what: `client: ${r.client_name}`, how: LOB.describeMethod("client:" + r.method), status: r.status })),
  ];
  const badge = st => st === "confirmed" ? '<span class="badge badge-green">confirmed</span>'
    : st === "rejected" ? '<span class="badge badge-red">rejected</span>' : '<span class="badge badge-gray">suggested</span>';
  return `<div class="lob-detail">
    <div class="lob-cols">
      <div>
        <h4>Filed under</h4>
        <p class="lob-meta">The lobbyist or firm this donor appears under in a plan. Setting it here beats
          every other rule, so a donor never lands under two people.</p>
        <p>${p?.lobbyist ? `<strong>${esc(p.lobbyist.name)}</strong> <span class="lob-meta">(${esc(p.why)})</span>`
                         : '<span class="lob-meta">Nobody — the plan falls back to the strongest match.</span>'}</p>
        <form class="lob-inline" data-file-under="${esc(d.donor_id)}">
          <input name="target" list="lobbyist-options" placeholder="Firm or lobbyist…" ${dis} />
          <button class="btn-small" ${dis}>Set as primary</button>
        </form>
        ${p?.lobbyist && S.canWrite
          ? `<button class="link-btn" data-clear-primary="${esc(d.donor_id)}">clear</button>` : ""}
        <h4>Attributions</h4>
        <ul class="lob-client-list">${links.map(l =>
          `<li>${esc(l.what)} <span class="lob-meta">${esc(l.how)}</span> ${badge(l.status)}</li>`).join("")
          || '<li class="lob-meta">None yet.</li>'}</ul>
      </div>
      <div>
        <h4>Contacts (${contacts.length})</h4>
        <p class="lob-meta">Who to call at this donor. The primary leads the donor's row in a plan and its
          export; the rest follow.</p>
        <ul class="lob-client-list">${contacts.map(c => `
          <li>
            ${c.is_primary ? '<span class="badge badge-green">primary</span>' : ""}
            ${esc(c.name)}${c.title ? ` <span class="lob-meta">${esc(c.title)}</span>` : ""}
            <span class="lob-meta">${esc([c.email, c.phone].filter(Boolean).join(" · "))}</span>
            ${S.canWrite && !c.is_primary ? `<button class="link-btn" data-contact-primary="${c.contact_id}">make primary</button>` : ""}
            ${S.canWrite ? `<button class="link-btn" data-contact-remove="${c.contact_id}">remove</button>` : ""}
          </li>`).join("") || '<li class="lob-meta">None recorded.</li>'}
        </ul>
        <form class="lob-form lob-contact-form" data-add-contact="${esc(d.donor_id)}">
          <div class="lob-form-grid">
            <label>Name <input name="name" ${dis} /></label>
            <label>Title <input name="title" placeholder="Director of Government Affairs" ${dis} /></label>
            <label>Email <input name="email" type="email" ${dis} /></label>
            <label>Phone <input name="phone" ${dis} /></label>
            <label class="span-2">From the lobbyist list <input name="lobbyist" list="lobbyist-options"
              placeholder="Optional — fills the details" ${dis} /></label>
            <label class="lob-check span-1"><input type="checkbox" name="is_primary" ${dis} /> Primary</label>
          </div>
          <div class="cluster-actions"><button class="btn-small" ${dis}>Add contact</button></div>
        </form>
      </div>
    </div>
  </div>`;
}

function decisionKey(table, r) {
  return `${table}|${r.donor_id}|${table === "dll" ? r.lobbyist_id : r.client_key}`;
}

/** The last note an admin left on a decision, if any. */
function noteText(r) {
  const notes = (r.evidence || []).filter(e => e.type === "review_note");
  return notes.length ? `<div class="lob-meta">${esc(notes[notes.length - 1].note)}</div>` : "";
}

/**
 * Editing a decision in place. Moving it to another lobbyist or client is the
 * interesting case: the old pair is rejected (so the matcher does not suggest
 * it again) and the new one is created as a confirmed link, both carrying the
 * reason.
 */
function decisionEditor(table, r, i) {
  const isDll = table === "dll";
  return `<form class="lob-form lob-decision-edit" data-decision="${i}">
    <div class="lob-form-grid">
      <label>Decision
        <select name="status">
          <option value="confirmed"${r.status === "confirmed" ? " selected" : ""}>confirmed</option>
          <option value="rejected"${r.status === "rejected" ? " selected" : ""}>rejected</option>
        </select>
      </label>
      <label class="span-2">Move to ${isDll ? "another lobbyist or firm" : "another client"}
        <input name="move" list="${isDll ? "lobbyist-options" : "client-options"}"
               placeholder="${esc(isDll ? S.lobbyists.get(r.lobbyist_id)?.name || "" : r.client_name)}" />
      </label>
      ${isDll ? `<label class="lob-check"><input type="checkbox" name="is_primary"${r.is_primary ? " checked" : ""} />
        File the donor under them</label>` : '<div></div>'}
      <label class="span-2">Note <input name="note" placeholder="Why this is right — kept with the decision" /></label>
    </div>
    <div class="cluster-actions">
      <button type="submit" class="btn-small">Save</button>
      <button type="button" class="btn-small" data-cancel-edit="1">Cancel</button>
    </div>
  </form>`;
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
      <td><a href="#" class="lob-name" data-open-donor="${esc(r.donor_id)}">${esc(DN.display(S.pool.get(r.donor_id)?.display_name) || r.donor_id)}</a></td>
      <td>${table === "dll" ? esc(S.lobbyists.get(r.lobbyist_id)?.name || r.lobbyist_id) : `client: ${esc(r.client_name)}`}
        ${table === "dll" && r.is_primary ? '<span class="badge badge-green">primary</span>' : ""}</td>
      <td class="lob-meta">${esc(LOB.describeMethod(table === "dcl" ? "client:" + r.method : r.method))}${noteText(r)}</td>
      <td><span class="badge ${r.status === "confirmed" ? "badge-green" : "badge-red"}">${esc(r.status)}</span></td>
      <td class="lob-meta">${esc(r.decided_by || "")}</td>
      <td>${S.canWrite ? `<button class="link-btn" data-edit="${i}">edit</button>
                          <button class="link-btn" data-undo="${i}">undo</button>` : ""}</td>
    </tr>${S.editing === decisionKey(table, r) ? `<tr class="detail-row"><td colspan="6">${decisionEditor(table, r, i)}</td></tr>` : ""}`)
    .join("") || `<tr><td colspan="6" class="empty-msg">No decisions yet.</td></tr>`;
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
      <td>${esc(DN.display(d.display_name))}${d.committee_id ? ` <span class="lob-meta">#${esc(d.committee_id)}</span>` : ""}
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
    [...lobs].sort((a, b) => ((b.kind === "firm") - (a.kind === "firm")) || a.name.localeCompare(b.name))
      .map(l => `<option value="${esc(lobbyistOptionLabel(l))}"></option>`).join("");
  const clients = [...S.clientNames.values()].sort((a, b) => a.localeCompare(b));
  document.getElementById("client-options").innerHTML =
    clients.map(c => `<option value="${esc(c)}"></option>`).join("");
  let people = document.getElementById("person-options");
  if (!people) {
    people = document.createElement("datalist");
    people.id = "person-options";
    document.body.appendChild(people);
  }
  people.innerHTML = lobs.filter(l => l.kind === "person")
    .map(l => `<option value="${esc(lobbyistOptionLabel(l))}"></option>`).join("");
  let firms = document.getElementById("firm-options");
  if (!firms) {
    firms = document.createElement("datalist");
    firms.id = "firm-options";
    document.body.appendChild(firms);
  }
  firms.innerHTML = lobs.filter(l => l.kind === "firm")
    .map(l => `<option value="${esc(lobbyistOptionLabel(l))}"></option>`).join("");
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

async function linkDonorToLobbyist(donorId, lobbyistId, status = "confirmed", note = "") {
  const sb = await getSupabase();
  const existing = S.dll.find(r => r.donor_id === donorId && r.lobbyist_id === lobbyistId);
  const row = {
    donor_id: donorId, lobbyist_id: lobbyistId,
    method: existing?.method || "manual", score: existing?.score ?? 1,
    evidence: withNote(existing || { evidence: [{ type: "manual", by: S.who }] }, note),
    status, decided_by: S.who, decided_at: now(), updated_at: now(),
  };
  const { error } = await sb.from("donor_lobbyist_links").upsert(row, { onConflict: "donor_id,lobbyist_id" });
  if (error) throw new Error(error.message);
  if (existing) Object.assign(existing, row); else S.dll.push(row);
}

async function linkDonorToClient(donorId, clientName, note = "") {
  const sb = await getSupabase();
  const key = LOB.normOrg(clientName);
  const existing = S.dcl.find(r => r.donor_id === donorId && r.client_key === key);
  const row = {
    donor_id: donorId, client_key: key, client_name: S.clientNames.get(key) || clientName,
    method: "manual", score: 1,
    evidence: withNote(existing || { evidence: [{ type: "manual", by: S.who }] }, note),
    status: "confirmed", decided_by: S.who, decided_at: now(), updated_at: now(),
  };
  const { error } = await sb.from("donor_client_links").upsert(row, { onConflict: "donor_id,client_key" });
  if (error) throw new Error(error.message);
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
  await setClientActive(lobbyistId, LOB.normOrg(clientName), true, clientName.trim());
}

async function setClientActive(lobbyistId, clientKey, active, clientName = null) {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc("edit_lobbyist_client", {
    p_lobbyist_id: lobbyistId, p_client_key: clientKey, p_active: active, p_client_name: clientName,
  });
  if (error) throw new Error(error.message);
  const all = [...S.clientsByLobbyist.values()].flat().filter(c =>
    !(c.lobbyist_id === lobbyistId && c.client_key === clientKey));
  indexClients([...all, ...data]);
}

function clientEditorList(lobbyistId, clients) {
  return `<ul class="lob-client-list">${clients.map(c => `<li class="${c.active ? "" : "inactive"}">
    ${esc(c.client_name)} <span class="lob-meta">${esc(c.sources.map(s => ({capitol_club:"Capitol Club",sheet_2024:"2024 list",manual:"manual"}[s] || s)).join(", "))}</span>
    ${c.active && c.is_lead ? '<span class="badge badge-green">lead</span>' : ""}
    ${c.active && S.canWrite && (S.lobbyistsByClient.get(c.client_key)?.size || 0) > 1
      ? `<button type="button" class="link-btn" data-lead-client="${esc(c.client_key)}" data-lobbyist="${lobbyistId}" data-on="${c.is_lead ? "0" : "1"}">${c.is_lead ? "unset lead" : "make lead"}</button>` : ""}
    ${S.canWrite ? `<button type="button" class="link-btn" data-toggle-client="${esc(c.client_key)}" data-active="${c.active ? "0" : "1"}" data-lobbyist="${lobbyistId}">${c.active ? "Remove client" : "Restore client"}</button>` : ""}
    </li>`).join("") || '<li class="lob-meta">None listed.</li>'}</ul>`;
}

function editableClients(lobbyistId) {
  const grouped = new Map();
  for (const row of S.clientsByLobbyist.get(lobbyistId) || []) {
    const prior = grouped.get(row.client_key);
    if (!prior) grouped.set(row.client_key, { ...row, is_lead: row.active && row.is_lead, sources: [row.source] });
    else { prior.active ||= row.active; prior.is_lead ||= row.active && row.is_lead; prior.sources.push(row.source); }
  }
  return [...grouped.values()].sort((a,b) => Number(b.active)-Number(a.active) || a.client_name.localeCompare(b.client_name));
}

async function saveFirmMembers(firmId, primaryId, memberIds) {
  const members = [...new Set(memberIds.filter(Boolean))];
  const primary = members.includes(primaryId) ? primaryId : (members[0] || null);
  const ordered = primary ? [primary, ...members.filter(id => id !== primary)] : [];
  const sb = await getSupabase();
  const { data, error } = await sb.from("lobbyists")
    .update({ firm_primary_id: primary, firm_member_ids: ordered, updated_at: now() })
    .eq("lobbyist_id", firmId).select().single();
  if (error) throw new Error(error.message);
  S.lobbyists.set(firmId, data);
}

/** One lead per client: making someone lead clears it from the others. */
async function setClientLead(lobbyistId, clientKey, on) {
  const sb = await getSupabase();
  if (on) {
    const { error } = await sb.from("lobbyist_clients").update({ is_lead: false }).eq("client_key", clientKey);
    if (error) throw new Error(error.message);
  }
  const { error } = await sb.from("lobbyist_clients").update({ is_lead: on })
    .eq("client_key", clientKey).eq("lobbyist_id", lobbyistId);
  if (error) throw new Error(error.message);
  const all = [...S.clientsByLobbyist.values()].flat();
  for (const c of all) {
    if (c.client_key !== clientKey) continue;
    if (c.lobbyist_id === lobbyistId) c.is_lead = on;
    else if (on) c.is_lead = false;
  }
  indexClients(all);
}

/** Append a note to a link's evidence, which is what the page renders back. */
function withNote(row, note) {
  const ev = [...(row.evidence || [])];
  if (note) ev.push({ type: "review_note", note: `${note} — ${S.who}` });
  return ev;
}

/**
 * File a donor under one lobbyist or firm. The link is created if it does not
 * exist, confirmed if it does, and every other direct link for the donor loses
 * its primary flag — one donor, one primary.
 */
async function setDonorPrimary(donorId, lobbyistId, note = "filed under them by an admin") {
  const sb = await getSupabase();
  const existing = S.dll.find(r => r.donor_id === donorId && r.lobbyist_id === lobbyistId);
  const row = {
    donor_id: donorId, lobbyist_id: lobbyistId,
    method: existing?.method || "manual", score: existing?.score ?? 1,
    evidence: withNote(existing || { evidence: [{ type: "manual", by: S.who }] }, note),
    status: "confirmed", is_primary: true,
    decided_by: S.who, decided_at: now(), updated_at: now(),
  };
  const { error } = await sb.from("donor_lobbyist_links").upsert(row, { onConflict: "donor_id,lobbyist_id" });
  if (error) throw new Error(error.message);
  const others = S.dll.filter(r => r.donor_id === donorId && r.lobbyist_id !== lobbyistId && r.is_primary);
  for (const o of others) {
    const { error: e2 } = await sb.from("donor_lobbyist_links").update({ is_primary: false, updated_at: now() })
      .eq("donor_id", donorId).eq("lobbyist_id", o.lobbyist_id);
    if (e2) throw new Error(e2.message);
    o.is_primary = false;
  }
  if (existing) Object.assign(existing, row); else S.dll.push(row);
}

async function clearDonorPrimary(donorId) {
  const sb = await getSupabase();
  const { error } = await sb.from("donor_lobbyist_links").update({ is_primary: false, updated_at: now() })
    .eq("donor_id", donorId).eq("is_primary", true);
  if (error) throw new Error(error.message);
  for (const r of S.dll) if (r.donor_id === donorId) r.is_primary = false;
}

// ── Donor contacts ──────────────────────────────────────────────────────────
async function clearContactPrimary(donorId) {
  const sb = await getSupabase();
  const { error } = await sb.from("donor_contacts").update({ is_primary: false, updated_at: now() })
    .eq("donor_id", donorId).eq("is_primary", true);
  if (error) throw new Error(error.message);
  for (const c of S.contacts.get(donorId) || []) c.is_primary = false;
}

async function addDonorContact(donorId, fields) {
  const sb = await getSupabase();
  // The unique index allows one primary per donor, so clear the old one first.
  if (fields.is_primary) await clearContactPrimary(donorId);
  const row = {
    donor_id: donorId, lobbyist_id: fields.lobbyist_id || null,
    name: fields.name, title: fields.title || null,
    email: (fields.email || "").toLowerCase() || null, phone: fields.phone || null,
    is_primary: !!fields.is_primary,
    sort_order: (S.contacts.get(donorId) || []).length,
    created_by: S.who,
  };
  const { data, error } = await sb.from("donor_contacts").insert(row).select().single();
  if (error) throw new Error(error.message);
  if (!S.contacts.has(donorId)) S.contacts.set(donorId, []);
  S.contacts.get(donorId).push(data);
  indexContacts([...S.contacts.values()].flat());
}

async function setContactPrimary(contactId) {
  const all = [...S.contacts.values()].flat();
  const c = all.find(x => x.contact_id === contactId);
  if (!c) return;
  await clearContactPrimary(c.donor_id);
  const sb = await getSupabase();
  const { error } = await sb.from("donor_contacts").update({ is_primary: true, updated_at: now() })
    .eq("contact_id", contactId);
  if (error) throw new Error(error.message);
  c.is_primary = true;
  indexContacts(all);
}

async function removeDonorContact(contactId) {
  const sb = await getSupabase();
  const { error } = await sb.from("donor_contacts").delete().eq("contact_id", contactId);
  if (error) throw new Error(error.message);
  const all = [...S.contacts.values()].flat().filter(c => c.contact_id !== contactId);
  indexContacts(all);
}

// ── Editing a recorded decision ─────────────────────────────────────────────
async function saveDecisionEdit(table, row, form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const note = (f.note || "").trim();
  const move = (f.move || "").trim();
  const sb = await getSupabase();

  if (move) {
    // Reassignment: reject the old pair so the matcher leaves it alone, then
    // record the new one as a confirmed link.
    const why = note || (table === "dll" ? "reassigned by an admin" : "moved to another client");
    const t = table === "dll" ? "donor_lobbyist_links" : "donor_client_links";
    const q = sb.from(t).update({ status: "rejected", evidence: withNote(row, why),
                                  is_primary: false, decided_by: S.who, decided_at: now(), updated_at: now() })
      .eq("donor_id", row.donor_id);
    const { error } = table === "dll" ? await q.eq("lobbyist_id", row.lobbyist_id) : await q.eq("client_key", row.client_key);
    if (error) throw new Error(error.message);
    Object.assign(row, { status: "rejected", is_primary: false, decided_by: S.who, decided_at: now(),
                         evidence: withNote(row, why) });
    if (table === "dll") {
      const id = Number((move.match(/#(\d+)$/) || [])[1]);
      if (!S.lobbyists.has(id)) throw new Error("Pick a lobbyist from the list.");
      if (f.is_primary) await setDonorPrimary(row.donor_id, id, why);
      else await linkDonorToLobbyist(row.donor_id, id, "confirmed", why);
    } else {
      await linkDonorToClient(row.donor_id, move, why);
    }
    return;
  }

  const t = table === "dll" ? "donor_lobbyist_links" : "donor_client_links";
  const patch = { status: f.status, evidence: withNote(row, note),
                  decided_by: S.who, decided_at: now(), updated_at: now() };
  if (table === "dll") patch.is_primary = f.status === "rejected" ? false : !!f.is_primary;
  const q = sb.from(t).update(patch).eq("donor_id", row.donor_id);
  const { error } = table === "dll" ? await q.eq("lobbyist_id", row.lobbyist_id) : await q.eq("client_key", row.client_key);
  if (error) throw new Error(error.message);
  Object.assign(row, patch);
  // Only one primary per donor.
  if (table === "dll" && patch.is_primary) {
    for (const r of S.dll) {
      if (r.donor_id === row.donor_id && r.lobbyist_id !== row.lobbyist_id && r.is_primary) {
        const { error: e2 } = await sb.from("donor_lobbyist_links")
          .update({ is_primary: false, updated_at: now() })
          .eq("donor_id", r.donor_id).eq("lobbyist_id", r.lobbyist_id);
        if (e2) throw new Error(e2.message);
        r.is_primary = false;
      }
    }
  }
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
  const l = S.lobbyists.get(id) || {};
  const f = Object.fromEntries(new FormData(form).entries());
  const patch = {};
  for (const k of ["name", "firm", "affiliation", "email", "phone", "phone_alt", "address", "city", "state", "zip", "notes"]) {
    patch[k] = (f[k] || "").trim() || null;
  }
  if (patch.email) patch.email = patch.email.toLowerCase();
  patch.aliases = splitList(f.aliases);
  // Remember which fields were typed here. The weekly Capitol Club refresh
  // rewrites a member's card, and would otherwise undo the correction.
  const manual = new Set(l.manual_fields || []);
  for (const k of CC_EDITABLE) if ((patch[k] || "") !== (l[k] || "")) manual.add(k);
  patch.manual_fields = [...manual];
  if (manual.has("name") && l.kind === "person") {
    const parts = patch.name.split(/\s+/);
    patch.first_name = parts[0];
    patch.last_name = parts.length > 1 ? parts[parts.length - 1] : null;
  }
  patch.updated_at = now();
  const sb = await getSupabase();
  const { data, error } = await sb.from("lobbyists").update(patch).eq("lobbyist_id", id).select().single();
  if (error) throw new Error(error.message);
  S.lobbyists.set(id, data);
}

/** Hand the listed fields back to the Capitol Club scrape. */
async function revertLobbyistEdits(id) {
  const sb = await getSupabase();
  const { data, error } = await sb.from("lobbyists").update({ manual_fields: [], updated_at: now() })
    .eq("lobbyist_id", id).select().single();
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
          <span>${esc(DN.display(r.display_name))}</span><span class="filer-meta">${esc(r.book_type || "")} · ${fmt$(r.total_since_2021)} since 2021</span></li>`).join("")
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

function openDonor(id, toggle = true) {
  if (!document.getElementById("tab-donors").classList.contains("active")) {
    document.querySelector('[data-admin-tab="tab-donors"]').click();
    toggle = false;
  }
  S.openDonor = toggle && S.openDonor === id ? null : id;
  renderDonors().then(() => {
    if (S.openDonor && !document.querySelector(`tr[data-donor-row="${CSS.escape(id)}"]`)) {
      // Hidden by the current filters: search for it instead.
      const d = S.pool.get(id);
      if (d) document.getElementById("donor-search").value = d.display_name;
      document.getElementById("donor-only-attributed").checked = false;
      return renderDonors();
    }
  }).then(() => {
    document.querySelector(`tr[data-donor-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
  });
}

function wireUi() {
  document.querySelectorAll(".admin-tab-btn").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("active", t.id === btn.dataset.adminTab));
    if (btn.dataset.adminTab === "tab-unmatched") renderUnmatched();
    if (btn.dataset.adminTab === "tab-donors") renderDonors();
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
  document.getElementById("donor-search").addEventListener("input", () => { S.donorShown = PAGE_SIZE; renderDonors(); });
  document.getElementById("donor-only-attributed").addEventListener("change", () => { S.donorShown = PAGE_SIZE; renderDonors(); });

  document.body.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-open-lobbyist]")) {
      e.preventDefault();
      openLobbyist(Number(t.closest("[data-open-lobbyist]").dataset.openLobbyist));
      return;
    }
    if (t.closest("[data-open-donor]")) {
      e.preventDefault();
      openDonor(t.closest("[data-open-donor]").dataset.openDonor);
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
    if (t.id === "donor-more-btn") { S.donorShown += PAGE_SIZE; renderDonors(); return; }
    if (t.dataset.edit !== undefined) {
      const { table, r } = document.getElementById("decision-tbody")._rows[Number(t.dataset.edit)];
      const key = decisionKey(table, r);
      S.editing = S.editing === key ? null : key;
      renderDecisions();
      return;
    }
    if (t.dataset.cancelEdit) { S.editing = null; renderDecisions(); return; }
    if (t.dataset.revertEdits) {
      await guarded(async () => { await revertLobbyistEdits(Number(t.dataset.revertEdits)); renderAll(); });
      return;
    }
    if (t.dataset.clearPrimary) {
      await guarded(async () => { await clearDonorPrimary(t.dataset.clearPrimary); renderAll(); });
      return;
    }
    if (t.dataset.contactPrimary) {
      await guarded(async () => { await setContactPrimary(Number(t.dataset.contactPrimary)); renderAll(); });
      return;
    }
    if (t.dataset.contactRemove) {
      await guarded(async () => { await removeDonorContact(Number(t.dataset.contactRemove)); renderAll(); });
      return;
    }
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
    if (t.dataset.firmPrimary || t.dataset.firmRemove) {
      const firm = S.lobbyists.get(Number(t.dataset.firm));
      const ids = firmMembers(firm).map(m => m.lobbyist_id);
      await guarded(async () => {
        if (t.dataset.firmPrimary) {
          await saveFirmMembers(firm.lobbyist_id, Number(t.dataset.firmPrimary), ids);
        } else {
          const gone = Number(t.dataset.firmRemove);
          const rest = ids.filter(id => id !== gone);
          await saveFirmMembers(firm.lobbyist_id, firm.firm_primary_id === gone ? rest[0] : firm.firm_primary_id, rest);
        }
        renderAll();
      });
      return;
    }
    if (t.dataset.leadClient) {
      await guarded(async () => {
        await setClientLead(Number(t.dataset.lobbyist), t.dataset.leadClient, t.dataset.on === "1");
        renderAll();
      });
      return;
    }
    if (t.dataset.toggleClient) {
      const lid = Number(t.dataset.lobbyist);
      await guarded(async () => { await setClientActive(lid, t.dataset.toggleClient, t.dataset.active === "1"); renderAll(); });
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
    } else if (form.dataset.addMember) {
      const v = form.member.value.trim();
      const id = Number((v.match(/#(\d+)$/) || [])[1]);
      await guarded(async () => {
        if (!S.lobbyists.has(id)) throw new Error("Pick a lobbyist from the list.");
        const firm = S.lobbyists.get(Number(form.dataset.addMember));
        const ids = firmMembers(firm).map(m => m.lobbyist_id);
        await saveFirmMembers(firm.lobbyist_id, firm.firm_primary_id || id, [...ids, id]);
        renderAll();
      });
    } else if (form.classList.contains("lob-decision-edit")) {
      const { table, r } = document.getElementById("decision-tbody")._rows[Number(form.dataset.decision)];
      await guarded(async () => {
        await saveDecisionEdit(table, r, form);
        S.editing = null;
        renderAll();
      });
    } else if (form.dataset.fileUnder) {
      const v = form.target.value.trim();
      if (!v) return;
      await guarded(async () => {
        const id = Number((v.match(/#(\d+)$/) || [])[1]);
        if (!S.lobbyists.has(id)) throw new Error("Pick a lobbyist or firm from the list.");
        await setDonorPrimary(form.dataset.fileUnder, id);
        form.reset();
        renderAll();
      });
    } else if (form.dataset.addContact) {
      const f = Object.fromEntries(new FormData(form).entries());
      await guarded(async () => {
        const picked = Number((String(f.lobbyist || "").match(/#(\d+)$/) || [])[1]);
        const l = S.lobbyists.get(picked);
        const fields = {
          lobbyist_id: l ? l.lobbyist_id : null,
          name: (f.name || l?.name || "").trim(),
          title: (f.title || l?.affiliation || "").trim(),
          email: (f.email || l?.email || "").trim(),
          phone: (f.phone || l?.phone || "").trim(),
          is_primary: !!f.is_primary,
        };
        if (!fields.name) throw new Error("A contact needs a name.");
        await addDonorContact(form.dataset.addContact, fields);
        form.reset();
        renderAll();
      });
    } else if (form.dataset.joinFirm) {
      const v = form.firm.value.trim();
      await guarded(async () => {
        const firmId = Number((v.match(/#(\d+)$/) || [])[1]);
        const firm = S.lobbyists.get(firmId);
        if (!firm || firm.kind !== "firm") throw new Error("Pick a firm from the list.");
        const person = Number(form.dataset.joinFirm);
        const ids = firmMembers(firm).map(m => m.lobbyist_id);
        await saveFirmMembers(firm.lobbyist_id, firm.firm_primary_id || person, [...ids, person]);
        renderAll();
      });
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

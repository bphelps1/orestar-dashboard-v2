/** Saved entity merges are read-through identities; refresh the page to read
 * the latest decisions. Raw transaction records and reviewed links stay intact.
 */
"use strict";
const ID = (() => {
  let mapping, labels, filers;
  const labelKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  async function readAll(table) {
    const sb = await getSupabase();
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await sb.from(table).select('*').order(
        table === 'donor_identity_map' ? 'donor_id' : table === 'donor_identity_labels' ? 'label' : 'filer_id'
      ).range(start, start + 999);
      if (error) throw new Error(`Could not read saved donor merges: ${error.message}`);
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  function loadMap() {
    if (!mapping) mapping = readAll('donor_identity_map').then(rows => new Map(rows.map(r => [r.donor_id, r])))
      .catch(error => { mapping = null; throw error; });
    return mapping;
  }
  async function hasMerges() { return (await loadMap()).size > 0; }
  async function affectsFilers(ids) {
    if (!await hasMerges()) return false;
    if (!filers) filers = readAll('donor_merge_filers').then(rows => new Set(rows.map(r => String(r.filer_id))))
      .catch(error => { filers = null; throw error; });
    const affected = await filers;
    return ids.some(id => affected.has(String(id)));
  }
  async function members(id) {
    const map = await loadMap();
    const canonical = map.get(id)?.canonical_id || id;
    return [...new Set([canonical, ...[...map.values()].filter(r => r.canonical_id === canonical).map(r => r.donor_id)])];
  }
  async function rekeyBlob(blob) {
    const map = await loadMap();
    if (!map.size) return blob;
    if (!labels) labels = readAll('donor_identity_labels').then(rows => new Map(rows.map(r => [r.label, r])))
      .catch(error => { labels = null; throw error; });
    const names = await labels;
    function rows(items) {
      const out = new Map();
      for (const item of items) {
        const identity = item.donor_id || item.donor_key;
        const match = identity ? map.get(identity) : names.get(labelKey(item.name));
        const key = match?.canonical_id || identity || `name:${labelKey(item.name)}`;
        const row = match ? { ...item, name: match.canonical_name, donor_id: key, donor_key: key } : { ...item };
        if (out.has(key)) out.get(key).total += Number(row.total || 0);
        else out.set(key, { ...row, total: Number(row.total || 0) });
      }
      return [...out.values()].sort((a,b) => b.total-a.total);
    }
    function walk(value, key) {
      if (Array.isArray(value)) return key === 'top_donors' ? rows(value) : value.map(v => walk(v));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,walk(v,k)]));
      return value;
    }
    return walk(blob);
  }
  return { loadMap, hasMerges, affectsFilers, members, rekeyBlob };
})();

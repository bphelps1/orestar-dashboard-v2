/** Reviewed public portraits. No remote image requests during app use or export. */
"use strict";
const LP = (() => {
  let photos = {}, pending;
  const bytes = new Map();
  const nameKey = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  const validPath = p => /^assets\/lobbyist-photos\/user-\d+-[a-f0-9]{12}\.jpg$/.test(p || '');
  async function load() {
    if (!pending) pending = (async () => {
      const response = await fetch('assets/lobbyist-photos.json', {cache:'no-cache',signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw Error('Portrait catalog unavailable');
      const data = await response.json();
      if (data.version !== 1 || !data.photos || typeof data.photos !== 'object') throw Error('Invalid portrait catalog');
      photos = Object.fromEntries(Object.entries(data.photos).filter(([id,p]) =>
        /^user-\d+$/.test(id) && p && typeof p.name === 'string' && validPath(p.path)));
    })().catch(error => { pending = null; console.warn('Lobbyist portraits:', error.message); });
    return pending;
  }
  function get(person) {
    if (!person || person.kind === 'firm') return null;
    if (person.cc_id) return photos[person.cc_id] || null;
    // Manual contacts may lack a directory ID. Require a unique exact full
    // name; never guess from initials, surname, fuzzy matching, or appearance.
    const names = new Set([person.name, ...(person.aliases || [])].map(nameKey).filter(Boolean));
    const matches = Object.values(photos).filter(p => names.has(nameKey(p.name)));
    return matches.length === 1 ? matches[0] : null;
  }
  async function image(person) {
    const photo = get(person);
    if (!photo) return null;
    if (!bytes.has(photo.path)) bytes.set(photo.path,(async()=>{
      try {
        const response = await fetch(photo.path, {signal:AbortSignal.timeout(5000)});
        if (!response.ok) return null;
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length > 200000 || data[0] !== 255 || data[1] !== 216) return null;
        return {data,photo};
      } catch { return null; }
    })());
    const result = await bytes.get(photo.path);
    if (!result) bytes.delete(photo.path); // allow a later export to retry
    return result;
  }
  return {load,get,image};
})();

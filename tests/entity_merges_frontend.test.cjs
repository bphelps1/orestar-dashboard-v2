'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '../docs/admin/donors.js'), 'utf8');
function harness(error = null) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, value: '' });
    return elements.get(id);
  };
  const writes = [];
  const ctx = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] },
    getSession: async () => ({ user: { email: 'admin@example.test' } }),
    getSupabase: async () => ({ from: () => ({ upsert: async rows => { writes.push(rows); return { error }; } }) }),
    emLoadList: async () => {},
  });
  vm.runInContext(src.slice(src.indexOf('const emState ='), src.indexOf('async function emLoadList('))
    + '\nemRenderCard = () => {}; this.state = emState;', ctx);
  ctx.state.a = { donor_id: 'a', rep_alias_key: 'z|a', display_name: 'Keep' };
  ctx.state.selected.set('b', { donor_id: 'b', rep_alias_key: 'b|a', display_name: 'Alias B' });
  ctx.state.selected.set('c', { donor_id: 'c', rep_alias_key: 'c|a', display_name: 'Alias C' });
  return { ctx, writes, element };
}
test('bulk merge is a single atomic upsert with labels matching sorted keys', async () => {
  const { ctx, writes } = harness();
  await ctx.emRecord('merged');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 2);
  assert.equal(writes[0][0].alias_a, 'b|a');
  assert.equal(writes[0][0].label_a, 'Alias B');
  assert.equal(writes[0][0].label_b, 'Keep');
  assert.equal(ctx.state.selected.size, 0);
  assert.equal(ctx.state.saving, false);
});
test('failed bulk merge retains selections for retry and shows the error', async () => {
  const { ctx, writes, element } = harness({ message: 'write rejected' });
  await ctx.emRecord('merged');
  assert.equal(writes.length, 1);
  assert.equal(ctx.state.selected.size, 2);
  assert.equal(ctx.state.a.display_name, 'Keep');
  assert.match(element('em-status').textContent, /write rejected/);
  assert.equal(ctx.state.saving, false);
});
test('self merges and duplicate submissions cannot write', async () => {
  const { ctx, writes } = harness();
  ctx.state.selected.set('a', ctx.state.a);
  await ctx.emRecord('merged');
  assert.equal(writes.length, 0);
  ctx.state.selected.delete('a');
  ctx.state.saving = true;
  await ctx.emRecord('merged');
  assert.equal(writes.length, 0);
});

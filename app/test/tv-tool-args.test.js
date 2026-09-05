'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeToolArgs, ARG_ALIASES } = require('../tv-tool-args');

// The exact bug: server.js advertised `id`, tradingview-mcp takes `entity_id`,
// nothing translated, so the removal silently no-opped.
test('draw_remove_one: id is renamed to entity_id', () => {
  const out = normalizeToolArgs('draw_remove_one', { id: 'abc123' });
  assert.deepStrictEqual(out, { entity_id: 'abc123' });
});

test('draw_get_properties gets the same alias', () => {
  assert.deepStrictEqual(normalizeToolArgs('draw_get_properties', { id: 'x' }), { entity_id: 'x' });
});

test('a correct entity_id passes through untouched', () => {
  const args = { entity_id: 'abc123' };
  assert.deepStrictEqual(normalizeToolArgs('draw_remove_one', args), { entity_id: 'abc123' });
});

test('an explicit entity_id wins when both spellings are sent', () => {
  const out = normalizeToolArgs('draw_remove_one', { id: 'wrong', entity_id: 'right' });
  assert.deepStrictEqual(out, { entity_id: 'right' });
});

test('an empty entity_id is not treated as a real value — the alias fills it', () => {
  assert.deepStrictEqual(normalizeToolArgs('draw_remove_one', { id: 'real', entity_id: '' }), { entity_id: 'real' });
  assert.deepStrictEqual(normalizeToolArgs('draw_remove_one', { id: 'real', entity_id: null }), { entity_id: 'real' });
});

test('the input object is never mutated', () => {
  const args = { id: 'abc' };
  normalizeToolArgs('draw_remove_one', args);
  assert.deepStrictEqual(args, { id: 'abc' }, 'caller keeps its own object');
});

// Narrowness guard: an `id` meant literally by another tool must survive.
test('tools not in the alias map are left alone — alert_delete keeps its id', () => {
  const args = { id: 'alert-7' };
  assert.strictEqual(normalizeToolArgs('alert_delete', args), args);
  assert.deepStrictEqual(normalizeToolArgs('alert_delete', args), { id: 'alert-7' });
});

test('other draw tools are untouched', () => {
  const a = { shape: 'horizontal_ray', point: { time: 1, price: 2 } };
  assert.strictEqual(normalizeToolArgs('draw_shape', a), a);
  assert.deepStrictEqual(normalizeToolArgs('draw_list', {}), {});
});

test('missing, null and non-object args never throw', () => {
  assert.strictEqual(normalizeToolArgs('draw_remove_one', null), null);
  assert.strictEqual(normalizeToolArgs('draw_remove_one', undefined), undefined);
  assert.deepStrictEqual(normalizeToolArgs('draw_remove_one', {}), {});
  const arr = ['a'];
  assert.strictEqual(normalizeToolArgs('draw_remove_one', arr), arr, 'an array is not an args object');
});

// Pins the map to the real tradingview-mcp signatures.
test('the alias map covers exactly the tools whose real parameter is entity_id', () => {
  assert.deepStrictEqual(Object.keys(ARG_ALIASES).sort(), ['draw_get_properties', 'draw_remove_one']);
  for (const k of Object.keys(ARG_ALIASES)) {
    assert.deepStrictEqual(ARG_ALIASES[k], { id: 'entity_id' });
  }
});

// The advertised schema and the wire format must not drift apart again.
test('server.js advertises draw_remove_one with entity_id, not id', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/name: 'draw_remove_one',[\s\S]*?parameters: (\{[\s\S]*?\}) \} \},/);
  assert.ok(m, 'draw_remove_one tool schema should be findable in server.js');
  const params = eval('(' + m[1] + ')');
  assert.ok(params.properties.entity_id, 'the advertised parameter must be entity_id');
  assert.ok(!params.properties.id, 'the old `id` parameter must be gone');
  assert.deepStrictEqual(params.required, ['entity_id']);
});

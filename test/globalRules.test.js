'use strict';

// Pure GLOBAL.md rule operations, mirroring flavor-code's GlobalInstructions
// contract: rules are single-line `- ` bullets; the whole file is injected
// verbatim into flavor-code's system prompt. Disabled rules live outside the
// document (island sidecar), so "off" here = remove from document.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateRule,
  parseRuleLines,
  addRule,
  removeRule,
  updateRule,
} = require('../src/core/globalRules');

const HEADER = '# Global instructions';

test('validateRule accepts a trimmed single-line rule', () => {
  assert.equal(validateRule('  keep it simple  '), 'keep it simple');
});

test('validateRule rejects empty, multiline, or oversized rules', () => {
  assert.throws(() => validateRule('   '), /non-empty single line/);
  assert.throws(() => validateRule('a\nb'), /non-empty single line/);
  assert.throws(() => validateRule('x'.repeat(4097)), /exceeds 4096 bytes/);
});

test('parseRuleLines extracts bullet texts in order', () => {
  const doc = `${HEADER}\n\n- first rule\n* second\n  - third rule\n`;
  assert.deepEqual(parseRuleLines(doc).map((r) => r.text), [
    'first rule', 'second', 'third rule',
  ]);
});

test('parseRuleLines ignores non-bullet content', () => {
  const doc = `${HEADER}\n\nprose line\n\n- only rule\n`;
  assert.deepEqual(parseRuleLines(doc).map((r) => r.text), ['only rule']);
});

test('addRule creates the canonical document when empty', () => {
  const doc = addRule('', 'no premature abstraction');
  assert.equal(doc, `${HEADER}\n\n- no premature abstraction\n`);
});

test('addRule appends a bullet and deduplicates case-insensitively', () => {
  let doc = addRule('', 'alpha');
  doc = addRule(doc, 'beta');
  assert.equal(doc, `${HEADER}\n\n- alpha\n- beta\n`);
  const dup = addRule(doc, 'ALPHA');
  assert.equal(dup, doc, 'case-insensitive duplicate must not be added');
});

test('addRule preserves CRLF when the document already uses it', () => {
  const doc = addRule(`${HEADER}\r\n\r\n- alpha\r\n`, 'beta');
  assert.equal(doc, `${HEADER}\r\n\r\n- alpha\r\n- beta\r\n`);
});

test('removeRule deletes only the exact (case-insensitive) bullet', () => {
  const doc = `${HEADER}\n\n- alpha\n- Alpha beta\n- gamma\n`;
  const next = removeRule(doc, 'alpha');
  assert.equal(next, `${HEADER}\n\n- Alpha beta\n- gamma\n`);
});

test('removeRule yields an empty document when nothing but the header remains', () => {
  const doc = `${HEADER}\n\n- alpha\n`;
  assert.equal(removeRule(doc, 'alpha'), '');
});

test('removeRule is a no-op for unknown text', () => {
  const doc = `${HEADER}\n\n- alpha\n`;
  assert.equal(removeRule(doc, 'missing'), doc);
});

test('updateRule replaces the matched bullet text in place', () => {
  const doc = `${HEADER}\n\n- alpha\n- beta\n`;
  const next = updateRule(doc, 'alpha', 'alpha revised');
  assert.equal(next, `${HEADER}\n\n- alpha revised\n- beta\n`);
});

test('updateRule rejects invalid replacement text or unknown target', () => {
  const doc = `${HEADER}\n\n- alpha\n`;
  assert.throws(() => updateRule(doc, 'alpha', ''), /non-empty single line/);
  assert.throws(() => updateRule(doc, 'ghost', 'x'), /no rule matches/);
});

test('addRule rejects a document beyond the 64 KiB reader limit', () => {
  const huge = `${HEADER}\n\n- ${'p'.repeat(4000)}\n`.repeat(17);
  assert.throws(() => addRule(huge, 'one more'), /exceed 65536 bytes/);
});

'use strict';

// Pure document operations for flavor-code's ~/.flavor-code/GLOBAL.md.
// Contract mirrored from flavor-code src/context/global-instructions.ts:
// rules are single-line `- ` bullets under a `# Global instructions` header,
// the whole file is injected verbatim into the system prompt, one rule is at
// most 4 KiB and the file at most 64 KiB. There is no reader-side per-rule
// switch, so "disabled" rules must live OUTSIDE this document (see the island
// sidecar handling in main.js).

const HEADER = '# Global instructions';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RULE_BYTES = 4 * 1024;

// Same bullet shape flavor-code's ruleLines() recognizes, with byte offsets
// so removal can splice without touching surrounding prose.
function parseRuleLines(content) {
  return [...content.matchAll(/^[ \t]*[-*+][ \t]+([^\r\n]+)(?:\r?\n|$)/gmu)].map((match) => ({
    text: match[1].trim(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function validateRule(input) {
  const rule = String(input ?? '').trim();
  if (!rule || /[\r\n]/u.test(rule)) throw new Error('Global rules must be one non-empty single line.');
  if (Buffer.byteLength(rule, 'utf8') > MAX_RULE_BYTES) {
    throw new Error(`Global rule exceeds ${MAX_RULE_BYTES} bytes.`);
  }
  return rule;
}

function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function assertFits(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`Global instructions exceed ${MAX_FILE_BYTES} bytes.`);
  }
  return content;
}

// Append a rule; case-insensitive duplicates return the document untouched.
function addRule(content, input) {
  const rule = validateRule(input);
  const exists = parseRuleLines(content).some((r) => r.text.toLocaleLowerCase() === rule.toLocaleLowerCase());
  if (exists) return content;
  const eol = detectEol(content);
  const base = content.trim() === '' ? `${HEADER}${eol}${eol}` : content;
  const needsEol = base.length > 0 && !base.endsWith(eol);
  return assertFits(`${base}${needsEol ? eol : ''}- ${rule}${eol}`);
}

function removeRule(content, input) {
  const query = String(input ?? '').trim().toLocaleLowerCase();
  if (!query) return content;
  const match = parseRuleLines(content).find((r) => r.text.toLocaleLowerCase() === query);
  if (!match) return content;
  const remaining = `${content.slice(0, match.start)}${content.slice(match.end)}`;
  return remaining.trim() === '' || remaining.trim() === HEADER ? '' : remaining;
}

function updateRule(content, input, replacement) {
  const query = String(input ?? '').trim().toLocaleLowerCase();
  const next = validateRule(replacement);
  const match = parseRuleLines(content).find((r) => r.text.toLocaleLowerCase() === query);
  if (!match) throw new Error(`no rule matches: ${input}`);
  const eol = detectEol(content);
  return assertFits(`${content.slice(0, match.start)}- ${next}${eol}${content.slice(match.end)}`);
}

module.exports = { HEADER, MAX_FILE_BYTES, MAX_RULE_BYTES, parseRuleLines, validateRule, addRule, removeRule, updateRule };

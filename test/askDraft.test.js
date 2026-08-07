'use strict';

// Pure AskUserQuestion draft logic: answer composition, the required-answer
// gate, and the submitted payload that carries both the custom-input checkbox
// state and its text.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  answerForQuestion,
  allQuestionsAnswered,
  buildAskPayload,
} = require('../src/renderer/askDraft');

function qd(overrides = {}) {
  return { value: null, set: [], other: false, otherText: '', ...overrides };
}

test('single-select answer uses the picked option', () => {
  const q = { question: 'Plan?', options: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(answerForQuestion(q, qd({ value: 'B' })), 'B');
  assert.equal(answerForQuestion(q, qd()), '');
});

test('custom checkbox gates the single-select text', () => {
  const q = { question: 'Plan?', options: [{ label: 'A' }] };
  // Unchecked: the picked option wins and the typed text stays in the draft.
  assert.equal(answerForQuestion(q, qd({ value: 'A', other: false, otherText: 'my plan' })), 'A');
  // Checked: the typed text becomes the answer.
  assert.equal(answerForQuestion(q, qd({ other: true, otherText: 'my plan' })), 'my plan');
  // Checked with only whitespace: no answer yet.
  assert.equal(answerForQuestion(q, qd({ other: true, otherText: '   ' })), '');
});

test('multi-select appends custom text only when checked', () => {
  const q = { question: 'Tools?', multiSelect: true, options: [{ label: 'x' }] };
  assert.equal(answerForQuestion(q, qd({ set: ['x'], other: false, otherText: 'y' })), 'x');
  assert.equal(answerForQuestion(q, qd({ set: ['x'], other: true, otherText: 'y' })), 'x, y');
  assert.equal(answerForQuestion(q, qd({ set: [], other: true, otherText: '' })), '');
});

test('text-only question uses the input text', () => {
  const q = { question: 'Name?', options: null };
  assert.equal(answerForQuestion(q, qd({ otherText: 'hi' })), 'hi');
  assert.equal(answerForQuestion(q, qd({ otherText: '  ' })), '');
});

test('allQuestionsAnswered follows the required-answer rule', () => {
  const q = { question: 'Q', options: [{ label: 'A' }] };
  assert.equal(allQuestionsAnswered([q], [qd()]), false);
  assert.equal(allQuestionsAnswered([q], [qd({ value: 'A' })]), true);
  // Checked custom box with an empty input still blocks submit — same rule as a
  // missing option pick; nothing throws.
  assert.equal(allQuestionsAnswered([q], [qd({ other: true, otherText: '  ' })]), false);
  assert.equal(allQuestionsAnswered([q], [qd({ other: true, otherText: 'ok' })]), true);
});

test('buildAskPayload carries both the checkbox state and the input text', () => {
  const q = { question: 'Q', options: [{ label: 'A' }] };
  // Unchecked: option answer, but the typed text is still reported.
  const p1 = buildAskPayload([q], [qd({ value: 'A', otherText: 'typed' })]);
  assert.equal(p1.answers.Q, 'A');
  assert.deepEqual(p1.details.Q, { checked: false, text: 'typed' });
  // Checked: the text becomes the answer, and both state + text are reported.
  const p2 = buildAskPayload([q], [qd({ other: true, otherText: 'typed' })]);
  assert.equal(p2.answers.Q, 'typed');
  assert.deepEqual(p2.details.Q, { checked: true, text: 'typed' });
});

test('buildAskPayload covers every question in order', () => {
  const qs = [
    { question: 'A?', options: [{ label: '1' }] },
    { question: 'B?', options: [{ label: '2' }] },
  ];
  const { answers, details } = buildAskPayload(qs, [
    qd({ value: '1' }),
    qd({ other: true, otherText: 'free' }),
  ]);
  assert.deepEqual(answers, { 'A?': '1', 'B?': 'free' });
  assert.deepEqual(details, {
    'A?': { checked: false, text: '' },
    'B?': { checked: true, text: 'free' },
  });
});

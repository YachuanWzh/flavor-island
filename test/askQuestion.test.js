'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAskUserQuestion,
  parseQuestions,
  buildAllowResponse,
  buildDenyResponse,
} = require('../src/core/askQuestion');

function permEvent(toolInput) {
  return {
    eventName: 'PermissionRequest',
    toolName: 'AskUserQuestion',
    toolInput,
  };
}

test('isAskUserQuestion detects the tool', () => {
  assert.equal(isAskUserQuestion(permEvent({})), true);
  assert.equal(isAskUserQuestion({ eventName: 'PermissionRequest', toolName: 'Bash' }), false);
  assert.equal(isAskUserQuestion(null), false);
});

test('parseQuestions handles structured questions with options', () => {
  const ev = permEvent({
    questions: [
      {
        question: 'Pick a model',
        header: 'Model',
        multiSelect: false,
        options: [{ label: 'A', description: 'fast' }, { label: 'B' }],
      },
      {
        question: 'Which tools?',
        multiSelect: true,
        options: ['x', 'y'],
      },
    ],
  });
  const qs = parseQuestions(ev);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].question, 'Pick a model');
  assert.equal(qs[0].header, 'Model');
  assert.equal(qs[0].multiSelect, false);
  assert.deepEqual(qs[0].options, [{ label: 'A', description: 'fast' }, { label: 'B', description: null }]);
  assert.equal(qs[1].multiSelect, true);
  assert.deepEqual(qs[1].options, [{ label: 'x', description: null }, { label: 'y', description: null }]);
});

test('parseQuestions falls back to single question', () => {
  const qs = parseQuestions(permEvent({ question: 'Name?', options: ['one', 'two'] }));
  assert.equal(qs.length, 1);
  assert.equal(qs[0].question, 'Name?');
  assert.equal(qs[0].options.length, 2);
});

test('parseQuestions returns [] for empty input', () => {
  assert.deepEqual(parseQuestions(permEvent({})), []);
  assert.deepEqual(parseQuestions(permEvent(null)), []);
});

test('buildAllowResponse carries questions and answers', () => {
  const ev = permEvent({ questions: [{ question: 'Q1' }] });
  const resp = buildAllowResponse(ev, { Q1: 'answer1' });
  assert.equal(resp.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(resp.hookSpecificOutput.decision.updatedInput.questions.length, 1);
  assert.equal(resp.hookSpecificOutput.decision.updatedInput.answers.Q1, 'answer1');
  assert.equal(resp.hookSpecificOutput.decision.updatedInput.answer, 'answer1');
});

test('buildAllowResponse preserves questions when toolInput lacks them', () => {
  const ev = permEvent({ foo: 'bar' });
  const resp = buildAllowResponse(ev, {});
  assert.deepEqual(resp.hookSpecificOutput.decision.updatedInput.questions, []);
  assert.equal(resp.hookSpecificOutput.decision.updatedInput.foo, 'bar');
});

test('buildDenyResponse denies', () => {
  const resp = buildDenyResponse();
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'deny');
});

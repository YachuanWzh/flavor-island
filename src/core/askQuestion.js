'use strict';

// Pure helpers for flavor-code's AskUserQuestion tool. Mirrors the macOS
// CodeIsland AppState.handleAskUserQuestion / askUserQuestionUpdatedInput logic.
//
// flavor-code delivers AskUserQuestion as a PermissionRequest hook with
// tool_name === "AskUserQuestion" and tool_input.questions = [{ question, header,
// multiSelect, options: [{ label, description }] }]. The required response is a
// PermissionRequest "allow" whose decision.updatedInput carries the answers,
// keyed by question text (the agent looks them up as answers[question.question]).

const { normalize } = require('./eventNormalizer');

function isAskUserQuestion(event) {
  if (!event) return false;
  return normalize(event.eventName) === 'PermissionRequest' && event.toolName === 'AskUserQuestion';
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// Parse the tool input into a normalized list of question items the UI renders.
// Each item: { question, header, multiSelect, options: [{label, description}] | null }.
function parseQuestions(event) {
  const input = (event && event.toolInput) || {};
  const rawQuestions = Array.isArray(input.questions) ? input.questions : null;

  if (rawQuestions && rawQuestions.length) {
    return rawQuestions.map((q) => {
      const question = nonEmptyString(q && q.question) || 'Question';
      const header = nonEmptyString(q && q.header);
      const multiSelect = (q && q.multiSelect) === true;
      let options = null;
      if (Array.isArray(q && q.options) && q.options.length) {
        options = q.options
          .map((o) => {
            if (o && typeof o === 'object') {
              const label = nonEmptyString(o.label);
              if (label) return { label, description: nonEmptyString(o.description) };
              return null;
            }
            const label = nonEmptyString(o);
            return label ? { label, description: null } : null;
          })
          .filter(Boolean);
        if (!options.length) options = null;
      }
      return { question, header, multiSelect, options };
    });
  }

  // Fallback: a single free-text (or simple-options) question.
  const question = nonEmptyString(input.question);
  if (question) {
    let options = null;
    if (Array.isArray(input.options) && input.options.length) {
      options = input.options
        .map((o) => {
          if (o && typeof o === 'object') {
            const label = nonEmptyString(o.label);
            return label ? { label, description: nonEmptyString(o.description) } : null;
          }
          const label = nonEmptyString(o);
          return label ? { label, description: null } : null;
        })
        .filter(Boolean);
      if (!options.length) options = null;
    }
    return [{ question, header: null, multiSelect: false, options }];
  }

  return [];
}

// Build the PermissionRequest "allow" response. `answers` is keyed by question
// text. Multi-select answers are pre-joined strings (the UI does the joining).
// `details` (optional) carries each question's custom-input combination state
// ({ checked, text }) and is attached as `answerDetails` so the submitted data
// explicitly contains both the checkbox state and the input text.
function buildAllowResponse(event, answers = {}, details = {}) {
  const toolInput = (event && event.toolInput) || {};
  const updatedInput = { ...toolInput };
  // `questions` must always be present — the agent calls map() on it directly;
  // an absent key can crash, so always carry it through.
  updatedInput.questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  updatedInput.answers = answers;
  if (details && typeof details === 'object' && Object.keys(details).length) {
    updatedInput.answerDetails = details;
  }
  const firstAnswer = Object.values(answers)[0];
  if (typeof firstAnswer === 'string') updatedInput.answer = firstAnswer;

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput },
    },
  };
}

function buildDenyResponse() {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny' },
    },
  };
}

module.exports = { isAskUserQuestion, parseQuestions, buildAllowResponse, buildDenyResponse };

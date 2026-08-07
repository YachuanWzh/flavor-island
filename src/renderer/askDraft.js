'use strict';

// Pure AskUserQuestion draft logic shared by the island renderer and the unit
// tests. The renderer keeps per-question draft state
// ({ value, set, other, otherText }) so the user's selections survive the
// periodic state re-renders; this module turns a draft into the submitted
// answer strings and the custom-input combination details. Kept DOM-free so it
// runs in both Node (node --test) and the browser as a classic script (same
// pattern as mascot.js).

// Resolve one question's draft into the final answer string (multi-select
// labels are joined with ", ", mirroring the macOS app). For questions with
// options, the final custom-input checkbox (`other`) gates whether the typed
// text counts as the answer: checked → the text is used; unchecked → the picked
// option (or nothing) is used, and the typed text is kept in the draft.
function answerForQuestion(q, qd) {
  if (q.options && q.options.length) {
    if (q.multiSelect) {
      const parts = [...qd.set];
      if (qd.other && qd.otherText.trim()) parts.push(qd.otherText.trim());
      return parts.join(', ');
    }
    if (qd.other) return qd.otherText.trim();
    return qd.value || '';
  }
  return qd.otherText.trim(); // text-only question
}

// Every question needs a non-empty answer before Submit is enabled — the same
// required-answer rule the card has always used. An empty custom input (even
// with the checkbox checked) therefore just keeps Submit disabled; nothing
// throws.
function allQuestionsAnswered(questions, drafts) {
  return questions.every((q, qi) => answerForQuestion(q, drafts[qi]).length > 0);
}

// Build the submitted payload for the whole card. `answers` keeps the existing
// string contract (the agent reads answers[question.question]); `details`
// carries each question's custom-input combination state so the submitted data
// explicitly contains BOTH the checkbox checked state and the input text.
function buildAskPayload(questions, drafts) {
  const answers = {};
  const details = {};
  questions.forEach((q, qi) => {
    const qd = drafts[qi];
    answers[q.question] = answerForQuestion(q, qd);
    details[q.question] = { checked: !!qd.other, text: qd.otherText };
  });
  return { answers, details };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { answerForQuestion, allQuestionsAnswered, buildAskPayload };
}

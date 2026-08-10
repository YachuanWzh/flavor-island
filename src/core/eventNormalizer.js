'use strict';

// Normalize event names from various CLIs to internal PascalCase names.
// flavor-code already sends PascalCase (SessionStart, PreToolUse, …), so those
// pass through; the aliases keep the door open for other CLIs later without
// changing downstream code.
const ALIASES = {
  // Cursor (camelCase)
  beforeSubmitPrompt: 'UserPromptSubmit',
  beforeShellExecution: 'PreToolUse',
  afterShellExecution: 'PostToolUse',
  beforeReadFile: 'PreToolUse',
  afterFileEdit: 'PostToolUse',
  beforeMCPExecution: 'PreToolUse',
  afterMCPExecution: 'PostToolUse',
  afterAgentThought: 'Notification',
  afterAgentResponse: 'AfterAgentResponse',
  stop: 'Stop',
  // Gemini
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  BeforeAgent: 'SubagentStart',
  AfterAgent: 'SubagentStop',
  // GitHub Copilot CLI / camelCase forks
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  userPromptSubmitted: 'UserPromptSubmit',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  errorOccurred: 'Notification',
  agentSpawn: 'SessionStart',
  // snake_case forks
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure',
  permission_request: 'PermissionRequest',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_compact: 'PreCompact',
  post_compact: 'PostCompact',
  before_model_call: 'BeforeModelCall',
  after_model_call: 'AfterModelCall',
  before_plan: 'BeforePlan',
  after_plan: 'AfterPlan',
  notification: 'Notification',
};

function normalize(name) {
  if (typeof name !== 'string') return name;
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : name;
}

module.exports = { normalize };

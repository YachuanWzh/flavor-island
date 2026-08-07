'use strict';

// Pure helper that turns a resolved permission decision into the JSON payload
// the named-pipe server writes back to the flavor-code bridge. The bridge maps
// this to the hook decision it returns to flavor-code's PermissionRequest hook:
//   { hookSpecificOutput: { hookEventName: 'PermissionRequest',
//       decision: { behavior: 'allow'|'deny', updatedPermissions?, updatedInput? } } }

// Build the persisted "always allow" rule for a tool. Non-MCP tools
// (Bash/Read/Edit/…) take a `*` specifier so any invocation matches; MCP tools
// (mcp__server__tool) must use the bare tool name — a `*` rule never matches a
// real MCP call, so the rule would silently fail to persist.
function alwaysAllowRule(toolName) {
  const rule = { toolName: toolName || '' };
  if (!String(toolName || '').startsWith('mcp__')) rule.ruleContent = '*';
  return rule;
}

// `decision` is the resolved value from onPermission: 'deny', 'allow', or
// 'allowAll'. 'allowAll' allows the current call and adds a session-scoped rule
// so every later same-tool call is auto-approved without re-prompting.
function permissionResponse(decision, event) {
  let dec;
  if (decision === 'deny') {
    dec = { behavior: 'deny' };
  } else if (decision === 'allowAll') {
    dec = {
      behavior: 'allow',
      updatedPermissions: [{
        type: 'addRules',
        rules: [alwaysAllowRule(event && event.toolName)],
        behavior: 'allow',
        destination: 'session',
      }],
    };
  } else {
    dec = { behavior: 'allow' };
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: dec,
    },
  });
}

module.exports = { permissionResponse, alwaysAllowRule };

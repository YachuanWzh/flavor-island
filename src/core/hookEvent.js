'use strict';

const path = require('path');

// Port of CodeIsland's HookEvent (macOS). Parses a raw hook payload buffer
// into a structured event and derives a human-readable tool description.
// Compatible with the event shape the flavor-code codeisland bridge sends:
//   { hook_event_name, session_id, tool_name, tool_input, agent_type, model,
//     message, reason, _source, _ppid, ... }

function firstString(dict, keys) {
  for (const key of keys) {
    const v = dict[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function firstStringNested(dict, containerKeys, keys) {
  for (const ck of containerKeys) {
    const nested = dict[ck];
    if (nested && typeof nested === 'object') {
      const v = firstString(nested, keys);
      if (v) return v;
    }
  }
  return null;
}

function firstDict(dict, keys) {
  for (const key of keys) {
    const v = dict[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

function firstDictNested(dict, containerKeys, keys) {
  for (const ck of containerKeys) {
    const nested = dict[ck];
    if (nested && typeof nested === 'object') {
      const v = firstDict(nested, keys);
      if (v) return v;
    }
  }
  return null;
}

function baseName(p) {
  return path.basename(String(p).replace(/\\/g, '/'));
}

function normMultiline(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toolDescription(toolName, toolInput, rawJSON) {
  if (toolInput) {
    const i = toolInput;
    switch (toolName) {
      case 'Bash':
      case 'execute_command': {
        const desc = normMultiline(i.description);
        const cmd = normMultiline(i.command);
        if (desc && cmd) {
          if (desc === cmd || desc.includes(cmd)) return desc;
          return `${desc}\nCommand:\n${cmd}`;
        }
        if (desc) return desc;
        if (cmd) return cmd;
        break;
      }
      case 'Read':
      case 'read_file':
        if (typeof i.file_path === 'string') {
          const name = baseName(i.file_path);
          if (typeof i.offset === 'number') return `${name}:${i.offset}`;
          return name;
        }
        break;
      case 'Edit':
      case 'apply_diff':
      case 'Write':
      case 'write_to_file':
        if (typeof i.file_path === 'string') return baseName(i.file_path);
        break;
      case 'Grep':
      case 'search_files':
        if (typeof i.pattern === 'string') {
          const where = typeof i.path === 'string' ? ` in ${baseName(i.path)}` : '';
          return `${i.pattern}${where}`;
        }
        break;
      case 'Glob':
        if (typeof i.pattern === 'string') return i.pattern;
        break;
      case 'WebSearch':
        if (typeof i.query === 'string') return i.query;
        break;
      case 'WebFetch':
        if (typeof i.url === 'string') {
          try { return new URL(i.url).host; } catch { return i.url.slice(0, 40); }
        }
        break;
      case 'Task':
      case 'Agent':
        if (typeof i.description === 'string' && i.description) return i.description;
        if (typeof i.prompt === 'string') return i.prompt.slice(0, 40);
        break;
      case 'TodoWrite':
        return 'Updating tasks';
      default:
        if (typeof i.file_path === 'string') return baseName(i.file_path);
        if (typeof i.pattern === 'string') return i.pattern;
        if (typeof i.command === 'string') return i.command.slice(0, 60);
        if (typeof i.prompt === 'string') return i.prompt.slice(0, 40);
    }
  }
  const msg = firstString(rawJSON, ['message', 'text', 'summary', 'status', 'detail', 'content'])
    || firstStringNested(rawJSON, ['payload', 'data'], ['message', 'text', 'summary', 'status', 'detail', 'content']);
  if (msg) return msg;
  if (typeof rawJSON.agent_type === 'string') return rawJSON.agent_type;
  if (typeof rawJSON.prompt === 'string') return rawJSON.prompt.slice(0, 40);
  return null;
}

function parseHookEvent(buffer) {
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const eventName = firstString(json, ['hook_event_name', 'hookEventName', 'event_name', 'eventName']);
  if (!eventName) return null;

  let sessionId = firstString(json, ['session_id', 'sessionId']);
  const remoteHostId = json._remote_host_id;
  if (sessionId && typeof remoteHostId === 'string' && remoteHostId.trim()) {
    sessionId = `remote:${remoteHostId}:${sessionId}`;
  }

  const toolName = firstString(json, ['tool_name', 'toolName', 'tool', 'name'])
    || firstStringNested(json, ['tool', 'payload', 'data'], ['name', 'tool_name', 'toolName']);
  const toolUseId = firstString(json, ['tool_use_id', 'toolUseId'])
    || firstStringNested(json, ['tool', 'tool_use', 'toolUse', 'payload', 'data'], ['id', 'tool_use_id', 'toolUseId']);
  const toolInput = firstDict(json, ['tool_input', 'toolInput', 'input', 'arguments', 'args', 'params'])
    || firstDictNested(json, ['tool', 'payload', 'data'], ['input', 'tool_input', 'toolInput', 'arguments', 'args', 'params']);
  const agentId = typeof json.agent_id === 'string' ? json.agent_id : null;
  const eventId = firstString(json, ['event_id', 'eventId']);

  return {
    eventName,
    eventId,
    sessionId,
    toolName,
    toolUseId,
    toolInput,
    agentId,
    rawJSON: json,
    toolDescription: toolDescription(toolName, toolInput, json),
  };
}

module.exports = { parseHookEvent };

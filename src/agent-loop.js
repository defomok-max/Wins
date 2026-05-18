import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { resolve, relative, dirname, sep } from 'path';
import { log } from './config.js';
import { parseToolCallsFromText } from './handlers/tool-emulation.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT = 20_000;

const AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the agent working directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'Command to run.' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a text file from the agent working directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'integer', description: 'Optional 1-based line offset.' },
          limit: { type: 'integer', description: 'Optional maximum number of lines.' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a text file in the agent working directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace exact text in a file in the agent working directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'MultiEdit',
      description: 'Apply multiple exact text replacements to one file.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['file_path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'LS',
      description: 'List files and directories under a path.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: 'Directory path. Defaults to .'} },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search text files for a regular expression.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'File or directory path. Defaults to .' },
          limit: { type: 'integer', description: 'Maximum matches to return.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Base directory. Defaults to .' },
          limit: { type: 'integer', description: 'Maximum files to return.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Fetch text from an HTTP(S) URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds.' },
        },
        required: ['url'],
      },
    },
  },
];

function parseBool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'string') return /^(1|true|yes|on|auto|server|server_tools|agent_loop)$/i.test(value.trim());
  return false;
}

export function isAgentLoopRequested(body = {}) {
  if (body?.stream && body?.agent?.stream === false) return false;
  const agent = body.agent && typeof body.agent === 'object'
    ? body.agent.enabled !== false
    : parseBool(body.agent);
  return agent
    || parseBool(body.agent_mode)
    || body.tool_execution === 'server'
    || body.tool_execution === 'agent_loop'
    || process.env.WINDSURFAPI_AGENT_LOOP === '1';
}

function agentOptions(body = {}) {
  const raw = body.agent && typeof body.agent === 'object' ? body.agent : {};
  const maxIterations = Math.max(1, Math.min(32, Number(raw.max_iterations ?? body.agent_max_iterations ?? process.env.WINDSURFAPI_AGENT_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS));
  const workingDirectory = resolve(String(raw.working_directory || body.working_directory || process.env.WINDSURFAPI_AGENT_WORKDIR || process.cwd()));
  const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(raw.timeout_ms ?? body.agent_tool_timeout_ms ?? process.env.WINDSURFAPI_AGENT_TOOL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const outputLimit = Math.max(1000, Math.min(200_000, Number(raw.output_limit ?? body.agent_tool_output_limit ?? process.env.WINDSURFAPI_AGENT_TOOL_OUTPUT_LIMIT ?? DEFAULT_OUTPUT_LIMIT) || DEFAULT_OUTPUT_LIMIT));
  const addBuiltinTools = raw.add_builtin_tools !== false && body.add_builtin_agent_tools !== false;
  return { maxIterations, workingDirectory, timeoutMs, outputLimit, addBuiltinTools };
}

function toolName(tool) {
  return tool?.function?.name || tool?.name || '';
}

export function mergeAgentTools(tools = [], opts = {}) {
  const existing = new Set((Array.isArray(tools) ? tools : []).map(toolName).filter(Boolean));
  const merged = Array.isArray(tools) ? [...tools] : [];
  if (opts.addBuiltinTools === false) return merged;
  for (const tool of AGENT_TOOL_DEFINITIONS) {
    const name = tool.function.name;
    if (!existing.has(name)) merged.push(tool);
  }
  return merged;
}

function normalizeToolName(name = '') {
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['bash', 'shell', 'runcommand', 'shellcommand', 'agentbash'].includes(n)) return 'bash';
  if (['read', 'readfile', 'viewfile', 'agentread'].includes(n)) return 'read';
  if (['write', 'writefile', 'agentwrite'].includes(n)) return 'write';
  if (['edit', 'strreplace', 'agentedit'].includes(n)) return 'edit';
  if (['multiedit', 'agentmultiedit'].includes(n)) return 'multiedit';
  if (['ls', 'list', 'listdir', 'listdirectory', 'agentls'].includes(n)) return 'ls';
  if (['grep', 'search', 'grepsearch', 'agentgrep'].includes(n)) return 'grep';
  if (['glob', 'find', 'agentglob'].includes(n)) return 'glob';
  if (['webfetch', 'fetch', 'readurl', 'readurlcontent', 'agentwebfetch'].includes(n)) return 'webfetch';
  return n;
}

function parseArgs(text) {
  if (!text || typeof text !== 'string') return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return '';
  }).join('');
}

function normalizeToolCall(toolCall, index = 0) {
  const name = toolCall?.function?.name || toolCall?.name || 'unknown';
  const rawArgs = toolCall?.function?.arguments ?? toolCall?.argumentsJson ?? toolCall?.arguments ?? '{}';
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return {
    id: toolCall?.id || `call_agent_${index}_${Date.now().toString(36)}`,
    type: 'function',
    function: { name, arguments: args || '{}' },
  };
}

function resolveAssistantToolCalls(message, body) {
  const native = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (native.length) {
    const toolCalls = native.map((tc, idx) => normalizeToolCall(tc, idx));
    return { message: { ...message, tool_calls: toolCalls }, toolCalls };
  }

  const text = messageText(message.content);
  if (!text) return { message, toolCalls: [] };
  const parsed = parseToolCallsFromText(text, {
    modelKey: body.model,
    provider: body.provider,
    route: body.__route || 'chat',
  });
  if (!parsed.toolCalls.length) return { message, toolCalls: [] };
  const toolCalls = parsed.toolCalls.map((tc, idx) => normalizeToolCall(tc, idx));
  return {
    message: {
      ...message,
      content: parsed.text || null,
      tool_calls: toolCalls,
    },
    toolCalls,
  };
}

function truncate(text, limit) {
  const src = String(text ?? '');
  if (src.length <= limit) return src;
  return src.slice(0, limit) + `\n[truncated ${src.length - limit} chars]`;
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function resolveAgentPath(filePath, cwd) {
  const base = resolve(cwd);
  const target = resolve(base, String(filePath || '.'));
  if (!inside(base, target)) throw new Error(`Path escapes agent working directory: ${filePath}`);
  return target;
}

function formatToolError(error) {
  return `Error: ${error?.message || String(error)}`;
}

async function runBash(args, opts) {
  const command = args.command || args.cmd || args.input;
  if (!command || typeof command !== 'string') throw new Error('Bash requires command');
  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(args.timeout_ms || opts.timeoutMs) || opts.timeoutMs));
  try {
    const result = await execFileAsync('/bin/sh', ['-lc', command], {
      cwd: opts.workingDirectory,
      timeout,
      maxBuffer: opts.outputLimit + 8192,
      windowsHide: true,
    });
    const stdout = result.stdout ? `STDOUT:\n${result.stdout}` : 'STDOUT: (empty)';
    const stderr = result.stderr ? `\nSTDERR:\n${result.stderr}` : '';
    return truncate(`Exit code: 0\n${stdout}${stderr}`, opts.outputLimit);
  } catch (error) {
    const stdout = error.stdout ? `\nSTDOUT:\n${error.stdout}` : '';
    const stderr = error.stderr ? `\nSTDERR:\n${error.stderr}` : '';
    return truncate(`Exit code: ${Number.isFinite(error.code) ? error.code : 'unknown'}${stdout}${stderr}\n${error.message}`, opts.outputLimit);
  }
}

async function runRead(args, opts) {
  const target = resolveAgentPath(args.file_path || args.path, opts.workingDirectory);
  const text = await fs.readFile(target, 'utf8');
  if (args.offset != null || args.limit != null) {
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, (Number(args.offset) || 1) - 1);
    const end = args.limit != null ? start + Math.max(0, Number(args.limit) || 0) : lines.length;
    return truncate(lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join('\n'), opts.outputLimit);
  }
  return truncate(text, opts.outputLimit);
}

async function runWrite(args, opts) {
  const target = resolveAgentPath(args.file_path || args.path, opts.workingDirectory);
  const content = String(args.content ?? '');
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return `Wrote ${content.length} bytes to ${relative(opts.workingDirectory, target) || target}`;
}

async function runEdit(args, opts) {
  const target = resolveAgentPath(args.file_path || args.path, opts.workingDirectory);
  const oldString = String(args.old_string ?? '');
  const newString = String(args.new_string ?? '');
  if (!oldString) throw new Error('Edit requires old_string');
  const original = await fs.readFile(target, 'utf8');
  const matches = original.split(oldString).length - 1;
  if (matches === 0) throw new Error('old_string not found');
  if (!args.replace_all && matches > 1) throw new Error('old_string is not unique; set replace_all=true');
  const updated = args.replace_all ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  await fs.writeFile(target, updated, 'utf8');
  return `Replaced ${args.replace_all ? matches : 1} occurrence(s) in ${relative(opts.workingDirectory, target) || target}`;
}

async function runMultiEdit(args, opts) {
  if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('MultiEdit requires edits[]');
  let total = 0;
  for (const edit of args.edits) {
    const out = await runEdit({ ...edit, file_path: args.file_path || args.path }, opts);
    const m = out.match(/Replaced (\d+)/);
    if (m) total += Number(m[1]);
  }
  return `Applied ${args.edits.length} edit(s), ${total} replacement(s)`;
}

async function runLs(args, opts) {
  const target = resolveAgentPath(args.path || args.file_path || '.', opts.workingDirectory);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return truncate(entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `${e.isDirectory() ? 'dir ' : e.isFile() ? 'file' : 'other'}\t${e.name}`)
    .join('\n'), opts.outputLimit);
}

async function walkFiles(root, limit = 2000) {
  const out = [];
  async function visit(dir) {
    if (out.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  const stat = await fs.stat(root);
  if (stat.isFile()) return [root];
  await visit(root);
  return out;
}

function makeRegex(pattern) {
  try { return new RegExp(String(pattern), 'i'); }
  catch { return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

async function runGrep(args, opts) {
  if (!args.pattern) throw new Error('Grep requires pattern');
  const target = resolveAgentPath(args.path || '.', opts.workingDirectory);
  const re = makeRegex(args.pattern);
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
  const matches = [];
  for (const file of await walkFiles(target)) {
    if (matches.length >= limit) break;
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      if (re.test(lines[i])) matches.push(`${relative(opts.workingDirectory, file)}:${i + 1}: ${lines[i]}`);
    }
  }
  return matches.length ? truncate(matches.join('\n'), opts.outputLimit) : 'No matches';
}

function globToRegex(pattern) {
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${body}$`);
}

async function runGlob(args, opts) {
  if (!args.pattern) throw new Error('Glob requires pattern');
  const target = resolveAgentPath(args.path || '.', opts.workingDirectory);
  const limit = Math.max(1, Math.min(2000, Number(args.limit) || 500));
  const re = globToRegex(args.pattern);
  const files = await walkFiles(target, limit * 4);
  const matched = files.map(f => relative(target, f).replace(/\\/g, '/')).filter(p => re.test(p)).slice(0, limit);
  return matched.length ? truncate(matched.join('\n'), opts.outputLimit) : 'No matches';
}

async function runWebFetch(args, opts) {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('WebFetch requires http(s) URL');
  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(args.timeout_ms || opts.timeoutMs) || opts.timeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    return truncate(`HTTP ${res.status} ${res.statusText}\n${text}`, opts.outputLimit);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeAgentToolCall(toolCall, opts) {
  const name = toolCall?.function?.name || toolCall?.name || 'unknown';
  const args = parseArgs(toolCall?.function?.arguments || toolCall?.argumentsJson || toolCall?.arguments || '{}');
  try {
    const normalized = normalizeToolName(name);
    if (normalized === 'bash') return await runBash(args, opts);
    if (normalized === 'read') return await runRead(args, opts);
    if (normalized === 'write') return await runWrite(args, opts);
    if (normalized === 'edit') return await runEdit(args, opts);
    if (normalized === 'multiedit') return await runMultiEdit(args, opts);
    if (normalized === 'ls') return await runLs(args, opts);
    if (normalized === 'grep') return await runGrep(args, opts);
    if (normalized === 'glob') return await runGlob(args, opts);
    if (normalized === 'webfetch') return await runWebFetch(args, opts);
    return `Error: tool "${name}" is not executable by WindsurfAPI agent loop`;
  } catch (error) {
    return formatToolError(error);
  }
}

function appendToolTurn(messages, assistantMessage, toolResults) {
  const assistant = {
    role: 'assistant',
    content: assistantMessage.content ?? null,
    tool_calls: assistantMessage.tool_calls,
  };
  if (assistantMessage.reasoning_content) assistant.reasoning_content = assistantMessage.reasoning_content;
  return [...messages, assistant, ...toolResults];
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const out = total || {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') out[key] = (out[key] || 0) + value;
  }
  return out;
}

function attachAgentUsage(body, usage, meta) {
  body.usage = usage ? { ...usage } : { ...(body?.usage || {}) };
  body.usage.agent_iterations = meta.iterations;
  body.usage.agent_tool_calls = meta.toolCalls;
  return body;
}

function streamChatBody(chatBody) {
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const choice = chatBody.choices?.[0] || {};
      const message = choice.message || {};
      const write = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      write({ id: chatBody.id, object: 'chat.completion.chunk', created: chatBody.created, model: chatBody.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      if (message.reasoning_content) write({ id: chatBody.id, object: 'chat.completion.chunk', created: chatBody.created, model: chatBody.model, choices: [{ index: 0, delta: { reasoning_content: message.reasoning_content }, finish_reason: null }] });
      if (message.content) write({ id: chatBody.id, object: 'chat.completion.chunk', created: chatBody.created, model: chatBody.model, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] });
      write({ id: chatBody.id, object: 'chat.completion.chunk', created: chatBody.created, model: chatBody.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] });
      write({ id: chatBody.id, object: 'chat.completion.chunk', created: chatBody.created, model: chatBody.model, choices: [], usage: chatBody.usage || {} });
      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

export async function handleAgentChatCompletions(body, context, singleTurnHandler) {
  const opts = agentOptions(body);
  const originalStream = !!body.stream;
  const tools = mergeAgentTools(body.tools, opts);
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let totalUsage = null;
  let toolCallCount = 0;

  for (let iteration = 0; iteration <= opts.maxIterations; iteration++) {
    const turnBody = { ...body, stream: false, messages, tools };
    if (iteration > 0 && turnBody.tool_choice && turnBody.tool_choice !== 'none') turnBody.tool_choice = 'auto';
    const result = await singleTurnHandler(
      turnBody,
      { ...context, __agentLoopDisabled: true },
    );
    if (result.status !== 200 || !result.body) return result;
    totalUsage = addUsage(totalUsage, result.body.usage);
    const choice = result.body.choices?.[0] || {};
    const parsedTurn = resolveAssistantToolCalls(choice.message || {}, body);
    const message = parsedTurn.message;
    const toolCalls = parsedTurn.toolCalls;
    if (!toolCalls.length) {
      attachAgentUsage(result.body, totalUsage, { iterations: iteration, toolCalls: toolCallCount });
      return originalStream ? streamChatBody(result.body) : result;
    }
    if (!Array.isArray(choice.message?.tool_calls)) {
      choice.message = message;
      choice.finish_reason = 'tool_calls';
    }
    if (iteration >= opts.maxIterations) {
      return {
        status: 409,
        body: {
          error: {
            message: `Agent loop reached max_iterations=${opts.maxIterations} before a final assistant response`,
            type: 'agent_max_iterations_exceeded',
          },
        },
      };
    }
    log.info(`AgentLoop: executing ${toolCalls.length} tool call(s), iteration=${iteration + 1}/${opts.maxIterations}, cwd=${opts.workingDirectory}`);
    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const content = await executeAgentToolCall(tc, opts);
      return {
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function?.name || 'unknown',
        content,
      };
    }));
    toolCallCount += toolCalls.length;
    messages = appendToolTurn(messages, message, toolResults);
  }

  return {
    status: 409,
    body: {
      error: {
        message: `Agent loop reached max_iterations=${opts.maxIterations}`,
        type: 'agent_max_iterations_exceeded',
      },
    },
  };
}

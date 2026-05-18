import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executeAgentToolCall,
  handleAgentChatCompletions,
  isAgentLoopRequested,
  mergeAgentTools,
} from '../src/agent-loop.js';

function completion(message, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) {
  return {
    status: 200,
    body: {
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }],
      usage,
    },
  };
}

describe('agent loop', () => {
  test('detects explicit agent loop knobs', () => {
    assert.equal(isAgentLoopRequested({ agent: true }), true);
    assert.equal(isAgentLoopRequested({ agent: { enabled: true } }), true);
    assert.equal(isAgentLoopRequested({ tool_execution: 'server' }), true);
    assert.equal(isAgentLoopRequested({ agent: { enabled: false } }), false);
  });

  test('adds built-in agent tools without replacing caller tools', () => {
    const tools = mergeAgentTools([{ type: 'function', function: { name: 'custom_tool' } }]);
    assert.ok(tools.some(t => t.function?.name === 'custom_tool'));
    assert.ok(tools.some(t => t.function?.name === 'Bash'));
    assert.ok(tools.some(t => t.function?.name === 'Read'));
  });

  test('executes tool calls and continues until final answer', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'windsurf-agent-loop-'));
    try {
      let calls = 0;
      const result = await handleAgentChatCompletions({
        model: 'test-model',
        agent: { enabled: true, working_directory: workdir },
        messages: [{ role: 'user', content: 'run echo and report result' }],
      }, {}, async (body, context) => {
        assert.equal(context.__agentLoopDisabled, true);
        calls++;
        if (calls === 1) {
          assert.ok(body.tools.some(t => t.function?.name === 'Bash'));
          return completion({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_echo',
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf agent-ok' }) },
            }],
          });
        }
        const toolMessage = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_echo');
        assert.ok(toolMessage, 'tool result is injected into the next model turn');
        assert.match(toolMessage.content, /agent-ok/);
        return completion({ role: 'assistant', content: `final saw ${toolMessage.content.includes('agent-ok')}` });
      });

      assert.equal(result.status, 200);
      assert.equal(calls, 2);
      assert.equal(result.body.choices[0].message.content, 'final saw true');
      assert.equal(result.body.usage.agent_iterations, 1);
      assert.equal(result.body.usage.agent_tool_calls, 1);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test('parses emulated tool text and executes it for real', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'windsurf-agent-emulated-'));
    try {
      let calls = 0;
      const result = await handleAgentChatCompletions({
        model: 'test-model',
        agent: { enabled: true, working_directory: workdir },
        messages: [{ role: 'user', content: 'write a real file' }],
      }, {}, async (body) => {
        calls++;
        if (calls === 1) {
          return completion({
            role: 'assistant',
            content: '<tool_call>{"name":"Write","arguments":{"file_path":"real.txt","content":"actually-written"}}</tool_call>',
          });
        }
        const toolMessage = body.messages.find(m => m.role === 'tool');
        assert.ok(toolMessage, 'emulated tool call is converted into an executed tool result');
        assert.match(toolMessage.content, /Wrote 16 bytes/);
        return completion({ role: 'assistant', content: 'done after real write' });
      });

      assert.equal(result.status, 200);
      assert.equal(calls, 2);
      assert.equal(await readFile(join(workdir, 'real.txt'), 'utf8'), 'actually-written');
      assert.equal(result.body.usage.agent_tool_calls, 1);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test('built-in Read enforces working-directory boundary', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'windsurf-agent-read-'));
    try {
      await writeFile(join(workdir, 'note.txt'), 'hello');
      const ok = await executeAgentToolCall({ function: { name: 'Read', arguments: JSON.stringify({ file_path: 'note.txt' }) } }, { workingDirectory: workdir, timeoutMs: 1000, outputLimit: 1000 });
      assert.equal(ok, 'hello');
      const denied = await executeAgentToolCall({ function: { name: 'Read', arguments: JSON.stringify({ file_path: '../outside.txt' }) } }, { workingDirectory: workdir, timeoutMs: 1000, outputLimit: 1000 });
      assert.match(denied, /Path escapes agent working directory/);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test('stops safely when max iterations is reached', async () => {
    let calls = 0;
    const result = await handleAgentChatCompletions({
      model: 'test-model',
      agent: { enabled: true, max_iterations: 1 },
      messages: [{ role: 'user', content: 'loop' }],
    }, {}, async () => {
      calls++;
      return completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${calls}`,
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf loop' }) },
        }],
      });
    });

    assert.equal(calls, 2);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.type, 'agent_max_iterations_exceeded');
  });
});

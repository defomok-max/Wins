// Salvage pass for tool-call shapes the primary parser misses.
//
// Issue #109 / sub2api E2E: GPT-5.x and Gemini families don't always
// emit the canonical `<tool_call>{"name":...}</tool_call>` envelope —
// they fall back to markdown-fenced JSON, OpenAI native function_call
// shape, or whitespace-padded bare JSON. The primary streaming parser
// looks for exact substrings (`{"name"`) which miss these variants.
//
// parseToolCallsFromText runs a salvage pass *only* when the primary
// parser found zero tool calls, so we never override a successful
// parse but recover a tool call when the model went off-format.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallsFromText } from '../src/handlers/tool-emulation.js';

describe('parseToolCallsFromText salvage pass', () => {
  test('recovers markdown-fenced JSON ```json {"name":...} ```', () => {
    const text = 'Sure, I will use the tool.\n\n```json\n{"name":"echo","arguments":{"text":"hello"}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo');
    assert.equal(r.toolCalls[0].argumentsJson, '{"text":"hello"}');
  });

  test('recovers ``` (no language) fenced JSON', () => {
    const text = 'I\'ll call:\n```\n{"name":"read_file","arguments":{"path":"/etc/hosts"}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'read_file');
  });

  test('recovers ```tool_call fenced JSON (Anthropic-style hint)', () => {
    const text = '```tool_call\n{"name":"bash","arguments":{"command":"ls -la"}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'bash');
  });

  test('recovers OpenAI native function_call shape', () => {
    const text = '{"function_call":{"name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo');
    // arguments was already a string in OpenAI format — pass through verbatim
    assert.equal(r.toolCalls[0].argumentsJson, '{"text":"hi"}');
  });

  test('recovers OpenAI tool_calls array shape', () => {
    const text = '{"tool_calls":[{"id":"x","type":"function","function":{"name":"echo","arguments":"{\\"text\\":\\"a\\"}"}},{"function":{"name":"read","arguments":{"path":"y"}}}]}';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.toolCalls[0].name, 'echo');
    assert.equal(r.toolCalls[1].name, 'read');
  });

  test('recovers whitespace-padded bare JSON', () => {
    const text = 'Here you go:\n{ "name": "echo", "arguments": { "text": "hello" } }';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo');
  });

  test('recovers multiple fenced calls in one response', () => {
    const text = 'Step 1:\n```json\n{"name":"a","arguments":{}}\n```\nStep 2:\n```json\n{"name":"b","arguments":{"x":1}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 2);
    assert.deepEqual(r.toolCalls.map(c => c.name), ['a', 'b']);
  });

  test('does NOT override primary parser when XML envelope already worked', () => {
    // Primary parser handles canonical XML — salvage must not run and
    // duplicate calls.
    const text = '<tool_call>{"name":"echo","arguments":{"text":"hi"}}</tool_call>';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo');
  });

  test('does NOT salvage from prose-only response (no tool-shaped tokens)', () => {
    const text = 'Hello! I cannot help with that request.';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 0);
    assert.equal(r.text, text);
  });

  test('does NOT salvage malformed JSON inside fence', () => {
    const text = '```json\n{"name":"echo", broken json here\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 0);
  });

  test('preserves prose around salvaged blocks', () => {
    const text = 'Calling now:\n```json\n{"name":"echo","arguments":{"text":"hi"}}\n```\nDone.';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo');
    // Prose context is preserved so the client can show it alongside
    // the tool_use block. Empty markdown fences may remain because the
    // primary bare-JSON parser strips just the JSON body — cosmetic
    // only, doesn't affect tool dispatch.
    assert.match(r.text, /Calling now:/);
    assert.match(r.text, /Done\./);
  });

  // Codex review test-gaps — false-positive cases the salvage MUST reject.
  test('rejects {"function":{"name":"metadata"}} with no arguments key', () => {
    // Real GPT outputs sometimes include `function` as metadata in nested JSON
    // (e.g., describing a function in prose). Without the `arguments` key it
    // is NOT a tool call.
    const text = '{"function":{"name":"some_metadata_label"}}';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 0);
  });

  test('rejects fenced JSON with no name field', () => {
    const text = '```json\n{"description":"echo tool","schema":{}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 0);
  });

  test('rejects whitespace-padded bare JSON missing arguments', () => {
    const text = 'Maybe: { "name": "echo" }';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 0);
  });

  test('handles escaped quotes/braces inside string arguments', () => {
    const text = '```json\n{"name":"echo","arguments":{"text":"he said \\"hi\\" then {x: 1}"}}\n```';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(JSON.parse(r.toolCalls[0].argumentsJson).text, 'he said "hi" then {x: 1}');
  });

  test('extracts only matching tool_calls from mixed array (skip malformed)', () => {
    const text = '{"tool_calls":[{"function":{"name":"good","arguments":"{}"}},{"function":{"name":"no_args"}},{"junk":true}]}';
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'good');
  });

  test('GPT-style prose + final fenced call (most common observed pattern)', () => {
    // Modeled after live observation of GPT-5.x responses to /v1/messages
    // with tool_choice=any. The model narrates intent then emits the call
    // in markdown — exactly the shape the strict parser misses.
    const text = "I will use the echo_text tool to print HELLO.\n\n```json\n{\"name\": \"echo_text\", \"arguments\": {\"text\": \"HELLO\"}}\n```";
    const r = parseToolCallsFromText(text, { dialect: 'openai_json_xml' });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'echo_text');
    assert.equal(JSON.parse(r.toolCalls[0].argumentsJson).text, 'HELLO');
  });
});

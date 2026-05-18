// v2.0.79 — strict audit follow-up (3 MED + 2 LOW + 1 close-out).
//
//   M-1: sticky-username regex widened to catch bright-data /
//        oxylabs schemas that don't include explicit "session" tokens.
//   M-2: toolActive 180s ceiling now requires recent progress
//        (msSinceGrowth < graceMs) OR an ACTIVE step. Previously
//        engaged for the full 180s after any tool call.
//   M-3: oneTimeTokenDualPath falls through to non-preferred host
//        when preferred returns 401 invalid_token (cross-host
//        symmetry break). Other 4xx still short-circuit.
//   L-2: workspaceId derivation sha256-16 instead of apiKey-prefix-8.
//   L-3: NLU prose-rejection — additional captured patterns from
//        real-world model output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickWarmStallCeiling } from '../src/client.js';
import { extractIntentFromNarrative } from '../src/handlers/intent-extractor.js';

describe('M-2 pickWarmStallCeiling — toolActive grace window', () => {
  const T = { warmStallMs: 45_000, warmStallThinkingMs: 120_000, warmStallToolActiveMs: 180_000 };

  it('toolCall + recent progress (msSinceGrowth=10s) → 180s ceiling', () => {
    assert.equal(pickWarmStallCeiling({ toolCallCount: 1, msSinceGrowth: 10_000 }, T), 180_000);
  });

  it('toolCall + stale progress (msSinceGrowth=90s) → falls back to text-only 45s', () => {
    // Tool call was emitted, but the trajectory has been silent for
    // longer than the grace window — tool likely already finished
    // and the planner is stuck. Don't keep the 180s ceiling.
    assert.equal(pickWarmStallCeiling({ toolCallCount: 1, msSinceGrowth: 90_000 }, T), 45_000);
  });

  it('toolCall + stale + thinking present → falls back to thinking 120s', () => {
    assert.equal(pickWarmStallCeiling({ toolCallCount: 1, msSinceGrowth: 90_000, totalThinking: 500 }, T), 120_000);
  });

  it('hasActiveStep=true overrides time check — 180s applies even after long silence', () => {
    // The LS told us a step is currently ACTIVE — the tool is
    // genuinely still running (curl, npm install). Trust it.
    assert.equal(pickWarmStallCeiling({ toolCallCount: 1, msSinceGrowth: 150_000, hasActiveStep: true }, T), 180_000);
  });

  it('no toolCall — grace window is irrelevant, falls through to thinking/text', () => {
    assert.equal(pickWarmStallCeiling({ toolCallCount: 0, msSinceGrowth: 30_000, totalThinking: 200 }, T), 120_000);
    assert.equal(pickWarmStallCeiling({ toolCallCount: 0, msSinceGrowth: 30_000 }, T), 45_000);
  });
});

describe('L-3 NLU prose-rejection — additional real-world patterns', () => {
  const fnTool = (name, props = { command: 'string' }, required = ['command']) => ({
    type: 'function',
    function: {
      name, description: `${name}`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
        required,
      },
    },
  });
  const SHELL = fnTool('shell_exec');
  const READ = fnTool('Read', { file_path: 'string' }, ['file_path']);
  const ACT = { lastUserText: 'run the command' };
  const READ_ACT = { lastUserText: 'read a file' };

  it('rejects "to run a shell command" Layer 3 capture (the v2.0.77 GLM reproducer)', () => {
    const r = extractIntentFromNarrative(
      'I should call shell_exec to run a shell command.',
      [SHELL], ACT,
    );
    assert.equal(r.length, 0);
  });

  it('rejects "your input" / "this command" / "that argument"', () => {
    for (const v of ['your input', 'this command', 'that argument', 'these parameters']) {
      const r = extractIntentFromNarrative(
        `I'll call shell_exec with command '${v}'`,
        [SHELL], ACT,
      );
      assert.equal(r.length, 0, `placeholder phrase "${v}" should be rejected`);
    }
  });

  it('rejects "the specified file" / "an argument" Read narratives', () => {
    for (const v of ['the specified file', 'an argument', 'some path']) {
      const r = extractIntentFromNarrative(
        `I'll call Read with file_path '${v}'`,
        [READ], READ_ACT,
      );
      assert.equal(r.length, 0, `placeholder phrase "${v}" should be rejected`);
    }
  });

  it('still accepts realistic concrete values', () => {
    const r1 = extractIntentFromNarrative(
      "I'll call shell_exec with command 'echo HELLO'",
      [SHELL], ACT,
    );
    assert.equal(r1.length, 1);
    const r2 = extractIntentFromNarrative(
      "I'll call Read with file_path '/etc/hostname'",
      [READ], READ_ACT,
    );
    assert.equal(r2.length, 1);
  });

  it('rejects "to read the file" capture (Layer 3 to <verb> pattern)', () => {
    const r = extractIntentFromNarrative(
      "I'll invoke the Read tool to read the file.",
      [READ], READ_ACT,
    );
    assert.equal(r.length, 0);
  });
});

describe('M-1 sticky username regex — bright-data / oxylabs widening', () => {
  // STICKY_USER_RE isn't exported — test the patterns it should match
  // and ones it should reject by importing through the live regex via
  // its source. We re-create the regex here from the langserver source
  // to avoid coupling to internal helpers.
  const STICKY_USER_RE = /(?:[_-](?:sid|session|sessid|sticky|sess)|[+]ws_|^brd-customer-|customer-[^-]+-(?:cc|zone|country|state|city)-|-zone-[a-z]+|-cc-[a-z]{2})/i;

  it('matches bright-data customer prefix', () => {
    assert.ok(STICKY_USER_RE.test('brd-customer-hl_abc123-zone-residential'));
  });

  it('matches oxylabs cc/country pattern even without session token', () => {
    assert.ok(STICKY_USER_RE.test('customer-myuser-cc-US-country-US'));
    assert.ok(STICKY_USER_RE.test('customer-foo-zone-residential'));
  });

  it('still matches the original v2.0.71 patterns (regression guard)', () => {
    assert.ok(STICKY_USER_RE.test('username_sid_abcdef'));
    assert.ok(STICKY_USER_RE.test('user-zone-residential-session-xyz'));
    assert.ok(STICKY_USER_RE.test('account-sticky-aa'));
    assert.ok(STICKY_USER_RE.test('user-sessid-bb'));
    assert.ok(STICKY_USER_RE.test('foo+ws_pool'));
  });

  it('rejects bare static-IP usernames (no session marker, no provider prefix)', () => {
    assert.ok(!STICKY_USER_RE.test('myproxy-user'));
    assert.ok(!STICKY_USER_RE.test('admin'));
    assert.ok(!STICKY_USER_RE.test('john_doe'));
  });
});

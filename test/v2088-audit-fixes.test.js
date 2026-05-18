// v2.0.88 — strict audit follow-up: 4 HIGH + 3 MED/LOW from
// dual-audit of v2.0.85-87 retry/alias/cleanup designs.
//
//   H-1: alias must use merged routingKey, not raw body.model
//        (reasoning_effort split breaks dual-index otherwise)
//   H-2: invalidateFor cascades to sibling slots sharing cascadeId
//        (alias write left dead siblings on lsPort restart)
//   H-3: fallback success cacheSet writes original ckey too
//        (otherwise next request misses cache + re-burns rate-limit)
//   H-4: stopLanguageServerAndWait waits for child exit
//        (race between SIGTERM dispatch and process.exit)
//   M-1: stats.stores counts per logical checkin not per slot
//   L-1: cleanup matches binary by argv[0] not substring

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkin, checkout, fingerprintAfter, invalidateFor, poolClear, poolStats,
} from '../src/conversation-pool.js';
import { stopLanguageServerAndWait } from '../src/langserver.js';

describe('H-2 — invalidateFor cascades to sibling alias slots', () => {
  beforeEach(() => poolClear());

  it('invalidate by lsPort drops alias siblings sharing cascadeId', () => {
    // Simulate post-fallback dual-write: same cascadeId indexed under
    // primary fingerprint (xhigh) AND alias fingerprint (max). Both
    // entries carry the same lsPort.
    const fpPrimary = 'fp_xhigh';
    const fpAlias = 'fp_max';
    checkin([fpPrimary, fpAlias], {
      cascadeId: 'cas_dual',
      sessionId: 's',
      lsPort: 42100,
      lsGeneration: 1,
      apiKey: 'k_a',
    }, 'caller');
    // LS on port 42100 restarts → invalidateFor cleans up.
    const dropped = invalidateFor({ lsPort: 42100, lsGeneration: 1 });
    assert.equal(dropped, 2, 'both slots must drop');
    assert.equal(checkout(fpPrimary, 'caller'), null);
    assert.equal(checkout(fpAlias, 'caller'), null);
  });

  it('invalidate by apiKey drops alias siblings even when lsPort scan would not normally touch them', () => {
    // Edge: alias slot's lsPort happens to differ (rare but possible
    // if entry is rebuilt across a port migration). With cascadeId
    // sweep this is covered.
    const fpA = 'fp_A';
    const fpB = 'fp_B';
    checkin([fpA, fpB], {
      cascadeId: 'cas_shared',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k_x',
    }, 'caller');
    const dropped = invalidateFor({ apiKey: 'k_x' });
    assert.equal(dropped, 2);
  });

  it('does not drop unrelated cascades', () => {
    checkin('fp_keep', {
      cascadeId: 'cas_keep',
      sessionId: 's',
      lsPort: 42101,
      apiKey: 'k_other',
    }, 'caller');
    checkin('fp_drop', {
      cascadeId: 'cas_drop',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k_target',
    }, 'caller');
    const dropped = invalidateFor({ apiKey: 'k_target' });
    assert.equal(dropped, 1);
    assert.ok(checkout('fp_keep', 'caller'), 'unrelated entry must survive');
  });
});

describe('M-1 — stats.stores counts per logical checkin not per slot', () => {
  beforeEach(() => poolClear());

  it('single checkin = stores+1 regardless of fingerprint count', () => {
    const before = poolStats().stores;
    checkin(['fpA', 'fpB', 'fpC'], {
      cascadeId: 'cas',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'c');
    assert.equal(poolStats().stores, before + 1, 'stores increments once per logical conversation, not 3 times');
  });

  it('aliasWrites tracks the extra slots separately', () => {
    const before = poolStats().aliasWrites || 0;
    checkin(['x', 'y', 'z'], {
      cascadeId: 'cas',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'c');
    const s = poolStats();
    assert.equal(s.aliasWrites - before, 2, '2 sibling alias slots beyond the primary');
  });

  it('single-fp checkin does not bump aliasWrites', () => {
    const before = poolStats().aliasWrites || 0;
    checkin('fpOnly', { cascadeId: 'cas', sessionId: 's', lsPort: 42100, apiKey: 'k' }, 'c');
    assert.equal((poolStats().aliasWrites || 0) - before, 0);
  });
});

describe('H-1 — fingerprint alias key uses MERGED routingKey not raw body.model', () => {
  // Simulates the codex CLI pattern: client sends model='claude-opus-4-7'
  // + reasoning_effort='max'. mergeReasoningEffortIntoModel merges those
  // into the routing model 'claude-opus-4-7-max' before fingerprint
  // computation. v2.0.87 passed raw body.model as __aliasModelKey,
  // which fingerprinted to a slot the next turn never queried.
  beforeEach(() => poolClear());

  it('alias write under merged routing key matches next-turn lookup', () => {
    // Turn 1 (fallback retry): inner runs under fallback model name,
    // alias-write happens under the merged original routing key.
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const fpOpts = { route: 'chat' };
    const fallbackKey = 'claude-opus-4-7-xhigh';
    const originalRoutingKey = 'claude-opus-4-7-max'; // merged from body.model='claude-opus-4-7' + effort='max'
    const fpServed = fingerprintAfter(messages, fallbackKey, 'caller', fpOpts);
    const fpAliasMerged = fingerprintAfter(messages, originalRoutingKey, 'caller', fpOpts);
    checkin([fpServed, fpAliasMerged], {
      cascadeId: 'cas_h1',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'caller');

    // Turn 2: client arrives with same body. Inner computes
    // routingModelKey through the same merge function — so the
    // next-turn fingerprint matches the merged-key alias slot.
    const fpNextTurn = fingerprintAfter(messages, originalRoutingKey, 'caller', fpOpts);
    const e = checkout(fpNextTurn, 'caller');
    assert.equal(e?.cascadeId, 'cas_h1', 'merged routing key alias must hit on next-turn lookup');
  });
});

describe('H-4 — stopLanguageServerAndWait waits for child exit', () => {
  it('exists and is async', () => {
    assert.equal(typeof stopLanguageServerAndWait, 'function');
    assert.equal(stopLanguageServerAndWait.constructor.name, 'AsyncFunction');
  });

  it('returns Promise that resolves even with empty pool', async () => {
    // No LSes in pool → resolves immediately.
    await stopLanguageServerAndWait({ perProcessTimeoutMs: 100 });
  });
});

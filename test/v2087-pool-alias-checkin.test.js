// v2.0.87 — cascade pool alias checkin (#129 wnfilm).
//
// When auto-fallback fires (claude-opus-4-7-max → -xhigh), the cascade
// produced under -xhigh used to be indexed in the pool only under the
// -xhigh fingerprint. The next turn from the client (still asking for
// -max) missed the pool and the model lost prior conversation state.
//
// v2.0.87 makes `checkin` accept a list of fingerprints so the same
// entry is dual-indexed; chat.js threads `context.__aliasModelKey`
// from the outer wrapper into the inner so the original modelKey's
// fingerprint also gets the entry.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkin, checkout, fingerprintAfter, poolClear, poolStats,
} from '../src/conversation-pool.js';

describe('checkin — backward compatible single fingerprint', () => {
  beforeEach(() => poolClear());

  it('single string fp still works', () => {
    const fp = 'fp_alpha';
    checkin(fp, {
      cascadeId: 'cas_alpha',
      sessionId: 'sess_alpha',
      lsPort: 42100,
      lsGeneration: 1,
      apiKey: 'sk_x',
    }, 'caller_x');
    const e = checkout(fp, 'caller_x');
    assert.equal(e?.cascadeId, 'cas_alpha');
  });

  it('null / empty / non-string fp is a no-op', () => {
    const before = poolStats().stores;
    checkin(null, { cascadeId: 'x' });
    checkin('', { cascadeId: 'x' });
    checkin(undefined, { cascadeId: 'x' });
    assert.equal(poolStats().stores, before);
  });
});

describe('checkin — list of fingerprints (v2.0.87 alias)', () => {
  beforeEach(() => poolClear());

  it('writes the same entry under every fingerprint in the list', () => {
    const fpMax = 'fp_max';
    const fpXhigh = 'fp_xhigh';
    checkin([fpMax, fpXhigh], {
      cascadeId: 'cas_shared',
      sessionId: 'sess_shared',
      lsPort: 42100,
      lsGeneration: 1,
      apiKey: 'sk_y',
    }, 'caller_y');
    const eMax = checkout(fpMax, 'caller_y');
    const eXhigh = checkout(fpXhigh, 'caller_y');
    assert.equal(eMax?.cascadeId, 'cas_shared');
    assert.equal(eXhigh?.cascadeId, 'cas_shared');
  });

  it('ignores empty / non-string entries in the list', () => {
    const fpReal = 'fp_real';
    checkin([fpReal, '', null, undefined, 42], {
      cascadeId: 'cas_real',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'c');
    const e = checkout(fpReal, 'c');
    assert.equal(e?.cascadeId, 'cas_real');
  });

  it('checkout under one alias does NOT consume the other (independent slots)', () => {
    const fpA = 'fp_A';
    const fpB = 'fp_B';
    checkin([fpA, fpB], {
      cascadeId: 'shared',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'c');
    // Pool is consume-on-checkout (LRU style). After checking out fpA
    // the entry leaves that slot. fpB still has its own copy.
    const eA = checkout(fpA, 'c');
    assert.equal(eA?.cascadeId, 'shared');
    const eB = checkout(fpB, 'c');
    assert.equal(eB?.cascadeId, 'shared');
  });

  it('empty list does nothing', () => {
    const before = poolStats().stores;
    checkin([], { cascadeId: 'x', apiKey: 'k', lsPort: 42100 });
    assert.equal(poolStats().stores, before);
  });
});

describe('alias checkin — realistic auto-fallback scenario', () => {
  beforeEach(() => poolClear());

  it('cascade from xhigh is checkout-able under both xhigh and max fingerprints', () => {
    // Simulate the post-turn state of a fallback retry. Outer wrapper
    // rewrote model max → xhigh, inner ran the turn under xhigh, now
    // checkin needs to dual-index so the next turn (back to max)
    // finds the same cascade.
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ];
    const fpOpts = { route: 'chat' };
    const fpServed = fingerprintAfter(messages, 'claude-opus-4-7-xhigh', 'caller_z', fpOpts);
    const fpAlias = fingerprintAfter(messages, 'claude-opus-4-7-max', 'caller_z', fpOpts);
    assert.notEqual(fpServed, fpAlias, 'precondition: different model keys produce different fps');

    checkin([fpServed, fpAlias], {
      cascadeId: 'cas_fb',
      sessionId: 's',
      lsPort: 42100,
      apiKey: 'k',
    }, 'caller_z');

    // Next-turn from client: same caller, model=max → fpAlias
    const e = checkout(fpAlias, 'caller_z');
    assert.equal(e?.cascadeId, 'cas_fb',
      'cascade produced under xhigh must be findable under max alias after fallback');
  });
});

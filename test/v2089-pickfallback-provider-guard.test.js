// v2.0.89 — pickRateLimitFallback same-provider hard guard.
//
// Audit follow-up to v2.0.88 H-1.5: cascade pool alias write relies
// on the alias slot's fpAfter and the next-turn fpBefore producing
// IDENTICAL toolPreamble bytes. toolPreamble is dialect-keyed; dialect
// is provider-keyed. Cross-provider fallback would silently break
// reuse despite the alias write succeeding.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickRateLimitFallback } from '../src/models.js';

describe('pickRateLimitFallback — same-provider guard', () => {
  it('returns same-provider sibling for in-ladder effort downgrade', () => {
    // claude-opus-4-7-max → -xhigh, both anthropic.
    const r = pickRateLimitFallback('claude-opus-4-7-max');
    assert.equal(r, 'claude-opus-4-7-xhigh');
  });

  it('returns same-provider sibling for codex max sub-ladder', () => {
    // gpt-5.1-codex-max-high → -medium, both openai.
    const r = pickRateLimitFallback('gpt-5.1-codex-max-high');
    assert.equal(r, 'gpt-5.1-codex-max-medium');
  });

  it('1m context drop stays same-provider', () => {
    const r = pickRateLimitFallback('claude-sonnet-4.6-1m');
    assert.equal(r, 'claude-sonnet-4.6');
  });

  it('returns null when no same-provider sibling exists in catalog', () => {
    // -low is the bottom of the effort ladder.
    assert.equal(pickRateLimitFallback('claude-opus-4-7-low'), null);
  });

  it('-thinking variants skip the fallback (different user-visible behaviour)', () => {
    assert.equal(pickRateLimitFallback('claude-sonnet-4.6-thinking'), null);
  });

  it('unknown model returns null', () => {
    assert.equal(pickRateLimitFallback('made-up-xhigh'), null);
  });
});

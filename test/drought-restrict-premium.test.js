// v2.0.58 — drought-mode premium model gate.
// When every active account has weekly% < 5 AND
// droughtRestrictPremium=true, isModelBlockedByDrought(modelKey) must
// return true for non-free-tier models and false for free-tier ones.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  isModelBlockedByDrought, isDroughtMode, isDroughtRestrictEnabled,
  setDroughtRestrictResolver, getDroughtSummary,
} from '../src/auth.js';

const created = [];
function mk(label, credits, status = 'active') {
  const a = addAccountByKey('sk-droughtgate-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), label);
  const acct = getAccountInternal(a.id);
  acct.status = status;
  acct.credits = credits;
  created.push(a.id);
  return acct;
}

const originalEnv = process.env.DROUGHT_RESTRICT_PREMIUM;

beforeEach(() => {
  delete process.env.DROUGHT_RESTRICT_PREMIUM;
  setDroughtRestrictResolver(null);
});

afterEach(() => {
  while (created.length) removeAccount(created.pop());
  if (originalEnv === undefined) delete process.env.DROUGHT_RESTRICT_PREMIUM;
  else process.env.DROUGHT_RESTRICT_PREMIUM = originalEnv;
  setDroughtRestrictResolver(null);
});

describe('isDroughtRestrictEnabled (v2.0.58)', () => {
  it('honours DROUGHT_RESTRICT_PREMIUM=0 even when runtime resolver returns true', () => {
    process.env.DROUGHT_RESTRICT_PREMIUM = '0';
    setDroughtRestrictResolver(() => true);
    assert.equal(isDroughtRestrictEnabled(), false);
  });

  it('honours DROUGHT_RESTRICT_PREMIUM=1 even when resolver returns false', () => {
    process.env.DROUGHT_RESTRICT_PREMIUM = '1';
    setDroughtRestrictResolver(() => false);
    assert.equal(isDroughtRestrictEnabled(), true);
  });

  it('falls back to runtime-config resolver when env unset', () => {
    setDroughtRestrictResolver(() => true);
    assert.equal(isDroughtRestrictEnabled(), true);
    setDroughtRestrictResolver(() => false);
    assert.equal(isDroughtRestrictEnabled(), false);
  });

  it('defaults to true when no env and no resolver', () => {
    assert.equal(isDroughtRestrictEnabled(), true);
  });
});

describe('isModelBlockedByDrought (v2.0.58)', () => {
  it('returns false when not in drought mode (healthy account)', () => {
    mk('healthy', { weeklyPercent: 80, dailyPercent: 80 });
    assert.equal(isDroughtMode(), false);
    assert.equal(isModelBlockedByDrought('claude-sonnet-4.6'), false);
  });

  it('returns true for premium models when in drought + restrict enabled', () => {
    mk('low-1', { weeklyPercent: 2, dailyPercent: 5 });
    mk('low-2', { weeklyPercent: 4, dailyPercent: 8 });
    assert.equal(isDroughtMode(), true);
    // Default restrict = enabled
    assert.equal(isModelBlockedByDrought('claude-sonnet-4.6'), true);
    assert.equal(isModelBlockedByDrought('claude-opus-4.6'), true);
    assert.equal(isModelBlockedByDrought('gpt-5.5-medium'), true);
  });

  it('returns false for free-tier models even during drought', () => {
    mk('low-1', { weeklyPercent: 1, dailyPercent: 1 });
    mk('low-2', { weeklyPercent: 0, dailyPercent: 0 });
    assert.equal(isDroughtMode(), true);
    assert.equal(isModelBlockedByDrought('gemini-2.5-flash'), false);
  });

  it('returns false when restrict disabled even if in drought', () => {
    process.env.DROUGHT_RESTRICT_PREMIUM = '0';
    mk('low-1', { weeklyPercent: 1, dailyPercent: 0 });
    mk('low-2', { weeklyPercent: 2, dailyPercent: 1 });
    assert.equal(isDroughtMode(), true);
    assert.equal(isModelBlockedByDrought('claude-sonnet-4.6'), false);
  });

  it('returns false for empty/null modelKey', () => {
    mk('low-1', { weeklyPercent: 1 });
    mk('low-2', { weeklyPercent: 1 });
    assert.equal(isModelBlockedByDrought(null), false);
    assert.equal(isModelBlockedByDrought(''), false);
    assert.equal(isModelBlockedByDrought(undefined), false);
  });
});

describe('getDroughtSummary includes restriction state (v2.0.58)', () => {
  it('reports restrictEnabled + freeTierModels', () => {
    mk('a', { weeklyPercent: 50, dailyPercent: 50 });
    const s = getDroughtSummary();
    assert.equal(typeof s.restrictEnabled, 'boolean');
    assert.ok(Array.isArray(s.freeTierModels));
    assert.ok(s.freeTierModels.includes('gemini-2.5-flash'),
      `freeTierModels should include gemini-2.5-flash, got ${JSON.stringify(s.freeTierModels)}`);
  });
});

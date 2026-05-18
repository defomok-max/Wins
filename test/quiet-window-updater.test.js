// v2.0.67 (#112) — Quiet-window auto-update detector.
//
// Covers the decision-tree branches (disabled / cold-start / cooldown /
// busy / eligible) plus the ring buffer's pruning + cap behaviour, plus
// the actual runUpdate dispatch path through a mocked runner so no
// docker socket is required.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  markRequest, isQuiet, evaluateTick,
  startQuietWindowAutoUpdate, stopQuietWindowAutoUpdate,
  getStatus, setEnabled,
  _resetForTest, _injectForTest, _runOneTick,
} from '../src/dashboard/quiet-window-updater.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  _resetForTest();
  // Disable by default — tests opt in per scenario via setEnabled(true).
  setEnabled(false);
});

describe('isQuiet — pure ring inspection', () => {
  it('empty ring → quiet', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    assert.equal(isQuiet(now), true);
  });

  it('count under threshold → quiet', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    for (let i = 0; i < 4; i++) markRequest(now - i * 10_000);
    assert.equal(isQuiet(now), true);
  });

  it('count exactly at threshold → still quiet (≤ test, not <)', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    for (let i = 0; i < 5; i++) markRequest(now - i * 10_000);
    assert.equal(isQuiet(now), true);
  });

  it('count above threshold → busy', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    for (let i = 0; i < 6; i++) markRequest(now - i * 10_000);
    assert.equal(isQuiet(now), false);
  });

  it('old timestamps outside the window are ignored', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    // 20 timestamps from 10 minutes ago — all outside the default 5-min window.
    for (let i = 0; i < 20; i++) markRequest(now - 10 * MIN - i * 100);
    assert.equal(isQuiet(now), true);
  });
});

describe('evaluateTick — full decision tree', () => {
  it('disabled flag short-circuits before any other check', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    // Even with massive traffic + cooldown elapsed, disabled wins.
    for (let i = 0; i < 100; i++) markRequest(now - i * 1_000);
    setEnabled(false);
    const decision = evaluateTick(now);
    assert.equal(decision.run, false);
    assert.equal(decision.reason, 'disabled');
  });

  it('cold-start grace blocks early ticks even when enabled + quiet', () => {
    setEnabled(true);
    let now = 1_000_000_000;
    // Boot 5 minutes ago — under the default 10-min grace.
    _injectForTest({ now: () => now, startedAt: now - 5 * MIN });
    const decision = evaluateTick(now);
    assert.equal(decision.run, false);
    assert.equal(decision.reason, 'cold-start');
    assert.ok(Number.isFinite(decision.untilMs));
  });

  it('past grace + quiet + no prior update → eligible', () => {
    setEnabled(true);
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    const decision = evaluateTick(now);
    assert.equal(decision.run, true);
    assert.equal(decision.reason, 'eligible');
  });

  it('busy ring blocks update', () => {
    setEnabled(true);
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    for (let i = 0; i < 20; i++) markRequest(now - i * 5_000);
    const decision = evaluateTick(now);
    assert.equal(decision.run, false);
    assert.equal(decision.reason, 'busy');
    assert.equal(decision.threshold, 5);
    assert.ok(decision.count >= 6);
  });

  it('cooldown after a successful update suppresses further runs', async () => {
    setEnabled(true);
    let now = 1_000_000_000;
    _injectForTest({
      now: () => now,
      startedAt: now - HOUR,
      runUpdate: async () => ({ ok: true, image: 'x', project: 'p', workingDir: '/p', deployerId: 'd', delaySeconds: 8, message: 'ok' }),
    });
    // First tick: eligible → triggers update → records lastUpdateAt = now.
    const r1 = await _runOneTick();
    assert.equal(r1.run, true);
    assert.equal(r1.result.ok, true);
    // 1 hour later: still inside the 24h cooldown.
    now += HOUR;
    const r2 = evaluateTick(now);
    assert.equal(r2.run, false);
    assert.equal(r2.reason, 'cooldown');
    // 25 hours later: cooldown expired.
    now += 25 * HOUR;
    const r3 = evaluateTick(now);
    assert.equal(r3.run, true);
    assert.equal(r3.reason, 'eligible');
  });

  it('failed update does NOT start cooldown — next tick can retry', async () => {
    setEnabled(true);
    let now = 1_000_000_000;
    _injectForTest({
      now: () => now,
      startedAt: now - HOUR,
      runUpdate: async () => ({ ok: false, reason: 'no-docker-sock', detail: '/var/run/docker.sock not mounted' }),
    });
    const r1 = await _runOneTick();
    assert.equal(r1.result.ok, false);
    // Immediately tick again: lastUpdateAt was NOT set, so we're still eligible.
    const r2 = evaluateTick(now);
    assert.equal(r2.run, true);
    assert.equal(r2.reason, 'eligible');
  });
});

describe('markRequest ring cap — does not grow unbounded under heavy traffic', () => {
  it('busy host does not retain millions of timestamps', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    // Push 10× the default cap. The internal trim should kick in.
    for (let i = 0; i < 10_000; i++) markRequest(now - i * 10);
    const status = getStatus();
    // Cap is max(64, (threshold+1)*4) = max(64, 24) = 64. Two-cap soft
    // ceiling = 128 entries. Anything below 200 proves the trim works.
    assert.ok(status.ringSize <= 200, `ring grew too large: ${status.ringSize}`);
  });
});

describe('startQuietWindowAutoUpdate / stopQuietWindowAutoUpdate', () => {
  it('start arms a timer and unref()s it; stop clears it', () => {
    const timer = startQuietWindowAutoUpdate();
    assert.ok(timer);
    stopQuietWindowAutoUpdate();
    // Calling stop twice is safe.
    stopQuietWindowAutoUpdate();
  });

  it('start replaces any existing timer (idempotent across multiple starts)', () => {
    const t1 = startQuietWindowAutoUpdate();
    const t2 = startQuietWindowAutoUpdate();
    assert.notEqual(t1, t2);
    stopQuietWindowAutoUpdate();
  });
});

describe('getStatus reflects current decision + settings', () => {
  it('reports disabled + decision.reason="disabled" when off', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    setEnabled(false);
    const s = getStatus();
    assert.equal(s.enabled, false);
    assert.equal(s.decision.reason, 'disabled');
    assert.equal(typeof s.settings.windowMinutes, 'number');
    assert.equal(typeof s.settings.thresholdRequests, 'number');
    assert.equal(typeof s.settings.cooldownHours, 'number');
  });

  it('reports eligible when enabled + past grace + quiet', () => {
    let now = 1_000_000_000;
    _injectForTest({ now: () => now, startedAt: now - HOUR });
    setEnabled(true);
    const s = getStatus();
    assert.equal(s.enabled, true);
    assert.equal(s.decision.reason, 'eligible');
  });
});

describe('setEnabled persists through runtime-config', () => {
  it('setEnabled(true) flips experimental.autoUpdateQuietWindow', () => {
    setEnabled(false);
    assert.equal(getStatus().enabled, false);
    setEnabled(true);
    assert.equal(getStatus().enabled, true);
    setEnabled(false);
    assert.equal(getStatus().enabled, false);
  });
});

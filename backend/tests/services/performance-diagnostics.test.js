import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The periodic record of what the process is costing.
 *
 * It exists for the case nobody can reproduce: an installation that goes slow after
 * hours, on storage nobody here has, with a load nobody here makes. The only useful
 * answer is what the process was costing at the time, so the sampler reports CPU,
 * resident memory as the cgroup sees it, event-loop delay, and the queues that grow.
 *
 * What is worth testing is not the numbers — they are the machine's — but the three
 * decisions around them: that it says nothing at all unless it was asked for, that it
 * then reports only the intervals that look wrong, and that it can be told to report
 * every one. A diagnostic that logs on every interval by accident is a diagnostic that
 * fills a disk.
 */

let env;

afterEach(async () => {
  vi.restoreAllMocks();
  if (env) {
    env.requireFresh('src/services/performanceDiagnostics').stop();
    await env.cleanup();
  }
  env = null;
});

const load = async (extraEnv = {}) => {
  env = await setupTestEnv({ tag: 'perf-diagnostics-', env: extraEnv });
  // The logger first, and spied on before the service is loaded: the service keeps
  // whichever logger it was given at require time, so spying on a fresh one afterwards
  // watches an object nothing writes to.
  const logger = env.requireFresh('src/utils/logger');
  const said = vi.spyOn(logger, 'info');
  const diagnostics = env.requireFresh('src/services/performanceDiagnostics');
  return { diagnostics, said };
};

/** Every message a logger spy was given, as one string. */
const messages = (spy) => spy.mock.calls.map((call) => String(call[1] ?? call[0])).join('\n');

describe('the performance record', () => {
  it('is silent unless somebody asked for it', async () => {
    const { diagnostics, said } = await load();

    diagnostics.start();

    expect(messages(said)).not.toContain('Performance diagnostics');
  });

  it('says what it will watch, and by which thresholds, when it is on', async () => {
    const { diagnostics, said } = await load({
      PERFORMANCE_DIAGNOSTICS_ENABLED: 'true',
      PERFORMANCE_DIAGNOSTICS_INTERVAL_MS: '60000',
      PERFORMANCE_DIAGNOSTICS_CPU_THRESHOLD: '90',
    });

    diagnostics.start();

    expect(messages(said)).toContain('Performance diagnostics enabled');
    const announced = said.mock.calls.find(([, message]) => /enabled/.test(String(message)))[0];
    expect(announced.intervalMs).toBe(60000);
    expect(announced.cpuThreshold).toBe(90);
  });

  it('holds an interval below its floor to the default, rather than sampling constantly', async () => {
    // What an emptied or mistyped field sends. A sampler on a 1 ms interval costs more
    // than whatever it was meant to diagnose.
    const { diagnostics, said } = await load({
      PERFORMANCE_DIAGNOSTICS_ENABLED: 'true',
      PERFORMANCE_DIAGNOSTICS_INTERVAL_MS: '1',
    });

    diagnostics.start();

    const announced = said.mock.calls.find(([, message]) => /enabled/.test(String(message)))[0];
    expect(announced.intervalMs).toBe(15000);
  });

  it('reports nothing of an interval that looks ordinary', async () => {
    const { diagnostics, said } = await load({
      PERFORMANCE_DIAGNOSTICS_ENABLED: 'true',
      // Thresholds nothing here will reach.
      PERFORMANCE_DIAGNOSTICS_CPU_THRESHOLD: '100000',
      PERFORMANCE_DIAGNOSTICS_RSS_THRESHOLD_MB: '100000',
      PERFORMANCE_DIAGNOSTICS_EVENT_LOOP_DELAY_MS: '100000',
    });

    diagnostics.start();
    await vi.waitFor(() => expect(messages(said)).toContain('enabled'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const records = said.mock.calls.filter(([, message]) => message === 'Performance diagnostics');
    expect(records).toEqual([]);
  });

  it('reports one that passes a threshold, and says which kind of interval it was', async () => {
    const { diagnostics, said } = await load({
      PERFORMANCE_DIAGNOSTICS_ENABLED: 'true',
      // A memory threshold of nothing: every interval is past it.
      PERFORMANCE_DIAGNOSTICS_RSS_THRESHOLD_MB: '1',
    });

    diagnostics.start();

    await vi.waitFor(() => {
      const records = said.mock.calls.filter(
        ([, message]) => message === 'Performance diagnostics'
      );
      expect(records.length).toBeGreaterThan(0);
      expect(records[0][0].reason).toBe('resource-pressure');
    });
  });

  it('reports every interval when it is told to', async () => {
    const { diagnostics, said } = await load({
      PERFORMANCE_DIAGNOSTICS_ENABLED: 'true',
      PERFORMANCE_DIAGNOSTICS_LOG_EVERY_INTERVAL: 'true',
      PERFORMANCE_DIAGNOSTICS_CPU_THRESHOLD: '100000',
      PERFORMANCE_DIAGNOSTICS_RSS_THRESHOLD_MB: '100000',
      PERFORMANCE_DIAGNOSTICS_EVENT_LOOP_DELAY_MS: '100000',
    });

    diagnostics.start();

    await vi.waitFor(() => {
      const records = said.mock.calls.filter(
        ([, message]) => message === 'Performance diagnostics'
      );
      expect(records.length).toBeGreaterThan(0);
      // Nothing was under pressure: it is reporting because it was asked to.
      expect(records[0][0].reason).toBe('interval');
    });
  });

  it('samples the machine rather than guessing at it', async () => {
    const { diagnostics } = await load({ PERFORMANCE_DIAGNOSTICS_ENABLED: 'true' });

    const snapshot = await diagnostics.sample();

    // `toMb` rounds, and this process is small enough to round to zero on some
    // machines, so what is asserted is that the numbers came from somewhere rather
    // than what they are.
    expect(typeof snapshot.memoryMb.rss).toBe('number');
    expect(snapshot.memoryMb.heapTotal).toBeGreaterThan(0);
    // And the queues each answered, or said they had nothing to answer with.
    expect(snapshot).toHaveProperty('resources');
    expect(snapshot).toHaveProperty('cpuPercent');
  });
});

const fs = require('fs/promises');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const { performanceDiagnostics: config } = require('../config');
const logger = require('../utils/logger');
const thumbnailService = require('./thumbnailService');
const folderSizeManager = require('./folderSizeManager');
const fileTransferService = require('./fileTransferService');

let timer = null;
let previousSample = null;
let eventLoopDelay = null;

const toMb = (bytes) => Math.round((Number(bytes) || 0) / 1024 / 1024);

const readText = async (filePath) => {
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch (_) {
    return null;
  }
};

const readNumber = async (filePath) => {
  const value = await readText(filePath);
  if (value == null || value === 'max') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const readKeyValueFile = async (filePath, allowedKeys) => {
  const content = await readText(filePath);
  if (!content) return null;
  const result = {};
  for (const line of content.split('\n')) {
    const [key, rawValue] = line.trim().split(/\s+/, 2);
    if (!allowedKeys.has(key)) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) result[key] = toMb(value);
  }
  return result;
};

const readCgroupMemory = async () => {
  const v2Current = await readNumber('/sys/fs/cgroup/memory.current');
  const v2Limit = await readNumber('/sys/fs/cgroup/memory.max');
  const isV2 = v2Current != null;
  const current = isV2
    ? v2Current
    : await readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const limit = isV2 ? v2Limit : await readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const stat = await readKeyValueFile(
    isV2 ? '/sys/fs/cgroup/memory.stat' : '/sys/fs/cgroup/memory/memory.stat',
    new Set(['anon', 'file', 'slab', 'slab_reclaimable', 'slab_unreclaimable', 'cache', 'rss'])
  );

  if (current == null && !stat) return null;
  return {
    currentMb: toMb(current),
    ...(limit != null ? { limitMb: toMb(limit) } : {}),
    ...(stat ? { statMb: stat } : {}),
  };
};

const activeResourceCounts = () => {
  if (typeof process.getActiveResourcesInfo !== 'function') return undefined;
  return process.getActiveResourcesInfo().reduce((counts, name) => {
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
};

const sample = async () => {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const [cgroupMemory, thumbnail, folderSize, transfers] = await Promise.all([
    readCgroupMemory(),
    Promise.resolve(thumbnailService.getDiagnosticsSnapshot()),
    Promise.resolve(folderSizeManager.getDiagnosticsSnapshot()),
    Promise.resolve(fileTransferService.getDiagnosticsSnapshot()),
  ]);

  const elapsedMs = previousSample ? Math.max(1, now - previousSample.at) : null;
  const cpuDeltaUs = previousSample
    ? cpu.user - previousSample.cpu.user + (cpu.system - previousSample.cpu.system)
    : null;
  const cpuPercent =
    elapsedMs != null && cpuDeltaUs != null
      ? Math.round((cpuDeltaUs / 1000 / elapsedMs) * 100)
      : null;
  const loopDelayMs = eventLoopDelay
    ? Number(eventLoopDelay.percentile(99) / 1e6).toFixed(1)
    : null;
  const eventLoopUtilization = previousSample?.eventLoopUtilization
    ? performance.eventLoopUtilization(previousSample.eventLoopUtilization)
    : null;

  previousSample = {
    at: now,
    cpu,
    eventLoopUtilization: performance.eventLoopUtilization(),
  };
  eventLoopDelay?.reset();

  return {
    cpuPercent,
    ...(eventLoopUtilization
      ? { eventLoopUtilizationPercent: Math.round(eventLoopUtilization.utilization * 100) }
      : {}),
    ...(loopDelayMs != null ? { eventLoopP99DelayMs: Number(loopDelayMs) } : {}),
    memoryMb: {
      rss: toMb(memory.rss),
      heapUsed: toMb(memory.heapUsed),
      heapTotal: toMb(memory.heapTotal),
      external: toMb(memory.external),
      arrayBuffers: toMb(memory.arrayBuffers),
    },
    cgroupMemory,
    resources: activeResourceCounts(),
    thumbnail,
    folderSize,
    transfers,
  };
};

const isPressure = (snapshot) =>
  (snapshot.cpuPercent ?? 0) >= config.cpuThreshold ||
  snapshot.memoryMb.rss >= config.rssThresholdMb ||
  (snapshot.eventLoopP99DelayMs ?? 0) >= config.eventLoopDelayThresholdMs;

const start = () => {
  if (!config.enabled || timer) return;

  eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  logger.info(
    {
      intervalMs: config.intervalMs,
      cpuThreshold: config.cpuThreshold,
      rssThresholdMb: config.rssThresholdMb,
      eventLoopDelayThresholdMs: config.eventLoopDelayThresholdMs,
      logEveryInterval: config.logEveryInterval,
    },
    'Performance diagnostics enabled'
  );

  const tick = () => {
    sample()
      .then((snapshot) => {
        if (config.logEveryInterval || isPressure(snapshot)) {
          logger.info(
            { reason: isPressure(snapshot) ? 'resource-pressure' : 'interval', ...snapshot },
            'Performance diagnostics'
          );
        }
      })
      .catch((err) => logger.debug({ err }, 'Performance diagnostics sample failed'));
  };

  tick();
  timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
  eventLoopDelay?.disable();
  eventLoopDelay = null;
  previousSample = null;
};

module.exports = { start, stop, sample };

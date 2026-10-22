const URL = 'redis://127.0.0.1:16495';
const Redis = (await import('ioredis')).default;
const { createRamGate } = await import('/home/kenneth/.openclaw/workspace/water_army/packages/shared/src/ram-gate.js');

const redis = new Redis(URL, { maxRetriesPerRequest: 1 });
await redis.flushdb();
const metrics = { sample: async () => ({ ts: Date.now(), memAvailableMiB: 30000, memTotalMiB: 94000, memFreeMiB: 2500, swapTotalMiB: 8192, swapFreeMiB: 8100, loadAvg: [1, 1, 1], source: 'probe' }) };

// E-shape: no config patch
const g1 = createRamGate({ redis, metrics, log: { warn: (m) => console.log('[warn]', m), error: (m) => console.log('[err]', m), info() {} } });
const r1 = await g1.admit({ kind: 'device', entityKey: 'probe-dev', source: 'probe' });
console.log('E-shape admit:', JSON.stringify(r1));
console.log('liveCount:', await g1.liveCount());

// D-shape: leaseTtlMs 700
const g2 = createRamGate({ redis, metrics, configSource: async () => ({ leaseTtlMs: 700 }), log: { warn() {}, error: (m) => console.log('[err2]', m), info() {} } });
const r2 = await g2.admit({ kind: 'device', entityKey: 'probe-dev2', source: 'probe' });
console.log('D-shape admit:', JSON.stringify(r2));
console.log('liveCount2:', await g2.liveCount());

redis.disconnect();

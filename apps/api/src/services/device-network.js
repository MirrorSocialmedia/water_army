/**
 * BR-B6 G2 (docs/network-policy.md §10) — the DEDICATED DEVICE NETWORK.
 *
 * Pre-G2: redroid device containers AND their per-device gost egress proxies
 * rode docker's DEFAULT bridge (172.17.0.0/16) via `NetworkMode: 'bridge'` —
 * the same L2 as every other default-bridge container on the host: devices
 * could reach each other and the host's default-bridge gateway with no
 * deliberate policy behind it.
 *
 * Post-G2:
 *   - one explicit user-defined bridge network `water-army-devices`
 *     (subnet 172.38.200.0/24 — clear of docker defaults 172.17/18/16, the
 *     platform network 172.38.100.0/24 and the LAN 192.168.31.0/24),
 *   - every redroid device + its gost container is attached to it
 *     (NetworkingConfig endpoint, no NetworkMode at all),
 *   - the gost host bind = THIS network's gateway (172.38.200.1), so the
 *     in-device tunnel (socks5://<gateway>:<port>) keeps working while the
 *     proxy listener is no longer anchored to the default bridge.
 *
 * The platform services (web/api/worker/postgres/redis) stay on the compose
 * platform network (G1). The ONE deliberate cross-network attachment (F-RDFA-2
 * fix, 2026-10-29): the api container is attached to THIS network at boot
 * (self-attach, idempotent + self-healing — see batch-lifecycle-service.js
 * ensureDeviceNetworkSelfAttachment) so the batch health probe can reach
 * adbd over L2 at the device container's bridge IP:5555. Rationale + exposure
 * analysis in docs/audits/rdfa-fix-report.md. The host-published
 * 127.0.0.1:<adbPort> mapping remains for humans/adb-CLI only — the probe
 * does NOT ride it (the api container's loopback cannot see host publishes).
 * The worker has no docker socket and no network attachment: it stays on
 * the platform network only (threat model T1 unchanged).
 *
 * Existing devices created before G2 remain on their original network until
 * recreated (the network is snapshotted at container create; there is no
 * live L2 migration). Recreated devices land on water-army-devices.
 *
 * Env overrides (deployment tuning, all validated at parse time):
 *   DEVICE_NETWORK_NAME    default 'water-army-devices'
 *   DEVICE_NETWORK_SUBNET  default '172.38.200.0/24' (must be an IPv4 CIDR,
 *                          /16–/29; the gateway is always the first
 *                          usable address — never a free input)
 */

/** Pure IPv4 helpers (no deps — unit-tested directly). */
function parseIpv4(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function toIpv4(nums) {
  return nums.join('.');
}

/** cidrFirstUsable('172.38.200.0/24') → '172.38.200.1' (network+1, always
 *  usable for /30-or-wider… /30's usable set is net+1..net+2, +1 included). */
export function cidrGateway(cidr) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(String(cidr ?? '').trim());
  if (!m) return null;
  const base = parseIpv4(m[1]);
  const prefix = Number(m[2]);
  if (!base || prefix < 16 || prefix > 30) return null; // sanity band for our use
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const netInt = (
    ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0
  ) & mask;
  // network address + 1 (the bridge gateway)
  const gwInt = (netInt + 1) >>> 0;
  return [
    (gwInt >>> 24) & 255,
    (gwInt >>> 16) & 255,
    (gwInt >>> 8) & 255,
    gwInt & 255,
  ].join('.');
}

function envDeviceNetwork(env = process.env) {
  const name = String(env.DEVICE_NETWORK_NAME ?? '').trim() || 'water-army-devices';
  const subnet = String(env.DEVICE_NETWORK_SUBNET ?? '').trim() || '172.38.200.0/24';
  const gateway = cidrGateway(subnet);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`DEVICE_NETWORK_NAME is malformed ('${name}') — must be a docker-safe network name`);
  }
  if (!gateway) {
    throw new Error(`DEVICE_NETWORK_SUBNET is malformed ('${subnet}') — expected an IPv4 CIDR, prefix 16–30`);
  }
  return { name, subnet, gateway };
}

/** Resolved once at import (the network contract must not drift mid-process). */
export const deviceNetwork = envDeviceNetwork(process.env);

/** The docker API create-body for the device network (idempotent via inspect). */
export function deviceNetworkCreateBody() {
  return {
    Name: deviceNetwork.name,
    Driver: 'bridge',
    Internal: false, // devices need egress for the QA/staging endpoints (governed by the B4 policy gate, not L3)
    enableIPv6: false,
    IPAM: { Driver: 'default', Config: [{ Subnet: deviceNetwork.subnet, Gateway: deviceNetwork.gateway }] },
    Options: {},
    Labels: { 'app.managed': 'true', 'app.created-by': 'device-network', 'app.purpose': 'br-b6-g2' },
  };
}

/**
 * The HostConfig/NetworkingConfig pair for a container that must ride the
 * device network. Replaces `NetworkMode: 'bridge'`:
 *   HostConfig:   NetworkMode removed entirely (an explicit endpoint wins),
 *   body-level:   NetworkingConfig.EndpointsConfig[name] = {}
 * Returning a new object (callers' HostConfig may carry PortBindings/Mounts
 * that are preserved untouched).
 */
export function withDeviceNetwork({ hostConfig, body = {} } = {}) {
  const nextHostConfig = { ...(hostConfig ?? {}) };
  delete nextHostConfig.NetworkMode;
  return {
    hostConfig: nextHostConfig,
    body: {
      ...body,
      HostConfig: nextHostConfig,
      NetworkingConfig: { EndpointsConfig: { [deviceNetwork.name]: {} } },
    },
  };
}

/**
 * Idempotently ensure the device network exists. Returns the network name.
 *  - exists  → inspect (also verifies it is the bridge driver we expect;
 *              a colliding foreign network with the same name is REFUSED —
 *              fail closed instead of riding someone else's L2).
 *  - missing → create with the pinned body.
 *  - any other engine error → throw (the caller fails the create closed).
 */
export async function ensureDeviceNetwork(client, { log = { warn() {}, error() {} } } = {}) {
  let existing = null;
  try {
    existing = await client.getNetwork(deviceNetwork.name).inspect();
  } catch (err) {
    const code = err?.statusCode ?? err?.code;
    const msg = String(err?.message ?? err);
    const notFound = code === 404 || /no such network/i.test(msg);
    if (!notFound) throw err; // real engine failure — do not guess
  }
  if (existing) {
    if (existing.Driver !== 'bridge') {
      throw new Error(`network '${deviceNetwork.name}' exists with driver '${existing.Driver}' — refusing to ride a foreign network (fail closed)`);
    }
    // Subnet drift check: if an operator hand-migrated the network to a
    // different subnet, the derived gateway (and every gost bind on it) is
    // stale — refuse rather than half-work.
    const subnets = (existing.IPAM?.Config ?? []).map((c) => c.Subnet);
    if (subnets.length > 0 && !subnets.includes(deviceNetwork.subnet)) {
      log.warn?.({ expected: deviceNetwork.subnet, actual: subnets }, 'device network subnet drift detected — fail closed');
      throw new Error(`network '${deviceNetwork.name}' subnet ${subnets.join(',')} != expected ${deviceNetwork.subnet} — refusing (recreate the network to migrate)`);
    }
    return deviceNetwork.name;
  }
  await client.createNetwork(deviceNetworkCreateBody());
  return deviceNetwork.name;
}

/** The per-device gost host bind — anchored to the DEVICE network gateway.
 *  (Pre-G2 this was the default-bridge IP 172.17.0.1; the constant now
 *  follows the network by construction.) */
export const GOST_HOST_BIND = deviceNetwork.gateway;

/**
 * T102 (BR-Acceptance C3-S2a follow-up) — raw `ip route get` / netns state
 * fixtures for the netcheck table-100 matcher.
 *
 * PROVENANCE (honesty rules, per repo evidence conventions):
 *  - "VERBATIM"  = copied byte-for-byte from a live capture (trailing spaces
 *    included — they are part of the real toybox/iproute2 output).
 *  - "OBSERVED-FRAGMENT + OBSERVED-FORMAT" = the table-annotation fragment is
 *    the verbatim live-observed string; the rest of the line is the same
 *    device's observed single-line toybox format with the observed IP values
 *    (see per-fixture comments). No invented routing semantics — the FIB
 *    behavior (rule 5000 → table 100 first; fall-through when table 100 is
 *    empty) was separately kernel-verified on this host 2026-10-22 in a
 *    scratch docker netns (br-b6t-fx, torn down after capture).
 *
 * Captures:
 *  - R2 live-audit device captures (real redroid device, toybox ip):
 *      docs/audits/r2-evidence/evidence/l2-tun-interface.txt
 *      docs/audits/r2-evidence/evidence/l6e-timeout.txt
 *      docs/audits/r2-evidence/evidence/tunnel-setup-20082.txt (runOut)
 *  - BR-Acceptance C-item egress captures (scratch redroid devices,
 *    sidecar = alpine + iproute2 in the device netns):
 *      /home/kenneth/.openclaw/workspace/logs/br-b6-egress/c3/*.log
 *      /home/kenneth/.openclaw/workspace/logs/br-b6-egress/c4/*.log
 *      /home/kenneth/.openclaw/workspace/logs/br-b6-egress/acceptance.md
 */

// ---------------------------------------------------------------------------
// `ip route get 8.8.8.8` outputs (the input of the matcher under test)
// ---------------------------------------------------------------------------

/**
 * TUNNEL ALIVE — VERBATIM from l2-tun-interface.txt (and byte-identical in
 * l6e-timeout.txt and the tunnel-setup-20082.txt runOut). Real redroid
 * device, toybox ip, tunnel up: rule 5000 → table 100 → the annotation
 * "table 100" is INLINE on the first line (toybox style), followed by the
 * indented "cache" line. Trailing spaces are part of the real output.
 */
export const TUNNEL_ALIVE_ROUTE_GET =
  '8.8.8.8 via 10.8.0.2 dev tun0 table 100 src 10.8.0.1 uid 0 \n' +
  '    cache \n';

/**
 * TUNNEL DEAD, OPEN docker net (per-net table 1002) — the C3-S2a failure
 * shape. OBSERVED-FRAGMENT + OBSERVED-FORMAT: acceptance.md §5.1 records the
 * live-observed line "via 172.39.200.1 dev eth0 **table 1002**" from
 * `ip route get 8.8.8.8` on dev1 with the tunnel dead (the substring
 * "table 100" in it is exactly what the buggy grep matched). The line shape
 * (single-line toybox format, trailing space, "cache" continuation) and the
 * src 172.39.200.3 (dev1's container IP — the same IP canary1 observed as
 * the real DIRECT egress in C3-S2a) follow the observed captures.
 */
export const TUNNEL_DEAD_PERNET_1002_ROUTE_GET =
  '8.8.8.8 via 172.39.200.1 dev eth0 table 1002 src 172.39.200.3 uid 0 \n' +
  '    cache \n';

/**
 * Same shape, Docker per-net table numbers 1000 / 1003 — defensive variants
 * (Docker assigns per-net tables 1000+; 1002 was the one observed live).
 * Pin that the token match generalizes to every 100x sibling.
 */
export const TUNNEL_DEAD_PERNET_1000_ROUTE_GET =
  '8.8.8.8 via 172.19.0.1 dev eth0 table 1000 src 172.19.0.2 uid 0 \n' +
  '    cache \n';

export const TUNNEL_DEAD_PERNET_1003_ROUTE_GET =
  '8.8.8.8 via 172.19.0.1 dev eth0 table 1003 src 172.19.0.2 uid 0 \n' +
  '    cache \n';

/**
 * TUNNEL DEAD, INTERNAL docker net — C4-S2 VERBATIM ground truth: with the
 * per-net table default absent and the 32000 catch-all `unreachable` rule,
 * `ip route get 8.8.8.8` prints "RTNETLINK answers: Network unreachable" on
 * STDERR and nothing on stdout. The netcheck script runs
 * `ip route get 8.8.8.8 2>/dev/null` and captures stdout only → EMPTY.
 */
export const TUNNEL_DEAD_INTERNAL_ROUTE_GET = '';

/**
 * DIRECT via MAIN table, no table annotation at all — C4 CONTROL B VERBATIM
 * (scratch-net device, `ip route get 172.39.202.10` captured during the
 * C-item; destination differs from 8.8.8.8 on purpose — it is the captured
 * evidence line and the matcher does not depend on the destination).
 * Semantics: tunnel dead on a net WITHOUT a per-net table → FIB resolves via
 * the main-table default on eth0 = the §10.9 fail-open shape.
 */
export const DIRECT_MAINTABLE_ROUTE_GET =
  '172.39.202.10 via 172.39.203.1 dev eth0 src 172.39.203.2 uid 0 \n' +
  '    cache \n';

/**
 * MIXED — one output containing BOTH an exact "table 100" token and a
 * "table 1002" token. A single `ip route get` FIB walk returns exactly one
 * resolved route, so this can NOT arise live; it is a defensive pin: the
 * matcher's rule is "exact table-100 token present ⇒ tunnel" and it must be
 * deterministic even on such input (no crash, no 'unknown').
 */
export const MIXED_100_AND_1002_ROUTE_GET =
  '8.8.8.8 via 10.8.0.2 dev tun0 table 100 src 10.8.0.1 uid 0 \n' +
  '    cache \n' +
  '172.17.0.1 via 172.19.0.1 dev eth0 table 1002 src 172.19.0.2 uid 0 \n' +
  '    cache \n';

/**
 * DEFENSIVE (not observed live — honest provenance): the annotation at
 * END-OF-LINE shape. Every live capture we hold (toybox, R2 + C-item) puts
 * "table 1002" / "table 100" mid-line followed by a space. The ERE's $ 
 * branch exists so that a token at EOL can NEVER be missed (grep is 
 * line-based and never sees the line terminator — a whitespace-only guard 
 * would drop this shape). Values: same observed endpoints, EOL position is
 * the defensive variable. Pins: alive → tunnel; dead 1002 → direct.
 */
export const TUNNEL_ALIVE_ROUTE_GET_IPROUTE2 =
  '8.8.8.8 via 10.8.0.2 dev tun0  src 10.8.0.1\n' +
  '    cache \n' +
  '    table 100\n';

/**
 * DEFENSIVE EOL sibling of TUNNEL_DEAD_PERNET_1002_ROUTE_GET — per-net table
 * 1002 with the token at EOL. The legacy substring grep matches this;
 * the exact matcher must not.
 */
export const TUNNEL_DEAD_PERNET_1002_ROUTE_GET_IPROUTE2 =
  '8.8.8.8 via 172.39.200.1 dev eth0  src 172.39.200.3\n' +
  '    cache \n' +
  '    table 1002\n';

// ---------------------------------------------------------------------------
// Companion netns state (the other four inputs of the same script)
// ---------------------------------------------------------------------------

/** `ps -ef` line of a live tun2socks (VERBATIM, tunnel-setup-20082.txt). */
export const PS_TUN2SOCKS_ALIVE =
  'root          2414  2409 0 20:17:59 ?     00:00:00 tun2socks --device tun0 --proxy socks5://172.17.0.1:20082 --loglevel debug\n';

/**
 * Harness C3-S2a artifact (documented, harness-only): after pkill, the
 * zombie [tun2socks] is NOT reaped (harness PID1 = sleep infinity) and the
 * script's `ps -ef | grep [t]un2socks` still matches → process=alive FALSE
 * POSITIVE. Same ps shape as PS_TUN2SOCKS_ALIVE (the script cannot tell a
 * zombie from a live process — that is why iface/route/effective are the
 * load-bearing signals, and why this fixture uses the observed shape).
 */
export const PS_TUN2SOCKS_ZOMBIE_HARNESS = PS_TUN2SOCKS_ALIVE;

/** `ps -ef` with no tun2socks at all (process genuinely dead). */
export const PS_TUN2SOCKS_DEAD = '';

/** `ip link show tun0` — UP (VERBATIM header line, l2-tun-interface.txt). */
export const IP_LINK_TUN0_UP =
  '3: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 500\n' +
  '    link/none \n';

/**
 * `ip link show tun0` — device gone. The real error goes to STDERR
 * ("Device \"tun0\" does not exist.") and the script captures stdout →
 * EMPTY (2>/dev/null).
 */
export const IP_LINK_TUN0_MISSING = '';

/** `ip route show table 100` — tunnel ALIVE (VERBATIM, l2-tun-interface.txt). */
export const TABLE_100_ROUTES_ALIVE =
  'default via 10.8.0.2 dev tun0 onlink \n' +
  '172.17.0.1 dev eth0 scope link \n';

/**
 * `ip route show table 100` — tunnel DEAD: the kernel removes the tun0
 * routes when tun0 is freed (C3-S2a mechanism, kernel-verified) → EMPTY.
 */
export const TABLE_100_ROUTES_DEAD = '';

/**
 * `ip rule show` — VERBATIM from l2-tun-interface.txt (note: TAB after the
 * priority, as captured). Rule 5000 persists after t2s death — exactly what
 * the C3-S2a netcheck showed (rule=present alongside route=missing).
 * The observed Android netd rules (10000–18000) are kept verbatim: none of
 * them contains the substring "5000:", pinning the rule check too.
 */
export const IP_RULES_REAL_DEVICE =
  '0:\tfrom all lookup local \n' +
  '5000:\tfrom all lookup 100 \n' +
  '10000:\tfrom all fwmark 0xc0000/0xd0000 lookup legacy_system \n' +
  '11000:\tfrom all iif lo oif eth0 uidrange 0-0 lookup eth0 \n' +
  '16000:\tfrom all fwmark 0x10063/0x1ffff iif lo lookup local_network \n' +
  '16000:\tfrom all fwmark 0x10064/0x1ffff iif lo lookup eth0 \n' +
  '17000:\tfrom all iif lo oif eth0 lookup eth0 \n' +
  '18000:\tfrom all fwmark 0x0x10000 lookup legacy_system \n' +
  '32766:\tfrom all lookup main \n' +
  '32767:\tfrom all lookup default \n';

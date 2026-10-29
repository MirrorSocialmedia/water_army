/**
 * WA-STEALTH-FIX2 (s2, work-order D/E) — browser launch-argument provisioning.
 *
 * The redroid image ships NO Chrome app — the platform browser surface is the
 * embedded RELEASE WebView (s1 probe: `pm list packages` shows only
 * com.android.webview + webview_shell; docs/audits/stealth-fix2/s1/
 * S1-RESEARCH §3). s1 measured the three known command-line carriers on the
 * live device and ALL of them are inert for a release WebView in this image:
 *   - the `webviewcommandline` property            ✗ (candidates unchanged)
 *   - `/data/local/tmp/webview-command-line` file ✗ (candidates unchanged)
 *   - `settings put global webrtc_ip_handling_policy` ✗ (candidates unchanged)
 * This module therefore provisions all three carriers (cheap, idempotent,
 * zero-boot-risk) so that whichever one the app layer / a future debuggable
 * WebView build honours, the POLICY IS ALREADY SET — and keeps the value
 * product-configurable (env + AppSetting) instead of hardcoded.
 *
 * HONEST SCOPE (do not overclaim): provisioning the carriers does NOT by
 * itself remove the WebRTC host+srflx leak measured in D2-0③ — that needs a
 * working lever (tun topology and/or an app that embeds WebView with its own
 * flags; boss decision at D4). The residual-risk statement ships with the
 * code, not just the Jira.
 */

export const BROWSER_ARGS_MARKER = 'BROWSER_ARGS_OK';

/** Chromium WebRtcIPHandlingPolicy switch values we allow (s1 §3 + work order D). */
export const WEBRTC_IP_POLICIES = Object.freeze([
  'allow_all',
  'disable_udp',
  'disable_non_proxied_udp',
  'default_public_interface_only',
  'default_route_only',
]);

/** Android private-DNS provider authority (a hostname label, not a URL). */
const DNS_RESOLVER_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The file/property value: one switch line. `--` prefix per Chromium convention.
 * @param {{ webrtcPolicy?: string, launchArgs?: string }} opts
 */
export function buildWebviewCommandLine(opts = {}) {
  const policy = String(opts.webrtcPolicy ?? 'default_public_interface_only');
  if (!WEBRTC_IP_POLICIES.includes(policy)) {
    throw new Error(`browser args: unknown WebRTC IP policy: ${policy} (expected one of ${WEBRTC_IP_POLICIES.join('|')})`);
  }
  // launchArgs = operator override for the FULL arg string (config knob); when
  // set it REPLACES the policy switch (the configurable surface the work order asks for).
  const custom = typeof opts.launchArgs === 'string' ? opts.launchArgs.trim() : '';
  if (custom && /[;&|<>`$"'\\\n]/.test(custom)) {
    throw new Error('browser args: launchArgs may only contain flag characters (no shell metacharacters)');
  }
  return custom || `--webrtc-ip-handling-policy=${policy}`;
}

/**
 * DNS resolver localisation (work-order E accessory): Android private DNS
 * (DoH) set to a region-appropriate provider authority. OFF (empty) keeps
 * image default = zero behaviour change. D2 measured plain 8.8.8.8 egress
 * today; real DoH effect is limited from CN (Cloudflare echo unreachable —
 * D2 record), so this is config surface + readback evidence, not a claim.
 */
export function validateDnsResolver(resolver) {
  if (resolver == null || resolver === '') return '';
  const v = String(resolver).trim();
  if (!DNS_RESOLVER_RE.test(v)) throw new Error(`browser args: invalid DNS resolver: ${v}`);
  return v;
}

/**
 * Device-side provisioning script (exec seam, fixed argv — same discipline
 * as the battery builders). Writes all three command-line carriers +
 * optional private DNS, then prints a machine-readable final line:
 *   BROWSER_ARGS_OK args=<value> dns=<resolver|off>
 * @returns {string} sh script ending in the BROWSER_ARGS_OK line
 */
export function buildBrowserArgsProvisionScript(opts = {}) {
  const args = buildWebviewCommandLine(opts);
  const dns = validateDnsResolver(opts.dnsResolver);
  const policy = String(opts.webrtcPolicy ?? 'default_public_interface_only');
  const lines = [
    `printf '%s' '${args}' > /data/local/tmp/webview-command-line`,
    'chmod 644 /data/local/tmp/webview-command-line',
    `setprop webviewcommandline '${args}'`,
    `settings put global webrtc_ip_handling_policy ${policy}`,
  ];
  if (dns) {
    lines.push('settings put global private_dns_mode hostname');
    lines.push(`settings put global private_dns ${dns}`);
  }
  lines.push(`echo ${BROWSER_ARGS_MARKER} args=${args} dns=${dns || 'off'}`);
  return lines.join('; ');
}

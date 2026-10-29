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

/* -----------------------------------------------------------------------
 * WA-RESCAN (S2, 2026-10-30) — Chrome carrier for the WebRTC IP policy.
 *
 * s1 proved the three WebView carriers (prop / file / settings) are inert
 * for the RELEASE WebView (docs/audits/stealth-fix2/s1/S1-RESEARCH §3,
 * docs/audits/stealth-fix2/s2/evidence-s2-live.txt). But the production
 * browser surface is Chrome-for-Android, and Chrome honours a fourth
 * carrier the WebView never did: the `command_line_args` INTENT EXTRA on
 * `am start`. Two device rules come with it (both encoded here):
 *  - the extra is only consumed at process START → force-stop first;
 *  - switches persist for the browser process lifetime (one launch per
 *    policy change is enough; no daemon, no boot risk).
 * This is the "接返 Chrome 邊條" leg of the parameterisation: same policy
 * knob as the WebView provisioning (buildWebviewCommandLine), one more
 * carrier. Real-device ICE before/after lives in docs/audits/rescan/.
 * --------------------------------------------------------------------- */

export const CHROME_LAUNCH_MARKER = 'CHROME_LAUNCH_OK';
export const CHROME_ACTIVITY = 'com.android.chrome/com.google.android.apps.chrome.Main';
export const CHROME_PACKAGE = 'com.android.chrome';

/**
 * Device-side Chrome launch through the exec/adb seam (fixed argv).
 * @param {{ webrtcPolicy?: string, launchArgs?: string, url?: string,
 *           remoteDebugPort?: number }} opts
 * @returns {string} sh script ending in the CHROME_LAUNCH_OK marker
 */
export function buildChromeLaunchScript(opts = {}) {
  const args = buildWebviewCommandLine(opts); // policy validated + override semantics shared
  const port = opts.remoteDebugPort;
  if (port !== undefined && port !== null) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`chrome launch: invalid remoteDebugPort: ${String(port)}`);
    }
  }
  const fullArgs = port ? `${args} --remote-debugging-port=${port}` : args;
  const url = opts.url === undefined || opts.url === '' ? 'about:blank' : String(opts.url);
  if (/[;&|<>`$"'\\\s]/.test(url)) {
    throw new Error(`chrome launch: url may not contain spaces or shell metacharacters: ${url}`);
  }
  return [
    `am force-stop ${CHROME_PACKAGE}`,
    'sleep 1',
    `am start -n ${CHROME_ACTIVITY} -a android.intent.action.VIEW -d '${url}' -e command_line_args '${fullArgs}'`,
    `echo ${CHROME_LAUNCH_MARKER}`,
  ].join('; ');
}

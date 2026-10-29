/**
 * WA-RESCAN (S2, 2026-10-30) unit tests — Chrome `command_line_args`
 * intent-extra carrier for the WebRTC IP policy (the one lever the release
 * WebView never honoured; s1 evidence: all three WebView carriers inert).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChromeLaunchScript, CHROME_LAUNCH_MARKER,
} from '../../packages/shared/src/stealth-browser.js';

describe('RESCAN S2: Chrome launch carrier (command_line_args intent extra)', () => {
  test('default: webrtc policy switch rides the intent extra', () => {
    const s = buildChromeLaunchScript({ url: 'https://browserleaks.com/webrtc' });
    assert.ok(s.includes('am force-stop com.android.chrome'));
    assert.ok(s.includes('-e command_line_args'));
    assert.ok(s.includes('--webrtc-ip-handling-policy=default_public_interface_only'));
    assert.ok(s.includes("am start -n com.android.chrome/com.google.android.apps.chrome.Main"));
    assert.ok(s.includes("-d 'https://browserleaks.com/webrtc'"));
    assert.ok(s.endsWith(`echo ${CHROME_LAUNCH_MARKER}`));
  });
  test('policy is validated (unknown → THROWS, never ships a typo)', () => {
    assert.throws(() => buildChromeLaunchScript({ webrtcPolicy: 'allow_alll' }), /unknown WebRTC IP policy/);
  });
  test('launchArgs override replaces the policy switch (operator knob)', () => {
    const s = buildChromeLaunchScript({ launchArgs: '--webrtc-ip-handling-policy=disable_non_proxied_udp' });
    assert.ok(s.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(!s.includes('default_public_interface_only'));
  });
  test('remoteDebugPort appends the CDP switch when asked', () => {
    const s = buildChromeLaunchScript({ remoteDebugPort: 9222 });
    assert.ok(s.includes('--remote-debugging-port=9222'));
  });
  test('no shell metacharacters smuggled into the args (fixed-argv rule)', () => {
    assert.throws(() => buildChromeLaunchScript({ launchArgs: '--a; rm -rf /' }), /launchArgs may only contain flag characters/);
  });
});

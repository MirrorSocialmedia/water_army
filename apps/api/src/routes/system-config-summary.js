/**
 * WA-UI-SURFACY s4 — GET /api/system/config-summary (READ-ONLY aggregate).
 *
 * The Settings "system configuration overview" card needs five surfaces the
 * UI otherwise cannot reach (工單 WA-UI-SURFACY §3): egress probe address,
 * RAM-gate thresholds, daily registration caps, SMS policy, fingerprint
 * switches. This route projects them in ONE read — pure constants + the
 * ram-gate resolver (no gate/redis dependency, works hermetically).
 *
 * REDACTED BY CONSTRUCTION: no passwords/tokens/proxy URLs/recovery-mailbox
 * addresses cross this surface — the pool is reported as a COUNT only, the
 * egress echo endpoint is a probe target (not a credential), and the ram-gate
 * config is numeric thresholds.
 *
 * RBAC: admin (mirrors /api/system/ram-gate + /api/providers — the sibling
 * config surfaces are all admin-class).
 */
import { RAM_GATE_APP_SETTING_KEY, resolveRamGateConfig } from '@water-army/shared';

export function systemConfigSummaryRoutes(app) {
  app.get('/api/system/config-summary', { preHandler: app.requireRole('admin') }, async () => {
    const c = app.config ?? {};

    // Effective RAM-gate config WITHOUT requiring a constructible gate:
    // operator AppSetting patch + env overrides + defaults (resolver is pure).
    let ramGate = { available: false, config: null, source: 'defaults+env' };
    try {
      let patch = null;
      if (app.db?.appSetting) {
        const row = await app.db.appSetting.findUnique({ where: { key: RAM_GATE_APP_SETTING_KEY } });
        patch = row?.valueJson ?? null;
      }
      const resolved = resolveRamGateConfig(patch, process.env);
      if (resolved.ok) ramGate = { available: true, config: resolved.config, source: patch ? 'app_setting+env' : 'env+defaults' };
      else ramGate = { available: false, errors: resolved.errors };
    } catch {
      /* fail-open on the DISPLAY only — the gate itself stays fail-closed */
    }

    return {
      egress: {
        bindingEnabled: c.egressBindingEnabled === true,
        echoHost: c.egressEchoHost || null,
        echoPort: c.egressEchoPort || null,
        probeTimeoutMs: c.egressProbeTimeoutMs ?? null,
        staleMs: c.egressStaleMs ?? null,
        failThreshold: c.egressFailThreshold ?? null,
        note: 'probe echo endpoint only — per-identity proxy credentials never surface here (ADR-027 zero-credential)',
      },
      ramGate,
      registration: {
        provisionEnabled: c.gmailProvisionEnabled === true,
        perIpDailyCap: c.gmailPerIpDaily ?? null,
        perIdentityDailyCap: c.gmailPerIdentityDaily ?? null,
        minIntervalMs: c.gmailMinIntervalMs ?? null,
        maxIntervalMs: c.gmailMaxIntervalMs ?? null,
        // count only — mailbox addresses stay in the vault (redaction)
        recoveryPoolSize: Array.isArray(c.gmailRecoveryPool) ? c.gmailRecoveryPool.length : 0,
      },
      sms: {
        autoSolveAllowed: false,
        policy: 'SMS / CAPTCHA / TOS / RECOVERY gates always route to the human intervention console (category EXTERNAL_VERIFICATION) — AUTO-SOLVE is a contract violation (ADR-030 §人肉閘)',
        captchaTimeoutMs: c.gmailCaptchaTimeoutMs ?? null,
      },
      fingerprint: {
        roOverridesEnabled: c.redroidRoOverridesEnabled === true,
        stealthEnabled: c.redroidStealthEnabled === true,
        templateProfilesEnabled: c.redroidTemplateProfilesEnabled === true,
        appOpsEnabled: c.waAppOpsEnabled === true,
      },
    };
  });
}

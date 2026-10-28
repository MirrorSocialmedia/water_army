import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { providers as providersSvc, systemConfig, taskDefinitions } from '../services/system';
import { fmtMiB, fmtMs, LONG_TEXT_CLASS } from '../lib/surfacy-ui';

/**
 * Settings — real data only (WA-UI-SURFACY s4):
 *  - identity from /api/auth/me
 *  - AI providers: real /api/providers table (ADMIN; keys masked by design —
 *    publicProvider exposes hasApiKey, never the value)
 *  - 系統配置總覽: GET /api/system/config-summary (admin, read-only, redacted)
 *  - task-definitions: real /api/tasks/definitions list (viewer+; no
 *    enable/disable API exists yet — stated honestly, no fake buttons)
 * Honest degradation retained: 401 → sign-in frame; 403/404 → stated plainly.
 */
export function Settings() {
  const me = useApi(() => api.get('/api/auth/me'));
  const isAdmin = me.data?.user?.role === 'admin';
  const providers = useApi(() => providersSvc.list(), [], { enabled: isAdmin });
  const summary = useApi(() => systemConfig.summary(), [], { enabled: isAdmin });
  const defs = useApi(() => taskDefinitions.list(), []);

  return (
    <div className="stack">
      <h1>Settings</h1>

      <section className="card">
        <h2>Current user</h2>
        <StateFrame
          loading={me.loading}
          error={me.error && me.error.status !== 401 ? me.error : null}
          empty={!me.loading && me.error && me.error.status === 401}
          emptyTitle="Not signed in"
          emptyHint="Your session expired. Sign in again."
        >
          {me.data?.user ? (
            <dl className="kv">
              <dt>Username</dt>
              <dd className={LONG_TEXT_CLASS}>{me.data.user.username}</dd>
              <dt>Role</dt>
              <dd><em className={`role role-${me.data.user.role}`}>{me.data.user.role}</em></dd>
              <dt>User id</dt>
              <dd><code>{me.data.user.id}</code></dd>
            </dl>
          ) : null}
        </StateFrame>
      </section>

      <SystemSummaryCard isAdmin={isAdmin} res={summary} />
      <ProvidersCard isAdmin={isAdmin} res={providers} />

      <section className="card">
        <h2>任務定義 Task definitions</h2>
        <StateFrame loading={defs.loading} error={defs.error} empty={!defs.loading && !defs.error && !(defs.data?.items?.length)} emptyTitle="No task definitions">
          <div className="table-wrap">
            <table className="list-table">
              <thead>
                <tr><th>title</th><th>type</th><th>mode</th><th>provider</th><th>timeout</th><th>attempts</th><th>approval</th></tr>
              </thead>
              <tbody>
                {(defs.data?.items ?? []).map((d) => (
                  <tr key={d.id}>
                    <td className={LONG_TEXT_CLASS}>{d.title}</td>
                    <td className="mono">{d.taskType}</td>
                    <td>{d.mode}</td>
                    <td>{d.provider ?? '—'}{d.provider ? (d.providerEnabled ? '' : ' (disabled)') : ''}</td>
                    <td className="mono">{fmtMs(d.timeoutMs)}</td>
                    <td className="mono">{d.maxAttempts}</td>
                    <td>{d.requiresApproval ? 'required' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateFrame>
        <p className="muted" style={{ marginTop: 6 }}>
          啟用/停用管理：API 目前只提供唯讀列表（POST/PATCH definitions 未實裝）— 誠實呈現，冇假按鈕。
        </p>
      </section>
    </div>
  );
}

/** Real providers table (admin) — masked keys by construction. */
function ProvidersCard({ isAdmin, res }) {
  return (
    <section className="card">
      <h2>AI providers</h2>
      {!isAdmin ? (
        <p className="muted">403 by design — provider management (incl. masked keys) is admin-only.</p>
      ) : (
        <StateFrame
          loading={res.loading}
          error={res.error && res.error.status !== 404 && res.error.status !== 401 ? res.error : null}
          empty={!res.loading && !res.error && !(res.data?.providers?.length)}
          emptyTitle="No providers configured yet"
          emptyHint="Create one via POST /api/providers (secret stays write-only)."
        >
          <div className="table-wrap">
            <table className="list-table">
              <thead>
                <tr><th>name</th><th>base url</th><th>model</th><th>api key</th><th>timeout</th><th>enabled</th></tr>
              </thead>
              <tbody>
                {(res.data?.providers ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.name}</td>
                    <td className={LONG_TEXT_CLASS} title={p.baseUrl}>{p.baseUrl}</td>
                    <td className={LONG_TEXT_CLASS}>{p.modelId ?? '—'}</td>
                    <td className={p.hasApiKey ? 'status-ok' : 'status-degraded'}>{p.hasApiKey ? 'set (masked)' : 'none'}</td>
                    <td className="mono">{p.timeoutMs ? fmtMs(p.timeoutMs) : '—'}</td>
                    <td className={p.isEnabled ? 'status-ok' : 'status-degraded'}>{p.isEnabled ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateFrame>
      )}
      <p className="muted" style={{ marginTop: 6 }}>Keys are masked server-side — the raw value never travels to the browser.</p>
    </section>
  );
}

/** Read-only overview of the five formerly unreachable config surfaces. */
function SystemSummaryCard({ isAdmin, res }) {
  if (!isAdmin) {
    return (
      <section className="card">
        <h2>系統配置總覽 System overview</h2>
        <p className="muted">Admin-only (mirrors the backend RBAC) — your role sees this honest frame.</p>
      </section>
    );
  }
  const s = res.data;
  return (
    <section className="card">
      <h2>系統配置總覽 System overview</h2>
      <StateFrame loading={res.loading} error={res.error} empty={!res.loading && !res.error && !s} emptyTitle="No data">
        {s ? (
          <div className="cards">
            <div className="card">
              <div className="card-head"><strong>出口探測 (W3)</strong></div>
              <dl className="kv">
                <dt>binding enabled</dt><dd className={s.egress.bindingEnabled ? 'status-ok' : 'status-degraded'}>{s.egress.bindingEnabled ? 'yes' : 'no (routes 503)'}</dd>
                <dt>echo endpoint</dt><dd className="mono">{s.egress.echoHost ? `${s.egress.echoHost}:${s.egress.echoPort}` : '未配置 (fail-closed: never VERIFIED)'}</dd>
                <dt>probe timeout</dt><dd className="mono">{fmtMs(s.egress.probeTimeoutMs)}</dd>
                <dt>stale window</dt><dd className="mono">{fmtMs(s.egress.staleMs)}</dd>
                <dt>fail threshold</dt><dd className="mono">{s.egress.failThreshold}</dd>
              </dl>
            </div>
            <div className="card">
              <div className="card-head"><strong>RAM 閘門</strong></div>
              {s.ramGate.available && s.ramGate.config ? (
                <dl className="kv">
                  <dt>enabled</dt><dd className={s.ramGate.config.enabled ? 'status-ok' : 'status-degraded'}>{s.ramGate.config.enabled ? 'yes' : 'no'}</dd>
                  <dt>max parallel</dt><dd className="mono">{s.ramGate.config.maxParallel}</dd>
                  <dt>hard floor</dt><dd className="mono">{fmtMiB(s.ramGate.config.hardFloorMiB)}</dd>
                  <dt>post-boot target</dt><dd className="mono">{fmtMiB(s.ramGate.config.postBootTargetMiB)}</dd>
                  <dt>per-boot budget</dt><dd className="mono">{fmtMiB(s.ramGate.config.perBootBudgetMiB)}</dd>
                  <dt>source</dt><dd className="mono">{s.ramGate.source}</dd>
                </dl>
              ) : (
                <p className="muted">config unresolved (fail-closed defaults in force){s.ramGate.errors ? `: ${s.ramGate.errors.join('; ')}` : ''}</p>
              )}
            </div>
            <div className="card">
              <div className="card-head"><strong>註冊配額 (T5)</strong></div>
              <dl className="kv">
                <dt>provisioning</dt><dd className={s.registration.provisionEnabled ? 'status-ok' : 'status-degraded'}>{s.registration.provisionEnabled ? 'enabled' : 'disabled (503)'}</dd>
                <dt>per-IP daily cap</dt><dd className="mono">{s.registration.perIpDailyCap}</dd>
                <dt>per-identity daily cap</dt><dd className="mono">{s.registration.perIdentityDailyCap}</dd>
                <dt>interval</dt><dd className="mono">{fmtMs(s.registration.minIntervalMs)} – {fmtMs(s.registration.maxIntervalMs)}</dd>
                <dt>recovery pool</dt><dd className="mono">{s.registration.recoveryPoolSize} mailbox(es) (addresses never surfaced)</dd>
              </dl>
            </div>
            <div className="card">
              <div className="card-head"><strong>SMS / 人肉閘政策</strong></div>
              <dl className="kv">
                <dt>auto-solve</dt><dd className="status-degraded">forbidden (contract violation)</dd>
                <dt>captcha timeout</dt><dd className="mono">{fmtMs(s.sms.captchaTimeoutMs)}</dd>
              </dl>
              <p className="muted">{s.sms.policy}</p>
            </div>
            <div className="card">
              <div className="card-head"><strong>指紋 / 開關 (W1/W2)</strong></div>
              <dl className="kv">
                <dt>ro.* injection</dt><dd className={s.fingerprint.roOverridesEnabled ? 'status-ok' : 'status-degraded'}>{s.fingerprint.roOverridesEnabled ? 'on' : 'off'}</dd>
                <dt>W1b template profiles</dt><dd className={s.fingerprint.templateProfilesEnabled ? 'status-ok' : 'status-degraded'}>{s.fingerprint.templateProfilesEnabled ? 'on' : 'off'}</dd>
                <dt>W2 app ops</dt><dd className={s.fingerprint.appOpsEnabled ? 'status-ok' : 'status-degraded'}>{s.fingerprint.appOpsEnabled ? 'on' : 'off'}</dd>
              </dl>
            </div>
          </div>
        ) : null}
      </StateFrame>
    </section>
  );
}

export default Settings;

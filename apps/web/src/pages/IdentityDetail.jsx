import { Fingerprint, ShieldOff, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { identities, purge, identityLogin } from '../services/batches';
import { fingerprints, egress, accountLifecycle, warmState } from '../services/identity-extras';
import { planWarmingDay, hkDateString } from '@water-army/shared/warming-schedule';
import {
  canOperateLifecycle,
  conflictText,
  errorText,
  isSwitchDisabled,
  previewText,
  validateEgressForm,
  validReasonCode,
  LONG_TEXT_CLASS,
} from '../lib/surfacy-ui';
import {
  IDENTITY_PILL,
  RUN_STATUS_PILL,
  BATCH_STATUS_PILL,
  LOGIN_STATE_PILL,
  LOGIN_TRANSITIONS_UI,
  LOGIN_TRANSITION_LABELS,
  ACCOUNT_TRANSITIONS_UI,
  ACCOUNT_STATUS_PILL,
  ACCOUNT_STATE_LABELS,
  pillClass,
  fmtTime,
  fmtDateTime,
  fmtDuration,
  fmtAge,
  shortId,
} from '../lib/batch-ui';

/**
 * Identity Detail (MD §11.3): stable ID, data dir status, recent tasks,
 * recent error, container ID, last health check.
 *
 * Zero-secret contract: the API returns allow-listed, scrubbed + value-
 * masked fields only (MD §12). This page renders exactly those fields and
 * nothing else — no cookie/token/password/network credentials can appear
 * here by construction.
 */
export function IdentityDetail({ identityId, user }) {
  const { data, loading, error, reload } = useApi(() => identities.detail(identityId), [identityId]);
  const [purgeOut, setPurgeOut] = useState(null); // last dry-run / purge result
  const [purgeConfirm, setPurgeConfirm] = useState(''); // must equal the identity id
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeErr, setPurgeErr] = useState(null);
  const isAdmin = user?.role === 'admin';
  const login = useLoginState(identityId);
  // WA-UI-SURFACY (s2): tabbed surface for the formerly headless backend
  // features (W1 fingerprints / W3 egress / T5 account lifecycle). Panels
  // mount lazily (tab switch) — no hidden polling, no fake data.
  const [tab, setTab] = useState('overview');

  async function runPurge(dryRun) {
    setPurgeBusy(true);
    setPurgeErr(null);
    try {
      const out = dryRun ? await purge.dryRun(identityId) : await purge.run(identityId);
      setPurgeOut(out);
      reload();
    } catch (e) {
      setPurgeErr(`${e.code ?? 'ERROR'}: ${e.message}`);
    } finally {
      setPurgeBusy(false);
      if (!dryRun) setPurgeConfirm('');
    }
  }

  if (!loading && error?.status === 404) {
    return (
      <StateFrame
        loading={false}
        error={null}
        empty
        emptyTitle="Identity not found"
        emptyHint={`No identity with id ${shortId(identityId)} on this database.`}
      />
    );
  }

  return (
    <StateFrame loading={loading} error={error} empty={!data} emptyTitle="No data">
      {data ? (
        <div className="stack">
          <div className="detail-head">
            <div>
              <h2>
                <Fingerprint size={18} style={{ verticalAlign: '-3px' }} /> {data.identity.displayName ?? 'Identity'}
              </h2>
              <p className="muted mono">{data.identity.id}</p>
            </div>
            <div className="row-actions">
              {login.state ? (
                <span className={`pill ${pillClass(LOGIN_STATE_PILL, login.state.loginState)}`} title="T2 登入狀態（ADR-029）— 僅人工可寫入">
                  <LogIn size={12} style={{ verticalAlign: '-2px' }} /> {login.state.loginState}
                </span>
              ) : null}
              <span className={`pill ${pillClass(IDENTITY_PILL, data.identity.status)}`}>{data.identity.status}</span>
              <button type="button" className="btn btn-ghost" onClick={reload}>
                Refresh
              </button>
            </div>
          </div>

          <div className="tabs" role="tablist">
            {[
              ['overview', '總覽 Overview'],
              ['fingerprint', '指紋 Fingerprint'],
              ['egress', '出口綁定 Egress'],
              ['account', '帳號生命週期 Account'],
              ['warm', '養號 Warming'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`tab${tab === id ? ' active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'fingerprint' ? <FingerprintPanel identityId={identityId} user={user} /> : null}
          {tab === 'egress' ? <EgressPanel identityId={identityId} user={user} /> : null}
          {tab === 'account' ? <AccountLifecyclePanel identityId={identityId} user={user} /> : null}
          {tab === 'warm' ? <WarmLifecyclePanel identityId={identityId} user={user} /> : null}

          {tab === 'overview' ? (
          <>
          <div className="cards">
            <div className="card">
              <div className="card-head"><strong>Stable identity</strong></div>
              <dl className="kv">
                <dt>stable id</dt>
                <dd className="mono">{data.identity.id}</dd>
                <dt>external ref</dt>
                <dd className="mono">{data.identity.externalRef ?? '—'}</dd>
                <dt>type</dt>
                <dd>{data.identity.identityType ?? '—'}</dd>
                <dt>created</dt>
                <dd>{fmtDateTime(data.identity.createdAt)}</dd>
                <dt>updated</dt>
                <dd>{fmtDateTime(data.identity.updatedAt)}</dd>
              </dl>
            </div>
            <div className="card">
              <div className="card-head"><strong>Data directory</strong></div>
              <dl className="kv">
                <dt>path</dt>
                <dd className="mono" title={data.dataDir.path}>{data.dataDir.path ?? '—'}</dd>
                <dt>exists</dt>
                <dd className={data.dataDir.exists ? 'status-ok' : 'status-degraded'}>{data.dataDir.exists ? 'yes' : 'no'}</dd>
                <dt>last modified</dt>
                <dd>{data.dataDir.lastModifiedAt ? fmtDateTime(data.dataDir.lastModifiedAt) : '—'}</dd>
              </dl>
              <p className="muted">
                One identity = one persistent dir (MD §4.1). The UI never reads dir contents.
              </p>
            </div>
            <div className="card">
              <div className="card-head"><strong>Container</strong></div>
              {data.container ? (
                <dl className="kv">
                  <dt>container</dt>
                  <dd className="mono" title={data.container.id}>{data.container.shortId}</dd>
                  <dt>state</dt>
                  <dd>{data.container.state}</dd>
                </dl>
              ) : (
                <p className="muted">no live container (not started, already reclaimed, or Docker unavailable)</p>
              )}
            </div>
            <div className="card">
              <div className="card-head"><strong>Last health check</strong></div>
              <div className="big-num">{data.lastHealthCheckAt ? fmtAge(data.lastHealthCheckAt) : '—'}</div>
              <p className="muted">{data.lastHealthCheckAt ? fmtDateTime(data.lastHealthCheckAt) : 'no heartbeat recorded'}</p>
            </div>
          </div>

          <LoginStatePanel identityId={identityId} login={login} user={user} />

          {data.lastError ? (
            <div className="state state-error" role="alert">
              <strong>
                Last error{data.lastError.code ? ` — ${data.lastError.code}` : ''}
              </strong>
              <p>{data.lastError.message ?? '(no message)'}</p>
              <p className="muted">
                {data.lastError.at ? fmtDateTime(data.lastError.at) : ''} · run {data.lastError.runId ? shortId(data.lastError.runId) : ''}
              </p>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <strong>Recent tasks</strong>
              <span className="muted">newest first (max 10)</span>
            </div>
            <div className="table-wrap">
              <table className="list-table">
                <thead>
                  <tr>
                    <th>run</th>
                    <th>status</th>
                    <th>attempt</th>
                    <th>queued</th>
                    <th>started</th>
                    <th>finished</th>
                    <th>duration</th>
                    <th>error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentRuns.map((r) => (
                    <tr key={r.id} className={r.errorCode || r.errorMessage ? 'row-error' : ''}>
                      <td className="mono">{shortId(r.id)}</td>
                      <td>
                        <span className={`pill ${pillClass(RUN_STATUS_PILL, r.status)}`}>{r.status}</span>
                      </td>
                      <td>
                        {r.attempt}
                        {r.maxAttempts ? `/${r.maxAttempts}` : ''}
                      </td>
                      <td>{fmtTime(r.queuedAt)}</td>
                      <td>{fmtTime(r.startedAt)}</td>
                      <td>{fmtTime(r.finishedAt)}</td>
                      <td>{fmtDuration(r.durationMs)}</td>
                      <td className="cell-clip" title={r.errorMessage ?? ''}>
                        {r.errorMessage ? (
                          <>
                            <code>{r.errorCode ?? ''}</code> {r.errorMessage}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <strong>Batch memberships</strong>
              <span className="muted">cycle history</span>
            </div>
            {data.memberships.length ? (
              <table className="list-table">
                <thead>
                  <tr>
                    <th>batch</th>
                    <th>name</th>
                    <th>position</th>
                    <th>membership</th>
                    <th>batch status</th>
                    <th>skip reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.memberships.map((m, i) => (
                    <tr key={`${m.batchId}-${i}`}>
                      <td className="mono">
                        {m.batchNo != null ? `#${m.batchNo}` : shortId(m.batchId)}
                      </td>
                      <td className="cell-clip">{m.batchName ?? '—'}</td>
                      <td>{m.position ?? '—'}</td>
                      <td>
                        <span className={`pill ${pillClass(BATCH_STATUS_PILL, m.status)}`}>{m.status}</span>
                      </td>
                      <td>{m.batchStatus ?? '—'}</td>
                      <td className="cell-clip">{m.skipReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">not yet part of any batch</p>
            )}
          </div>

          {data.identity.metadata && Object.keys(data.identity.metadata).length ? (
            <div className="card">
              <div className="card-head"><strong>Metadata</strong><span className="muted">scrubbed — sensitive keys redacted</span></div>
              <pre className="log-view" style={{ maxHeight: 240 }}>{JSON.stringify(data.identity.metadata, null, 2)}</pre>
            </div>
          ) : null}

          {isAdmin ? (
            <PurgePanel
              identityId={identityId}
              dataDir={data.dataDir}
              out={purgeOut}
              confirmText={purgeConfirm}
              onConfirmText={setPurgeConfirm}
              busy={purgeBusy}
              err={purgeErr}
              onDryRun={() => runPurge(true)}
              onPurge={() => runPurge(false)}
            />
          ) : null}
          </>
          ) : null}
        </div>
      ) : null}
    </StateFrame>
  );
}

/**
 * The ONLY data-wipe path (MD Phase 3 item 4 / MD §4.2): admin + human,
 * two-step confirmed, dry-run first (size/files preview, zero side effects),
 * then a typo-proof confirm token (must equal the identity id). Batch
 * completion NEVER auto-purges.
 */
function PurgePanel({ identityId, dataDir, out, confirmText, onConfirmText, busy, err, onDryRun, onPurge }) {
  return (
    <div className="card" role="region" aria-label="Purge identity data">
      <div className="card-head">
        <strong style={{ color: 'var(--danger, #b00020)' }}>
          <ShieldOff size={14} style={{ verticalAlign: '-2px' }} /> Purge identity data (admin)
        </strong>
        <span className="muted">the only wipe path — batch completion never auto-purges (MD §4.2)</span>
      </div>
      <p className="muted">
        Wipes <code className="mono">{dataDir?.path ?? 'the identity data dir'}</code> and removes this identity's containers
        (ownership-gated). Stopped containers are removed; running ones are stopped first. Audited.
      </p>
      {out ? (
        <div className="state">
          <strong>{out.dryRun ? 'Dry-run (nothing changed)' : 'Purge completed'}</strong>
          <pre className="log-view" style={{ maxHeight: 200 }}>{JSON.stringify(out, null, 2)}</pre>
        </div>
      ) : null}
      {err ? <code className="dep-error">{err}</code> : null}
      <div className="row-actions">
        <button type="button" className="btn" disabled={busy} onClick={onDryRun}>
          {busy ? 'Working…' : 'Dry-run (preview size/files)'}
        </button>
        <input
          type="text"
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="type the identity id to enable purge"
          value={confirmText}
          onChange={(e) => onConfirmText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || confirmText.trim() !== identityId}
          onClick={onPurge}
        >
          Purge identity data
        </button>
      </div>
    </div>
  );
}

/**
 * T2 (ADR-029) login-state view state: state + audit loads silently-polling
 * (badge must not flicker), 503 LOGIN_STATE_DISABLED is an honest "not
 * provisioned" frame (pre-migration API), never an error banner.
 */
function useLoginState(identityId) {
  const state = useApi(() => identityLogin.get(identityId), [identityId], { intervalMs: 30000 });
  const audit = useApi(() => identityLogin.audit(identityId, 50), [identityId], { intervalMs: 30000 });
  const disabled = (state.error?.status === 503 && state.error?.code === 'LOGIN_STATE_DISABLED')
    || (audit.error?.status === 503 && audit.error?.code === 'LOGIN_STATE_DISABLED');
  return {
    state,
    audit,
    disabled,
    view: state.data?.login ?? null,
    reload: () => { state.reload(); audit.reload(); },
  };
}

/**
 * Manual login-flow panel (ADR-029): the ONLY way login truth changes is a
 * human operator+ clicking here. Buttons are rendered per the (mirrored)
 * fail-closed matrix; the server remains the authority and 409s anything
 * illegal — a rejected click shows the server's message, it is never swallowed.
 */
function LoginStatePanel({ identityId, login, user }) {
  const [evidence, setEvidence] = useState('');
  const [busyTo, setBusyTo] = useState(null);
  const [err, setErr] = useState(null);
  const canOperate = user?.role === 'operator' || user?.role === 'admin';

  if (login.disabled) {
    return (
      <div className="card" role="region" aria-label="Login state">
        <div className="card-head"><strong>登入狀態 (Login state)</strong></div>
        <p className="muted">Not available on this API build (T2 tables missing — run prisma migrate deploy).</p>
      </div>
    );
  }
  const view = login.view;
  const allowed = view ? LOGIN_TRANSITIONS_UI[view.loginState] ?? [] : [];

  async function doTransition(to) {
    setBusyTo(to);
    setErr(null);
    try {
      await identityLogin.transition(identityId, to, evidence.trim() || undefined);
      setEvidence('');
      login.reload();
    } catch (e) {
      setErr(`${e.code ?? 'ERROR'}: ${e.message}`);
      login.reload(); // the state may have moved under us (another operator) — resync
    } finally {
      setBusyTo(null);
    }
  }

  return (
    <div className="card" role="region" aria-label="Login state">
      <div className="card-head">
        <strong><LogIn size={14} style={{ verticalAlign: '-2px' }} /> 登入狀態 (Login state — ADR-029)</strong>
        <span className="muted">僅人工可寫入 — no probe/worker/AI may assert login truth</span>
      </div>
      {login.state.loading && !view ? (
        <p className="muted">Loading…</p>
      ) : view ? (
        <>
          <dl className="kv">
            <dt>login state</dt>
            <dd><span className={`pill ${pillClass(LOGIN_STATE_PILL, view.loginState)}`}>{view.loginState}</span></dd>
            <dt>since</dt>
            <dd>{view.loginStateSince ? fmtDateTime(view.loginStateSince) : '—'}</dd>
          </dl>
          {canOperate ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row-actions">
                {allowed.map((to) => (
                  <button
                    key={to}
                    type="button"
                    className={`btn ${to === 'CONFIRMED_LOGGED_IN' ? 'btn-ghost' : ''}`}
                    disabled={busyTo !== null}
                    onClick={() => doTransition(to)}
                  >
                    {busyTo === to ? 'Saving…' : LOGIN_TRANSITION_LABELS[to] ?? to}
                  </button>
                ))}
                <input
                  type="text"
                  className="input"
                  style={{ maxWidth: 320 }}
                  placeholder="備註（可選，≤500字；禁 password/token 等凭證字樣）"
                  maxLength={500}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </div>
              {err ? <code className="dep-error">{err}</code> : null}
            </div>
          ) : (
            <p className="muted">Read-only role ({user?.role}). 確認登入／需重新驗證 需要 operator 以上權限。</p>
          )}
        </>
      ) : (
        <p className="muted">Login state unavailable{login.state.error ? ` (${login.state.error.code ?? login.state.error.message})` : ''}.</p>
      )}

      <div className="card-head" style={{ marginTop: 12 }}>
        <strong>審計記錄 (Transition audit)</strong>
        <span className="muted">newest first (max 50)</span>
      </div>
      {login.audit.error && !login.audit.data ? (
        <p className="muted">Audit unavailable ({login.audit.error.code ?? login.audit.error.message}).</p>
      ) : login.audit.data?.items?.length ? (
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>when</th>
                <th>from</th>
                <th>to</th>
                <th>actor</th>
                <th>note</th>
              </tr>
            </thead>
            <tbody>
              {login.audit.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.createdAt)}</td>
                  <td><span className={`pill ${pillClass(LOGIN_STATE_PILL, r.fromState)}`}>{r.fromState}</span></td>
                  <td><span className={`pill ${pillClass(LOGIN_STATE_PILL, r.toState)}`}>{r.toState}</span></td>
                  <td className="mono">{r.actorUserId ? shortId(r.actorUserId) : '—'}</td>
                  <td className="cell-clip" title={r.evidence?.note ?? ''}>{r.evidence?.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">no transitions recorded yet</p>
      )}
    </div>
  );
}


/**
 * WA-UI-SURFACY s2 — W1/W1b fingerprint panel (ADR-025/028).
 * Read = viewer+; ensure (idempotent generate + drift check) + fleet
 * collision audit = admin. Collision 409 renders the server message
 * verbatim (conflictText) — never a white screen, never swallowed.
 */
function FingerprintPanel({ identityId, user }) {
  const isAdmin = user?.role === 'admin';
  const prof = useApi(() => fingerprints.get(identityId), [identityId]);
  const coll = useApi(() => fingerprints.collisions(), [identityId], { enabled: isAdmin });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { kind: 'ok' | 'err', text }

  async function ensure() {
    if (busy) return; // double-click guard (submit-in-flight check)
    setBusy(true);
    setNote(null);
    try {
      await fingerprints.ensure(identityId);
      setNote({ kind: 'ok', text: 'Profile ensured — deterministic regenerate + drift check passed (idempotent).' });
      prof.reload();
      if (isAdmin) coll.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const view = prof.data?.profile ?? null;
  return (
    <div className="stack">
      <div className="card" role="region" aria-label="Fingerprint profile">
        <div className="card-head">
          <strong><Fingerprint size={14} style={{ verticalAlign: '-2px' }} /> 指紋 Profile (W1 — ADR-025)</strong>
          <span className="muted">deterministic from identityId — real-device consumption NOT VERIFIED (V3)</span>
        </div>
        <StateFrame loading={prof.loading} error={prof.error} empty={!prof.loading && !prof.error && !view} emptyTitle="尚無指紋 profile" emptyHint="Generate one with the button below (admin, idempotent).">
          {/* guard required: children JSX evaluates during THIS render even
              though StateFrame may swap in its empty frame — view is null for
              a never-generated profile and used to crash the whole page
              (found by the F1 v2 harness: reading 'schemaVersion' of null) */}
          {view ? (
            <>
              <dl className="kv">
                <dt>schemaVersion</dt><dd className="mono">{view.schemaVersion}</dd>
                <dt>created</dt><dd>{fmtDateTime(view.createdAt)}</dd>
                <dt>updated</dt><dd>{fmtDateTime(view.updatedAt)}</dd>
              </dl>
              <pre className="log-view" style={{ maxHeight: 320 }}>{JSON.stringify(view.profile, null, 2)}</pre>
            </>
          ) : null}
        </StateFrame>
        {note ? <code className={note.kind === 'ok' ? 'status-ok' : 'dep-error'}>{note.text}</code> : null}
        {isAdmin ? (
          <div className="row-actions">
            <button type="button" className="btn" disabled={busy || prof.loading} onClick={ensure}>
              {busy ? 'Working…' : '生成 / 校驗 (ensure — idempotent)'}
            </button>
            <span className="muted">409 collision / drift fails closed server-side — the message is shown, never swallowed.</span>
          </div>
        ) : (
          <p className="muted">Read-only role ({user?.role}) — 生成/校驗 needs admin.</p>
        )}
      </div>

      {isAdmin ? (
        <div className="card" role="region" aria-label="Fleet collision audit">
          <div className="card-head">
            <strong>車隊碰撞審計 (fleet collisions)</strong>
            <span className="muted">pairwise audit across ALL identities (admin)</span>
          </div>
          <StateFrame loading={coll.loading} error={coll.error} empty={!coll.loading && !coll.error && !coll.data} emptyTitle="No audit data">
            {coll.data ? (
              <>
                <p>
                  blocking:{' '}
                  <span className={`pill ${coll.data.blocking ? 'pill-down' : 'pill-up'}`}>
                    {coll.data.blocking ? 'YES — unique-field collision blocks boot' : 'no'}
                  </span>
                </p>
                {coll.data.uniqueFieldCollisions.length ? (
                  <table className="list-table">
                    <thead><tr><th>field</th><th>value</th><th>identities</th></tr></thead>
                    <tbody>
                      {coll.data.uniqueFieldCollisions.map((c, i) => (
                        <tr key={`${c.field}-${i}`} className="row-error">
                          <td className="mono">{c.field}</td>
                          <td className={LONG_TEXT_CLASS} title={String(c.value)}>{previewText(String(c.value), 60)}</td>
                          <td className="mono">{(c.identityIds ?? []).map(shortId).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="muted">no unique-field collisions</p>}
                {coll.data.informationalRepeats.length ? (
                  <p className="muted">
                    informational repeats (non-unique fields):{' '}
                    {coll.data.informationalRepeats.map((c) => `${c.field}×${c.count}`).join(', ') || 'none'}
                  </p>
                ) : null}
              </>
            ) : null}
          </StateFrame>
        </div>
      ) : null}
    </div>
  );
}

/**
 * WA-UI-SURFACY s2 — W3 pinned egress panel (ADR-027). ZERO-CREDENTIAL:
 * the proxy URL is never returned — only expectedEgressIp + hash prefix.
 * Fail-closed 503 EGRESS_BINDING_DISABLED renders an honest switch-off card
 * (same discipline as the login-state 503 frame). PUT changes / DELETE
 * reset bound devices server-side (fail-closed until a fresh probe matches).
 */
function EgressPanel({ identityId, user }) {
  const isAdmin = user?.role === 'admin';
  const bind = useApi(() => egress.get(identityId), [identityId]);
  const disabled = isSwitchDisabled(bind.error, 'EGRESS_BINDING_DISABLED');
  const [form, setForm] = useState({ proxyUrl: '', expectedEgressIp: '' });
  const [formErr, setFormErr] = useState(null);
  const [busy, setBusy] = useState(null); // 'save' | 'delete' | null
  const [note, setNote] = useState(null);

  async function save() {
    if (busy) return; // double-submit guard
    const errs = validateEgressForm(form);
    if (Object.keys(errs).length) {
      setFormErr(Object.values(errs).join(' · '));
      return;
    }
    setBusy('save');
    setNote(null);
    setFormErr(null);
    try {
      await egress.put(identityId, { proxyUrl: form.proxyUrl.trim(), expectedEgressIp: form.expectedEgressIp.trim() });
      setNote({ kind: 'ok', text: '綁定已儲存 — proxyUrl 已加密入庫，永不回顯 (zero-credential)。Bound devices reset to fail-closed until a fresh probe matches.' });
      setForm({ proxyUrl: '', expectedEgressIp: '' });
      bind.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
      bind.reload(); // the state may have moved under us — resync
    } finally {
      setBusy(null);
    }
  }

  async function unbind() {
    if (busy) return;
    setBusy('delete');
    setNote(null);
    try {
      await egress.del(identityId);
      setNote({ kind: 'ok', text: '綁定已移除 — bound devices re-enter fail-closed (UNCHECKED).' });
      bind.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (disabled) {
    return (
      <div className="card" role="region" aria-label="Egress binding">
        <div className="card-head"><strong>出口綁定 (W3 — ADR-027)</strong></div>
        <p className="muted">
          Disabled on this host — <code className="mono">EGRESS_BINDING_DISABLED</code> (503).
          Set WA_W3_EGRESS_BINDING_ENABLED=true after reviewing ADR-027 (real-device matrix NOT VERIFIED).
        </p>
      </div>
    );
  }

  const b = bind.data?.binding ?? null;
  return (
    <div className="card" role="region" aria-label="Egress binding">
      <div className="card-head">
        <strong>出口綁定 (W3 — ADR-027)</strong>
        <span className="muted">pinned proxy + the ONE exit IP — zero-credential surface</span>
      </div>
      <StateFrame
        loading={bind.loading}
        error={bind.error}
        empty={!bind.loading && !bind.error && !b}
        emptyTitle="未有綁定 (no binding)"
        emptyHint={isAdmin ? 'Bind one below. The proxy URL is validated server-side and never echoed back.' : 'Ask an admin to bind the pinned egress for this identity.'}
      >
        {b ? (
          <dl className="kv">
            <dt>expected egress IP</dt><dd className="mono">{b.expectedEgressIp}</dd>
            <dt>proxy fingerprint</dt><dd className="mono" title="truncated hash of the stored proxy URL — credentials never leave the vault">{b.proxyHashShort}</dd>
            <dt>first verified</dt><dd>{b.firstVerifiedAt ? fmtDateTime(b.firstVerifiedAt) : '未驗證 (never)'}</dd>
            <dt>last verified</dt><dd>{b.lastVerifiedAt ? fmtDateTime(b.lastVerifiedAt) : '未驗證 (never)'}</dd>
            <dt>bound devices</dt><dd className="mono">{b.boundDevices}</dd>
            <dt>updated</dt><dd>{fmtDateTime(b.updatedAt)}</dd>
          </dl>
        ) : null}
      </StateFrame>
      {note ? <code className={note.kind === 'ok' ? 'status-ok' : 'dep-error'}>{note.text}</code> : null}
      {formErr ? <code className="dep-error">{formErr}</code> : null}
      {isAdmin ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row-actions">
            <input
              type="text"
              className="input"
              style={{ maxWidth: 360 }}
              placeholder="proxyUrl — socks5://[user:pass@]host:port"
              value={form.proxyUrl}
              onChange={(e) => setForm((f) => ({ ...f, proxyUrl: e.target.value }))}
            />
            <input
              type="text"
              className="input"
              style={{ maxWidth: 200 }}
              placeholder="expectedEgressIp"
              value={form.expectedEgressIp}
              onChange={(e) => setForm((f) => ({ ...f, expectedEgressIp: e.target.value }))}
            />
            <button type="button" className="btn" disabled={busy !== null || bind.loading} onClick={save}>
              {busy === 'save' ? 'Saving…' : b ? '更新綁定 (PUT — idempotent)' : '綁定 (bind)'}
            </button>
            {b ? (
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={unbind}>
                {busy === 'delete' ? 'Removing…' : '解除綁定'}
              </button>
            ) : null}
          </div>
          <p className="muted">
            The exit IP is fleet-unique — binding an IP another identity holds 409s with the server message shown above.
            A saved change resets every bound device until a fresh probe matches.
          </p>
        </div>
      ) : (
        <p className="muted">Read-only role ({user?.role}) — 綁定/解綁 needs admin.</p>
      )}
    </div>
  );
}

/**
 * WA-UI-SURFACY s2 — T5 account-lifecycle panel (ADR-030).
 * Read (state + masked vault + audit) = viewer+; manual transition + driver
 * provision touch = operator+. Buttons follow the mirrored transition
 * matrix (server stays the authority, 409s anything illegal). Vault shows
 * masked emails + hasPassword only — zero secrets cross this surface.
 */
function AccountLifecyclePanel({ identityId, user }) {
  const canOp = canOperateLifecycle(user?.role);
  const acct = useApi(() => accountLifecycle.get(identityId), [identityId]);
  const audit = useApi(() => accountLifecycle.audit(identityId, 50), [identityId]);
  const disabled = isSwitchDisabled(acct.error, 'ACCOUNT_LIFECYCLE_DISABLED')
    || isSwitchDisabled(audit.error, 'ACCOUNT_LIFECYCLE_DISABLED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null); // state name | 'provision' | null
  const [note, setNote] = useState(null);

  async function transition(to) {
    if (busy) return; // double-submit guard
    if (!validReasonCode(reason.trim())) {
      setNote({ kind: 'err', text: 'reasonCode must match ^[A-Z0-9_]{2,60}$ (or stay empty)' });
      return;
    }
    setBusy(to);
    setNote(null);
    try {
      await accountLifecycle.transition(identityId, to, reason.trim() || undefined);
      setNote({ kind: 'ok', text: `已轉至 ${to}（已審計）。` });
      setReason('');
      acct.reload();
      audit.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
      acct.reload(); // matrix may have moved under us — resync
    } finally {
      setBusy(null);
    }
  }

  async function provision() {
    if (busy) return;
    setBusy('provision');
    setNote(null);
    try {
      const res = await accountLifecycle.provision(identityId);
      setNote({ kind: 'ok', text: `Driver touch done: ${JSON.stringify(res?.state ?? res?.state ?? res)}`.slice(0, 200) });
      acct.reload();
      audit.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (disabled) {
    return (
      <div className="card" role="region" aria-label="Account lifecycle">
        <div className="card-head"><strong>帳號生命週期 (T5 — ADR-030)</strong></div>
        <p className="muted">
          Not available on this API build — <code className="mono">ACCOUNT_LIFECYCLE_DISABLED</code> (503):
          the account_lifecycles / gmail_accounts tables are missing (run prisma migrate deploy).
        </p>
      </div>
    );
  }

  const account = acct.data?.account ?? null;
  const vault = acct.data?.vault ?? null;
  const allowed = account ? ACCOUNT_TRANSITIONS_UI[account.state] ?? [] : [];

  return (
    <div className="stack">
      <div className="card" role="region" aria-label="Account lifecycle state">
        <div className="card-head">
          <strong>帳號生命週期 (T5 — ADR-030)</strong>
          <span className="muted">system-writable by the driver, operator-overridable here</span>
        </div>
        <StateFrame loading={acct.loading} error={acct.error} empty={!acct.loading && !acct.error && !account} emptyTitle="No lifecycle state">
          {/* guard required — see FingerprintPanel note: children evaluate eagerly
              and account is null for a never-provisioned identity (found by the
              F1 v2 harness: reading 'state' of null crashed the page) */}
          {account ? (
            <dl className="kv">
              <dt>state</dt>
              <dd>
                <span className={`pill ${pillClass(ACCOUNT_STATUS_PILL, account.state)}`}>
                  {account.state} · {ACCOUNT_STATE_LABELS[account.state] ?? ''}
                </span>
              </dd>
              <dt>since</dt><dd>{account.stateSince ? fmtDateTime(account.stateSince) : '—'}</dd>
              <dt>current step</dt><dd className="mono">{account.currentStep ?? '—'}</dd>
              <dt>awaiting deadline</dt><dd>{account.awaitingDeadlineAt ? fmtDateTime(account.awaitingDeadlineAt) : '—'}</dd>
              <dt>intervention</dt><dd className="mono">{account.interventionId ? shortId(account.interventionId) : '—'}</dd>
              <dt>failure code</dt><dd className="mono">{account.failureCode ?? '—'}</dd>
            </dl>
          ) : null}
        </StateFrame>
        <div className="card-head" style={{ marginTop: 10 }}>
          <strong>憑證庫 (vault — masked)</strong>
          <span className="muted">zero-secret projection: masked emails + hasPassword only</span>
        </div>
        {vault ? (
          <dl className="kv">
            <dt>email</dt><dd className={LONG_TEXT_CLASS}>{vault.emailMasked ?? '—'}</dd>
            <dt>password stored</dt><dd className={vault.hasPassword ? 'status-ok' : 'status-degraded'}>{vault.hasPassword ? 'yes (encrypted)' : 'no'}</dd>
            <dt>recovery email</dt><dd className={LONG_TEXT_CLASS}>{vault.recoveryEmailMasked ?? '—'}</dd>
            <dt>created</dt><dd>{fmtDateTime(vault.createdAt)}</dd>
          </dl>
        ) : <p className="muted">no vault row for this identity</p>}
        {canOp ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row-actions">
              {allowed.map((to) => (
                <button key={to} type="button" className="btn" disabled={busy !== null} onClick={() => transition(to)}>
                  {busy === to ? 'Saving…' : `→ ${to}（${ACCOUNT_STATE_LABELS[to] ?? ''}）`}
                </button>
              ))}
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={provision}>
                {busy === 'provision' ? 'Driving…' : 'Driver provision touch'}
              </button>
              <input
                type="text"
                className="input"
                style={{ maxWidth: 260 }}
                placeholder="reasonCode（可選，^[A-Z0-9_]{2,60}$）"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {note ? <code className={note.kind === 'ok' ? 'status-ok' : 'dep-error'}>{note.text}</code> : null}
            <p className="muted">
              非法轉換 server 409 fail-closed（矩陣鏡像只驅動按鈕顯示）；driver touch 需 Gmail provisioning 開啟，否則誠實 503。
            </p>
          </div>
        ) : (
          <p className="muted">Read-only role ({user?.role}) — 手動轉換 / provision needs operator+。</p>
        )}
      </div>

      <div className="card" role="region" aria-label="Lifecycle audit">
        <div className="card-head">
          <strong>轉換審計 (transition audit)</strong>
          <span className="muted">newest first (max 50)</span>
        </div>
        {audit.error && !audit.data ? (
          <p className="muted">Audit unavailable ({audit.error.code ?? audit.error.message}).</p>
        ) : audit.data?.items?.length ? (
          <div className="table-wrap">
            <table className="list-table">
              <thead>
                <tr><th>when</th><th>from</th><th>to</th><th>actor</th><th>reason</th></tr>
              </thead>
              <tbody>
                {audit.data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td><span className={`pill ${pillClass(ACCOUNT_STATUS_PILL, r.fromState)}`}>{r.fromState}</span></td>
                    <td><span className={`pill ${pillClass(ACCOUNT_STATUS_PILL, r.toState)}`}>{r.toState}</span></td>
                    <td className="mono">{r.actorKind === 'human' ? (r.actorUserId ? shortId(r.actorUserId) : '—') : `system:${r.actorKind}`}</td>
                    <td className={LONG_TEXT_CLASS}>{r.reasonCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">no transitions recorded yet</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- WA-WARMING ---
const WARM_STATE_PILL = { cold: 'pill-down', warming: 'pill-disabled', warm: 'pill-up' };
const WARM_STATE_LABELS = { cold: '未養號', warming: '養號中', warm: '已養好' };
const WARM_SESSION_STATUS_PILL = { due: 'pill-up', future: 'pill-disabled', missed: 'pill-down' };

function WarmLifecyclePanel({ identityId, user }) {
  const canOp = canOperateLifecycle(user?.role);
  const isAdmin = user?.role === 'admin';
  const warm = useApi(() => warmState.get(identityId), [identityId]);
  const disabled = isSwitchDisabled(warm.error, 'WARM_STATE_DISABLED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  async function act(name, fn) {
    if (busy) return; // double-submit guard
    setBusy(name);
    setNote(null);
    try {
      await fn();
      setNote({ kind: 'ok', text: `已執行 ${name}（已審計）。` });
      setReason('');
      warm.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
      warm.reload(); // state may have moved under us — resync
    } finally {
      setBusy(null);
    }
  }

  if (disabled) {
    return (
      <div className="card" role="region" aria-label="Warm state">
        <div className="card-head"><strong>養號狀態 (WA-WARMING)</strong></div>
        <p className="muted">
          Not available on this API build — <code className="mono">WARM_STATE_DISABLED</code> (503):
          the identities.warm_state columns are missing (run prisma migrate deploy).
        </p>
      </div>
    );
  }

  const w = warm.data?.warm ?? null;
  // Today's deterministic plan (client-side mirror of the scheduler — same
  // seed, zero API cost). DEFAULT window only: AppSetting warm.schedule can
  // move the real dispatch window (the plan card says so honestly).
  const now = new Date();
  const dayPlan = w && w.storedState === 'warming' ? planWarmingDay({ identityId, date: hkDateString(now), now }) : null;

  return (
    <div className="stack">
      <div className="card" role="region" aria-label="Warm state">
        <div className="card-head">
          <strong>養號狀態 (WA-WARMING — Google/FB 防封門檻)</strong>
          <span className="muted">cold → warming → warm；非 warm 身份業務派發會被閘 409</span>
        </div>
        <StateFrame loading={warm.loading} error={warm.error} empty={!warm.loading && !warm.error && !w} emptyTitle="No warm state">
          {w ? (
            <>
              <dl className="kv">
                <dt>state</dt>
                <dd>
                  <span className={`pill ${pillClass(WARM_STATE_PILL, w.effectiveState)}`}>
                    {w.effectiveState} · {WARM_STATE_LABELS[w.effectiveState] ?? ''}
                  </span>
                  {w.storedState !== w.effectiveState ? (
                    <span className="muted"> (stored: {w.storedState} — 已屆滿，下次讀取/派發時自動升級)</span>
                  ) : null}
                </dd>
                <dt>threshold</dt>
                <dd>{w.thresholdDays} 天（AppSetting 可調，逐帳號可覆蓋）</dd>
                <dt>clock start</dt><dd>{w.startedAt ? fmtDateTime(w.startedAt) : '—（未開始養號）'}</dd>
                <dt>ready at</dt><dd>{w.readyAt ? fmtDateTime(w.readyAt) : '—'}</dd>
                {w.effectiveState === 'warming' ? (
                  <>
                    <dt>progress</dt>
                    <dd>
                      <div style={{ height: 6, background: 'var(--border)', borderRadius: 4, maxWidth: 320 }}>
                        <div style={{ height: 6, width: `${w.progressPct}%`, background: 'var(--warn)', borderRadius: 4 }} />
                      </div>
                      <span className="muted">{w.elapsedDays} / {w.thresholdDays} 天 — 剩返 {w.daysRemaining} 日</span>
                    </dd>
                  </>
                ) : null}
              </dl>
              <div className="row-actions" style={{ marginTop: 10 }}>
                {canOp && w.storedState === 'cold' ? (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => act('start', () => warmState.start(identityId))}>
                    {busy === 'start' ? 'Saving…' : '→ warming（開始養號，時鐘由這一刻起）'}
                  </button>
                ) : null}
                {canOp && w.storedState === 'warming' ? (
                  <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => act('reset', () => warmState.reset(identityId))}>
                    {busy === 'reset' ? 'Saving…' : '→ cold（重設時鐘）'}
                  </button>
                ) : null}
                {isAdmin ? (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="input"
                      placeholder="force reason（必要，入審計）"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      style={{ width: 240 }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null || reason.trim().length < 3}
                      onClick={() => act('force', () => warmState.force(identityId, reason.trim()))}
                    >
                      {busy === 'force' ? 'Saving…' : '→ warm（admin 越權）'}
                    </button>
                  </span>
                ) : null}
              </div>
              {note ? <p className={note.kind === 'ok' ? 'status-ok' : 'status-degraded'}>{note.text}</p> : null}
            </>
          ) : null}
        </StateFrame>
      </div>

      {dayPlan ? (
        <div className="card" role="region" aria-label="Today warming plan">
          <div className="card-head">
            <strong>今日養號計劃（{dayPlan.date}，預設視窗 09–21 HKT）</strong>
            <span className="muted">deterministic mirror of the scheduler — 實際派發受 warm.schedule AppSetting 調整</span>
          </div>
          {dayPlan.sessions.length ? (
            <div className="table-wrap">
              <table className="list-table">
                <thead>
                  <tr><th>HK 時間</th><th>模板</th><th>min</th><th>狀態</th><th>seeded query</th></tr>
                </thead>
                <tbody>
                  {dayPlan.sessions.map((s) => (
                    <tr key={s.idempotencyKey}>
                      <td className="mono">{new Date(s.startAt).toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit' })}</td>
                      <td>{s.templateLabel} ({s.template})</td>
                      <td>{s.durationMinutes}</td>
                      <td><span className={`pill ${pillClass(WARM_SESSION_STATUS_PILL, s.status)}`}>{s.status}</span></td>
                      <td className={LONG_TEXT_CLASS}>{s.query ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">今日無 session（視窗/配額）</p>}
        </div>
      ) : null}
    </div>
  );
}

export default IdentityDetail;

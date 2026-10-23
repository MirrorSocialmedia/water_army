import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { navigate } from '../router';
import { StreamClient, STATE_TEXT } from '../lib/stream-client';

/**
 * Mobile Console — single-device screen (MD §3.2/§3.3, Phase 2).
 *
 *  - real-time video (screencap degraded by default on the pinned image;
 *    H.264 path implemented — ADR-019 §19.9/§19.12)
 *  - mouse tap/swipe → touch mapping (normalized coords → device px, the
 *    sidecar does the final scaling to the LIVE display size)
 *  - labelled system keys (MD §3.3): Back / Home / Recents / Enter / Esc
 *  - text input (sent to the device; never retained here — MD §3.3)
 *  - close/release (idempotent DELETE, MD §15)
 *  - MD §12 state machine rendered as TEXT (not just colour)
 *  - tile info: name / state / source / resolution / fps / latency /
 *    controller / last-frame time (MD §3.2)
 *
 * Read-only (viewer) sessions can watch but every input is refused — both
 * in the UI and at the sidecar protocol layer (defense in depth, MD §15.2).
 */

const KEY_BAR = [
  { name: 'BACK', label: '← Back' },
  { name: 'HOME', label: '⌂ Home' },
  { name: 'RECENTS', label: '☰ Recents' },
  { name: 'ENTER', label: '⏎ Enter' },
  { name: 'ESCAPE', label: 'Esc' },
];

function fmtLatency(stats) {
  if (!stats.lastFrameAt) return '—';
  const age = Date.now() - stats.lastFrameAt;
  if (age < 1000) return '<1s';
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`;
  return 'stalled';
}

export function DeviceConsole({ deviceId }) {
  const me = useApi(() => api.get('/api/auth/me'));
  const detail = useApi(() => api.get(`/api/devices/redroid/${encodeURIComponent(deviceId)}`), [deviceId]);
  const [state, setState] = useState('CONNECTING');
  const [info, setInfo] = useState({});
  const [stats, setStats] = useState({ frames: 0, source: null, codec: null, width: null, height: null, lastFrameAt: null, degraded: false, degradeReason: null });
  const [inputFeedback, setInputFeedback] = useState(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState(() => (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mode') === 'viewer' ? 'viewer' : 'controller'));
  const canvasRef = useRef(null);
  const clientRef = useRef(null);
  const dragRef = useRef(null);
  const tickRef = useRef(0);

  const device = detail.data?.device ?? detail.data;
  const canControl = ['admin', 'operator'].includes(me.data?.user?.role);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const client = new StreamClient({
      deviceId,
      mode,
      canvas: canvasRef.current,
      onState: (s, i) => { setState(s); setInfo(i ?? {}); },
      onMeta: (m) => setStats(m),
      onInputResult: (r) => setInputFeedback(r),
    });
    clientRef.current = client;
    client.start().catch(() => {});
    return () => {
      clientRef.current = null;
      client.close().catch(() => {});
    };
    // mode is a one-shot at mount (changing it = re-open the console)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // 1s UI tick for "last frame Xs ago" (MD §3.2 tile info)
  useEffect(() => {
    const t = setInterval(() => { tickRef.current += 1; setStats((s) => ({ ...s })); }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!inputFeedback) return undefined;
    const t = setTimeout(() => setInputFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [inputFeedback]);

  // ---- pointer → touch (MD §3.3 滑鼠點擊、滑鼠拖曳滑動) ------------------------
  function canvasPoint(e) {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function onPointerDown(e) {
    e.preventDefault();
    if (clientRef.current?.mode !== 'controller') return;
    canvasRef.current.setPointerCapture?.(e.pointerId);
    const p = canvasPoint(e);
    dragRef.current = { x0: p.x, y0: p.y };
  }
  function onPointerUp(e) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const p = canvasPoint(e);
    const dist = Math.hypot(p.x - drag.x0, p.y - drag.y0);
    if (dist > 0.05) {
      clientRef.current?.input({ kind: 'swipe', x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y });
    } else {
      clientRef.current?.input({ kind: 'tap', x0: p.x, y0: p.y });
    }
  }

  const stateText = STATE_TEXT[state] ?? state;
  const running = device?.containerState === 'running';
  const readOnly = mode === 'viewer' || !canControl;

  if (detail.loading) return <div className="stack"><h1>Mobile Console</h1><p className="muted">載入裝置…</p></div>;
  if (detail.error || !device) return (
    <div className="stack">
      <h1>Mobile Console</h1>
      <div className="error-box">裝置載入失敗：{detail.error?.message ?? 'not found'}</div>
      <button type="button" onClick={() => navigate('/devices')}>返回裝置清單</button>
    </div>
  );

  return (
    <div className="stack">
      <div className="card-head">
        <h1>{device.name} — Mobile Console</h1>
        <span className={`pill state-badge ${running ? 'state-running' : 'state-stopped'}`}>{device.containerState}</span>
      </div>

      {/* MD §12: the state is TEXT, not just colour */}
      <div className={`card stream-banner stream-${state.toLowerCase()}`}>
        <strong>{stateText}</strong>
        {/* ADR-020 req 6: current video mode + degrade reason (always visible) */}
        {stats.source ? (
          <span className="muted mono">
            · 串流模式：{stats.source === 'scrcpy' ? 'scrcpy H.264' : 'screencap PNG'}{stats.degraded ? `（降級 — ${stats.degradeReason ?? '原因未知'}）` : ''}
          </span>
        ) : null}
        {info?.error ? <span className="muted"> — {info.error.message ?? String(info.error)}</span> : null}
        {info?.note ? <span className="muted"> — {info.note}</span> : null}
        {!running && state === 'ERROR' ? <span className="muted">（裝置未在運行）</span> : null}
      </div>

      <div className="cards">
        {/* video tile (MD §3.2: 延遲/最後幀時間/控制器/介入狀態) */}
        <div className="card console-tile">
          <div className="card-head">
            <h3>畫面</h3>
            <span className="muted mono">
              {stats.source ? `${stats.source === 'scrcpy' ? (stats.codec ?? 'h264') : 'screencap-png'} · ${stats.width ?? '?'}x${stats.height ?? '?'}` : '—'}
            </span>
          </div>
          <div className="console-stage">
            <canvas
              ref={canvasRef}
              className="console-canvas"
              width={720}
              height={1280}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              style={{ touchAction: 'none', cursor: readOnly ? 'default' : 'crosshair' }}
            />
          </div>
          <dl className="kv">
            <dt>控制器</dt><dd>{mode === 'controller' ? '你（controller lease）' : '唯讀（viewer lease）'}</dd>
            <dt>幀</dt><dd>{stats.frames ?? 0} 帧{stats.lastFrameAt ? ` · 最後幀 ${fmtLatency(stats)}` : ''}</dd>
            <dt>串流模式</dt><dd>{stats.source === 'scrcpy' ? 'scrcpy H.264' : stats.source === 'screencap' ? (stats.degraded ? `screencap（降級：${stats.degradeReason ?? '原因未知'}）` : 'screencap（預設 — ADR-020）') : '未就緒'}</dd>
          </dl>
        </div>

        {/* control tile */}
        <div className="card">
          <div className="card-head"><h3>控制</h3></div>
          <div className="stack">
            {readOnly ? (
              <p className="muted">唯讀模式：可以觀看，輸入會被系統拒絕（MD §15.2）。若你是 operator/admin，離開後以控制模式重開。</p>
            ) : (
              <>
                <div className="keybar">
                  {KEY_BAR.map((k) => (
                    <button
                      key={k.name}
                      type="button"
                      className="keybtn"
                      onClick={() => clientRef.current?.input({ kind: 'key', name: k.name })}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
                <label className="muted">
                  文字輸入（只送裝置，不留存/不記 log — MD §3.3）
                  <input
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="輸入文字…"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (!text) return;
                    clientRef.current?.input({ kind: 'text', text });
                    setText('');
                  }}
                >
                  送出文字
                </button>
              </>
            )}
            {inputFeedback ? (
              <div className={inputFeedback.ok ? 'pf-ok' : 'pf-bad'}>
                {inputFeedback.ok ? inputFeedback.note : `${inputFeedback.code ?? 'INPUT_REJECTED'} — ${inputFeedback.message ?? ''}`}
              </div>
            ) : null}
            <button
              type="button"
              className="danger"
              onClick={() => clientRef.current?.close().then(() => navigate(`/devices/${encodeURIComponent(deviceId)}`))}
            >
              關閉並釋放串流
            </button>
            <button type="button" onClick={() => navigate(`/devices/${encodeURIComponent(deviceId)}`)}>返回裝置詳情</button>
          </div>
        </div>
      </div>

      {!running ? (
        <div className="error-box">裝置未運行（{device.containerState}）— 先啟動裝置才能串流（MD §3.2 降級/未就緒行為）。</div>
      ) : null}
      {state === 'CAPACITY_REACHED' ? (
        <div className="error-box">{STATE_TEXT.CAPACITY_REACHED}。串流上限為 5 路（MD §4.1）。</div>
      ) : null}
    </div>
  );
}

export default DeviceConsole;

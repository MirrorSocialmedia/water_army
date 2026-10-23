import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StreamClient, STATE_TEXT } from '../lib/stream-client';
import {
  fleetColumns,
  slotText,
  canOpenTile,
  tileModeFor,
  sourceLabel,
  lastFrameLabel,
} from '../lib/fleet-ui';

/**
 * P3 Fleet Console — 1–5 simultaneous device streams (MD §14 Phase 3).
 *
 *  - layout 1–5 (auto columns: 1 / 2 / 3 / 2×2 / 3+2)
 *  - global slot count (n/5, polled from GET /api/device-streams)
 *  - lazy start: a stream starts ONLY when its tile is opened (MD §4.2);
 *    closing the tile releases the slot immediately
 *  - single-tile close + close-all (MD §14 Phase 3)
 *  - 6th tile is safely refused: local pre-check disables the chip at 5/5
 *    AND the server stays authoritative (409 STREAM_CAPACITY_REACHED /
 *    STREAM_DEVICE_HELD renders as the tile/chip error state)
 *  - layout switching does NOT rebuild streams: tiles are keyed by deviceId
 *    and each keeps its own StreamClient across re-renders/re-layouts
 *    (MD §15.3)
 *  - per-device isolation: each tile is an independent client — one device
 *    dying never touches the others (MD §15.4)
 *
 * Read-only viewers get viewer leases on every tile (MD §15.2).
 */

const EMPTY_STATS = {
  frames: 0,
  source: null,
  codec: null,
  width: null,
  height: null,
  lastFrameAt: null,
  degraded: false,
  degradeReason: null,
  inputSent: 0,
  inputRejected: 0,
};

// Compact per-tile system keys (MD §3.3) — full bar lives in the single
// device console; the fleet tile keeps the three high-value keys.
const TINY_KEYS = [
  { name: 'BACK', label: '← Back' },
  { name: 'HOME', label: '⌂ Home' },
  { name: 'RECENTS', label: '☰ Recents' },
];

function FleetTile({ device, mode, onClosed }) {
  const canvasRef = useRef(null);
  const clientRef = useRef(null);
  const prevFramesRef = useRef(0);
  const [state, setState] = useState('CONNECTING');
  const [info, setInfo] = useState({});
  const [stats, setStats] = useState(EMPTY_STATS);
  const [fps, setFps] = useState(0);
  const [inputFeedback, setInputFeedback] = useState(null);
  const dragRef = useRef(null);

  // P2 mount-race lesson: start only once the canvas is attached; the
  // once-guard prevents a duplicate client on re-renders.
  useEffect(() => {
    if (!canvasRef.current || clientRef.current) return undefined;
    const client = new StreamClient({
      deviceId: device.id,
      mode,
      canvas: canvasRef.current,
      onState: (s, i) => { setState(s); setInfo(i ?? {}); },
      onMeta: (m) => setStats(m),
      onInputResult: (r) => setInputFeedback(r),
    });
    clientRef.current = client;
    // TEMP DIAG (P3 2026-10-23): screenshot-vs-CSV frame-count discrepancy —
    // expose live clients for ground-truth comparison. Remove after diagnosis.
    window.__mcFleetClients = window.__mcFleetClients || [];
    window.__mcFleetClients.push({ name: device.name, client });
    client.start().catch(() => {});
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  // unmount = tile closed = lease released (MD §4.2 "關閉 tile 即停影像
  // 輸出並釋放 slot") — idempotent close, double-close is safe.
  useEffect(() => () => {
    clientRef.current?.close().catch(() => {});
    clientRef.current = null;
  }, []);

  // 1s tick: fps from frame delta + re-render "last frame Xs ago" (MD §3.2).
  useEffect(() => {
    const t = setInterval(() => {
      const f = clientRef.current?.stats?.frames ?? 0;
      setFps(Math.max(0, f - prevFramesRef.current));
      prevFramesRef.current = f;
      setStats((s) => ({ ...s }));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!inputFeedback) return undefined;
    const t = setTimeout(() => setInputFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [inputFeedback]);

  // pointer → tap/swipe (MD §3.3), controller tiles only (read-only viewers
  // are refused in the UI AND at the sidecar protocol layer, MD §15.2).
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
    if (mode !== 'controller') return;
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
    if (dist > 0.05) clientRef.current?.input({ kind: 'swipe', x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y });
    else clientRef.current?.input({ kind: 'tap', x0: p.x, y0: p.y });
  }

  const stateText = STATE_TEXT[state] ?? state;
  const live = state.startsWith('LIVE');

  return (
    <div className={`card fleet-tile stream-${state.toLowerCase()}`}>
      <div className="card-head fleet-head">
        <h3 title={device.id}>{device.name}</h3>
        <span className={`pill state-badge ${live ? 'state-running' : 'state-stopped'}`}>{stateText}</span>
        <button
          type="button"
          className="danger fleet-close"
          title="Close this tile and release its stream slot"
          onClick={() => onClosed(device.id)}
        >
          關閉
        </button>
      </div>

      <div className="console-stage fleet-stage">
        <canvas
          ref={canvasRef}
          className="console-canvas fleet-canvas"
          width={720}
          height={1280}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          style={{ touchAction: 'none', cursor: mode === 'controller' ? 'crosshair' : 'default' }}
        />
      </div>

      <dl className="kv fleet-kv">
        <dt>串流模式</dt><dd>{sourceLabel(stats)}</dd>
        <dt>解析度</dt><dd>{stats.width ? `${stats.width}x${stats.height}` : '—'}</dd>
        <dt>FPS</dt><dd>{fps}</dd>
        <dt>幀</dt><dd>{stats.frames ?? 0} · 最後幀 {lastFrameLabel(stats)}</dd>
        <dt>輸入</dt><dd>{stats.inputSent ?? 0} sent / {stats.inputRejected ?? 0} rejected</dd>
        <dt>租約</dt><dd>{mode === 'controller' ? 'controller' : 'viewer (唯讀)'}</dd>
      </dl>

      {mode === 'controller' ? (
        <div className="keybar fleet-keybar">
          {TINY_KEYS.map((k) => (
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
      ) : (
        <p className="muted fleet-ro">唯讀 tile：可觀看，輸入被系統拒絕（MD §15.2）。</p>
      )}

      {inputFeedback ? (
        <div className={inputFeedback.ok ? 'pf-ok' : 'pf-bad'}>
          {inputFeedback.ok ? inputFeedback.note : `${inputFeedback.code ?? 'INPUT_REJECTED'} — ${inputFeedback.message ?? ''}`}
        </div>
      ) : null}

      {state === 'CAPACITY_REACHED' ? (
        <div className="error-box">串流容量已達 5/5 — 先關閉一格再開（MD §4.1）。</div>
      ) : null}
      {info?.error ? (
        <div className="error-box">{info.error.message ?? String(info.error)}</div>
      ) : null}
    </div>
  );
}

export function FleetConsole({ user }) {
  const devices = useApi(() => api.get('/api/devices/redroid'), []);
  const [openIds, setOpenIds] = useState([]);
  const [usage, setUsage] = useState(null);

  // Global slot count (MD §14 Phase 3 "slot count") — polled; server
  // authoritative, includes other operators' leases.
  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await api.get('/api/device-streams');
        if (!stop) setUsage(r.usage ?? null);
      } catch {
        /* keep last known value; the page never blocks on it */
      }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // Leaving the page releases every tile (each tile's unmount closes its
  // client — MD §4.2 "關閉 tile 即…釋放 slot").
  const list = devices.data?.devices ?? [];
  const mode = tileModeFor(user);
  const atCap = (usage?.active ?? openIds.length) >= (usage?.max ?? 5);

  function openTile(device) {
    const check = canOpenTile({ device, openIds, usage, openCount: openIds.length });
    if (!check.ok) return;
    setOpenIds((ids) => (ids.includes(device.id) ? ids : [...ids, device.id]));
  }
  function closeTile(id) {
    setOpenIds((ids) => ids.filter((x) => x !== id));
  }
  function closeAll() {
    if (!openIds.length) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`關閉全部 ${openIds.length} 格並釋放所有串流 slot？`)) return;
    setOpenIds([]);
  }

  const openDevices = openIds
    .map((id) => list.find((d) => d.id === id))
    .filter(Boolean);
  const cols = fleetColumns(openIds.length);

  return (
    <div className="stack">
      <div className="card-head fleet-page-head">
        <h1>Fleet Console — 1–5 路串流牆</h1>
        <span className={`pill fleet-usage ${atCap ? 'state-stopped' : 'state-running'}`} title="全域串流 slot（跨所有操作員）">
          Slots {slotText(usage)}
        </span>
        <button type="button" className="danger" onClick={closeAll} disabled={!openIds.length}>
          全關閉（{openIds.length}）
        </button>
      </div>

      <div className="card">
        <div className="card-head"><h3>裝置（運行中才可開格 — lazy start）</h3></div>
        <div className="chip-row">
          {list.map((d) => {
            const open = openIds.includes(d.id);
            const check = canOpenTile({ device: d, openIds, usage, openCount: openIds.length });
            return (
              <button
                key={d.id}
                type="button"
                className={`chip ${open ? 'chip-open' : ''}`}
                disabled={!open && !check.ok}
                title={
                  open
                    ? 'tile 已開啟 — 點擊關閉並釋放 slot'
                    : check.ok
                      ? '開格（開啟即啟動串流 — MD §4.2）'
                      : check.reason === 'cap-reached'
                        ? `全域 5/5 已滿（${slotText(usage)}）`
                        : '裝置未在運行'
                }
                onClick={() => (open ? closeTile(d.id) : openTile(d))}
              >
                {d.name} <span className="muted">{d.containerState}</span>{open ? ' · 開啟中' : ''}
              </button>
            );
          })}
          {list.length === 0 && <span className="muted">沒有裝置</span>}
        </div>
      </div>

      {openDevices.length === 0 ? (
        <div className="card">
          <p className="muted">
            沒有開啟的 tile。點擊上方運行中的裝置開格 — 串流只在 tile 開啟時啟動（lazy start，MD §4.2）；
            關閉 tile 立即釋放 slot。
          </p>
        </div>
      ) : (
        <div className="fleet-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {openDevices.map((d) => (
            <FleetTile key={d.id} device={d} mode={mode} onClosed={closeTile} />
          ))}
        </div>
      )}
    </div>
  );
}

export default FleetConsole;

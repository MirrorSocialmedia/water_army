#!/usr/bin/env bash
# T6 acceptance — shared helpers (sourced by every scripts/acceptance/j*.sh).
#
# Discipline (docs/acceptance-runbook.md):
#  - evidence -> logs/acceptance/<J>/ ; failure -> diagnostics/ bundle
#  - idempotent: rerunnable; assertions target desired STATE, not one-shot side effects
#  - anti-false-red: warm (/health/live + /health/ready + preheat) before asserting
#  - user stack ZERO touch: only `redroid-acc-*` / `wa-acc-*` names + compose
#    project `water-army` are ever operated on. Guard: acc_scope().
#  - secrets: creds come from env (WA_ACCEPT_*), never written to repo/evidence.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
WA_API_URL="${WA_API_URL:-http://127.0.0.1:3000}"
ACC_PREFIX="${ACC_PREFIX:-redroid-acc-}"          # identities/devices of the acceptance fleet
SCRATCH_PREFIX="${SCRATCH_PREFIX:-wa-acc-}"       # ad-hoc containers created by acceptance scripts
COMPOSE_PROJECT="${COMPOSE_PROJECT:-water-army}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-$REPO_ROOT/logs/acceptance}"
J_TIMEOUT="${J_TIMEOUT:-120}"                     # generic bounded-wait seconds

for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "FATAL: required command '$cmd' missing" >&2; exit 2; }
done

CUR_J=""; JAR=""; DIAG_DIR=""

# ---- evidence ----------------------------------------------------------------
j_init() { # j_init <J>   e.g. j_init j1
  CUR_J="$1"
  local d="$EVIDENCE_ROOT/$CUR_J"
  mkdir -p "$d" "$d/diagnostics"
  JAR="$(mktemp)"; DIAG_DIR="$d/diagnostics"
  trap '_on_err $?' EXIT
  echo "== acceptance $CUR_J  (api=$WA_API_URL, evidence=$d) =="
}
ev_path() { echo "$EVIDENCE_ROOT/$CUR_J/$1"; }

verdict() { # verdict <passed|FAIL> <detail>
  echo "$(date -Is) $CUR_J $1 $2" | tee -a "$(ev_path verdict.txt)"
  [ "$1" = "passed" ] || { FAILED=1; }
}
FAILED=0
_finalize() {
  if [ "$FAILED" -eq 0 ]; then verdict passed "all assertions green"; else
    verdict FAIL "see diagnostics/ and verdict.txt"; exit 1; fi
}

_on_err() { # best-effort diagnostics bundle on non-zero exit
  local code="$1"
  [ "$code" -eq 0 ] && { [ -n "$CUR_J" ] && _finalize; return 0; }
  [ -z "$CUR_J" ] && return 0
  echo "-- FAIL (exit $code) — collecting diagnostics --" >&2
  {
    echo "## $(date -Is) exit=$code j=$CUR_J"
    echo "## docker ps"; docker ps -a --format '{{.Names}} {{.Status}}' 2>&1 | head -50 || true
    echo "## health/live"; curl -fsS --max-time 5 "$WA_API_URL/health/live" 2>&1 || true
    echo; echo "## health/ready"; curl -fsS --max-time 5 "$WA_API_URL/health/ready" 2>&1 || true
  } > "$DIAG_DIR/fail-$(date +%s).txt" 2>&1 || true
  api_get_snapshots || true
  verdict FAIL "aborted exit=$code (diagnostics collected)"
  exit "$code"
}
api_get_snapshots() { # best-effort state dumps into diagnostics/
  local out="$DIAG_DIR/state-$(date +%s).json"
  {
    echo "{\"ts\":\"$(date -Is)\",\"identities\":"
    curl -fsS --max-time 10 "$WA_API_URL/api/identities?pageSize=100" 2>/dev/null | jq -c '{total, items:[.items[]|{id,displayName,status}]}' 2>/dev/null || echo '"unavailable"'
    echo ",\"devices\":"
    curl -fsS --max-time 10 "$WA_API_URL/api/devices/redroid" 2>/dev/null | jq -c '{devices:[.devices[]|{id,name,containerState,adbState}]}' 2>/dev/null || echo '"unavailable"'
    echo "}"
  } > "$out" 2>/dev/null || true
}

# ---- api ---------------------------------------------------------------------
_login() { # _login <user_env_prefix>  -> echoes cookie jar path (fresh jar per role)
  local prefix="$1" jar; jar="$(mktemp)"
  local user="${!prefix_USER:-}" pass="${!prefix_PASS:-}"
  [ -n "$user" ] && [ -n "$pass" ] || { echo "FATAL: ${prefix}_USER/${prefix}_PASS env required (secrets via env only)" >&2; exit 2; }
  curl -fsS -c "$jar" --max-time 15 -X POST "$WA_API_URL/api/auth/login" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg u "$user" --arg p "$pass" '{username:$u,password:$p}')" >/dev/null
  echo "$jar"
}
ADMIN_JAR=""; OP_JAR=""
login_admin() { ADMIN_JAR="$(_login WA_ACCEPT_ADMIN)"; }
login_operator() { OP_JAR="$(_login WA_ACCEPT_OP)"; }

# api <role admin|op> <METHOD> <path> [json-body]  -> response body; sets HTTP_CODE
api() {
  local role="$1" method="$2" path="$3" body="${4:-}" jar
  case "$role" in admin) jar="$ADMIN_JAR";; op) jar="$OP_JAR";; *) jar="";; esac
  local out; out="$(mktemp)"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 60 -X "$method" "$WA_API_URL/api$path")
  [ -n "$jar" ] && args+=(-b "$jar")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  HTTP_CODE="$(curl "${args[@]}" 2>/dev/null || echo 000)"
  RESP="$(cat "$out")"; rm -f "$out"
  echo "$RESP"
}
api_get_snap() { local f="$1"; shift; api "$@" >/dev/null; echo "$RESP" | jq . > "$(ev_path "$f")" 2>/dev/null || echo "$RESP" > "$(ev_path "$f")"; }

# ---- warm / waits --------------------------------------------------------------
warm() { # bounded: anti-false-red preheat
  local t=0
  until curl -fsS --max-time 5 "$WA_API_URL/health/live" >/dev/null 2>&1; do
    t=$((t+2)); [ "$t" -ge "$J_TIMEOUT" ] && { echo "FATAL: /health/live not up in ${J_TIMEOUT}s" >&2; exit 1; }
    sleep 2
  done
  curl -fsS --max-time 10 "$WA_API_URL/health/ready" > "$(ev_path health-ready.json)" \
    || { echo "FATAL: /health/ready not 200 (db/redis down?)" >&2; exit 1; }
  curl -sS --max-time 30 "$WA_API_URL/api/health" >/dev/null 2>&1 || true  # preheat lazy compile
  echo "warm ok"
}
wait_until() { # wait_until <desc> <timeout-s> <cmd...>
  local desc="$1" tmo="$2"; shift 2; local t=0
  until "$@" >/dev/null 2>&1; do
    t=$((t+3)); [ "$t" -ge "$tmo" ] && { echo "TIMEOUT: $desc (after ${tmo}s)" >&2; return 1; }
    sleep 3
  done
  echo "ok: $desc"
}

# ---- assertions ----------------------------------------------------------------
assert_eq() { # assert_eq <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $desc (= $2)"; else echo "FAIL  $desc expected=$2 actual=$3"; FAILED=1; fi
}
assert_true() { # assert_true <desc> <cmd...>
  if "${@:2}" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=1; fi
}

# ---- scope guards ---------------------------------------------------------------
acc_scope() { # acc_scope <name> — die unless the name belongs to the acceptance fleet
  case "$1" in
    "$ACC_PREFIX"*|"$SCRATCH_PREFIX"*) return 0 ;;
    *) echo "FATAL: '$1' outside acceptance scope ($ACC_PREFIX* / $SCRATCH_PREFIX*) — user-stack guard" >&2; exit 1 ;;
  esac
}

# ---- fleet spec -------------------------------------------------------------------
acc_names() { # default fleet = redroid-acc-01..10 (override: WA_ACCEPT_NAMES="a,b,c")
  if [ -n "${WA_ACCEPT_NAMES:-}" ]; then echo "$WA_ACCEPT_NAMES" | tr ',' ' '
  else for i in $(seq -w 1 10); do echo -n "redroid-acc-$i "; done; echo; fi
}
acc_ips() { # optional parallel egress IPs: WA_ACCEPT_IPS="1.2.3.4,..."
  if [ -n "${WA_ACCEPT_IPS:-}" ]; then echo "$WA_ACCEPT_IPS" | tr ',' ' '; fi
}

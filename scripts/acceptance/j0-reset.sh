#!/usr/bin/env bash
# J0 — pure/from-zero environment reset (runbook: docs/acceptance-runbook.md J0).
# Rebuilds the water-army stack (project-scoped) with a FRESH DB + fleet on the
# FINAL MERGED image. Requires GMS(MTG) PoC passed + $WA_IMAGE_REF pinned.
#
# Usage:  WA_IMAGE_REF=redroid/wa-merged:<tag> scripts/acceptance/j0-reset.sh
# Env:    WA_IMAGE_REF (required, pinned — no latest/untagged), COMPOSE_FILE
#         (default compose.yaml), WA_ACCEPT_ADMIN_* (login for post-verify).
# Idempotent: yes (full rebuild each run). NEVER touches non-project stacks.
source "$(dirname "$0")/common.sh"

IMG="${WA_IMAGE_REF:-}"
[ -n "$IMG" ] || { echo "FATAL: WA_IMAGE_REF required — final merged artifact ref (pinned tag; GMS PoC must have passed — runbook J0 prereq)" >&2; exit 2; }
case "$IMG" in *:latest|*:) echo "FATAL: image ref must be pinned (got $IMG)" >&2; exit 2 ;; esac

j_init j0
echo "$IMG" > "$(ev_path image-ref.txt)"

# 1) pre-snapshot: user stack state (before/after comparison = zero-touch proof)
{ date -Is; docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}'; } > "$(ev_path docker-ps-before.txt)"

# 2) project-scoped reset (NEVER a global prune/down)
cd "$REPO_ROOT"
CF="${COMPOSE_FILE:-compose.yaml}"
echo "-- compose down (project=$COMPOSE_PROJECT, scoped) --"
docker compose -p "$COMPOSE_PROJECT" -f "$CF" down --remove-orphans -v 2>&1 | tee "$(ev_path compose-down.log)"
echo "-- compose up -d --"
docker compose -p "$COMPOSE_PROJECT" -f "$CF" up -d --build 2>&1 | tee "$(ev_path compose-up.log)"

# 3) migrations (idempotent deploy)
if command -v npx >/dev/null && [ -d prisma ]; then
  npx prisma migrate deploy 2>&1 | tail -5 | tee "$(ev_path migrate.log)" || \
    echo "NOTE: local prisma migrate skipped (API container may run migrations itself) — verify via API" | tee -a "$(ev_path migrate.log)"
fi

# 4) warm + post-verify (fresh DB, healthy deps, RAM gate admits, no user-stack drift)
warm
login_admin
api admin GET "/identities?pageSize=5" > "$(ev_path identities-empty.json)"
assert_eq "fresh DB: identities total = 0" "0" "$(jq -r .total "$(ev_path identities-empty.json)")"
api admin GET "/redroid/preflight?gpu=false" > "$(ev_path preflight.json)"
assert_true "preflight has no FAIL item" bash -c "! jq -e '.. | .status? // empty | select(.==\"FAIL\")' '$(ev_path preflight.json)' >/dev/null"
if [ -n "${WA_ACCEPT_ADMIN_USER:-}" ]; then
  api admin GET "/system/ram-gate" > "$(ev_path ram-gate.json)" && \
    assert_eq "RAM-G1 would admit next boot" "true" "$(jq -r .wouldAdmitNext.admitted "$(ev_path ram-gate.json)" 2>/dev/null || echo unavailable)"
fi

# 5) user-stack zero-drift: everything OUTSIDE the compose project has same names+states
{ date -Is; docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}'; } > "$(ev_path docker-ps-after.txt)"
grep -v -E "${COMPOSE_PROJECT}-|${SCRATCH_PREFIX}" "$(ev_path docker-ps-before.txt)" | grep -v '^[0-9T:-]' | sort > "$(ev_path _stack-a.txt)" 2>/dev/null || true
grep -v -E "${COMPOSE_PROJECT}-|${SCRATCH_PREFIX}" "$(ev_path docker-ps-after.txt)" | grep -v '^[0-9T:-]' | sort > "$(ev_path _stack-b.txt)" 2>/dev/null || true
assert_true "user stack zero-drift (non-project containers unchanged)" diff "$(ev_path _stack-a.txt)" "$(ev_path _stack-b.txt)"

verdict passed "J0 reset complete — fresh stack on $IMG (post-verify green; runbook J0 manual sign-off for GMS-PoC prereq still required for the J verdict)"

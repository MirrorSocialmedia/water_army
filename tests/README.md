# tests/

Test layout per 施工 MD §5 / §16.

- `unit/` — RBAC (401/403), login flow (argon2id, rate limit, origin), secret redaction (P1)
- `integration/` — health/ready dependency states with faked DB/Redis/Docker (P1); queue + scheduler (P3/P4)
- `e2e/` — Playwright UI flows (P6)

Run: `npm test` (host Node ≥22 tolerates the suite; production target is Node 24, see `engines`).

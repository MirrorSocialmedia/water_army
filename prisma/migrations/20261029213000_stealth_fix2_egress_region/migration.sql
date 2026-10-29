-- WA-STEALTH-FIX2 (E): declared egress region per identity binding (ISO-3166 alpha-2,
-- nullable = legacy rows keep working; three-way consistency enforced at the API layer).
ALTER TABLE "identity_egress_bindings" ADD COLUMN "region" varchar(2);

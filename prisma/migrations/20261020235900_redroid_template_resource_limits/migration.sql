-- R5: per-template resource limits for redroid devices (MD §7.2.7).
-- Both nullable: existing templates keep "unlimited" semantics.
ALTER TABLE "redroid_templates" ADD COLUMN "cpu_limit" FLOAT;
ALTER TABLE "redroid_templates" ADD COLUMN "memory_limit_bytes" BIGINT;

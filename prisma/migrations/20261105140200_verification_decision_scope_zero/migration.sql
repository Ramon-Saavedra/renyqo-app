-- DECIDE stamps the application's current scope and does not advance it.
-- A migrated application can still be at scope 0, so its decision receipt can too.
-- Lifecycle commands still require a positive scope because they advance it.
ALTER TABLE verification_command_receipts DROP CONSTRAINT verification_receipt_shape;
ALTER TABLE verification_command_receipts ADD CONSTRAINT verification_receipt_shape CHECK (
  schema_version = 1
  AND scope_revision >= 0
  AND (operation = 'DECIDE' OR scope_revision > 0)
  AND payload_hash ~ '^[0-9a-f]{64}$'
  AND idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'
  AND (result->>'scopeRevision')::integer = scope_revision
  AND result ? 'scopeRevision'
  AND (
    (operation <> 'DECIDE' AND result ? 'requirements' AND jsonb_typeof(result->'requirements') = 'array')
    OR (operation = 'DECIDE' AND result ? 'decision' AND result ? 'verification' AND NOT (result ? 'requirements'))
  )
);

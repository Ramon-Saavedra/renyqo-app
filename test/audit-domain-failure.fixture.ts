import type { Pool } from 'pg';

// Fault injection belongs only to the isolated disposable schema. Production
// append, authorization, role grants and transaction semantics stay unchanged.
export async function failAudit<T>(pool: Pool, work: () => Promise<T>) {
  await pool.query(`CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    RAISE EXCEPTION 'Injected persistence failure' USING ERRCODE='23514';END$$;
    CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`);
  try {
    return await work();
  } finally {
    await pool.query(
      'DROP TRIGGER test_fail_audit ON audit_events; DROP FUNCTION test_fail_audit()',
    );
  }
}

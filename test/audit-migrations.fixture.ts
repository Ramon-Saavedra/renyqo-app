export const auditMigrations = [
  '20261121100000_audit_event_storage',
  '20261121101000_audit_event_protection',
  '20261121102000_audit_event_append',
];

export const auditContextMigrations = [
  '20261121110000_audit_execution_storage',
  '20261121111000_audit_execution_primitives',
  '20261121112000_audit_human_context',
  '20261121113000_audit_bound_append',
  '20261121114000_audit_owner_query',
];

export const auditDomainMigrations = [
  '20261121120000_audit_domain_catalog',
  '20261121121000_audit_domain_commands',
  '20261121122000_audit_invitation_evidence',
  '20261121123000_audit_portfolio_evidence',
  '20261121124000_audit_domain_append',
  '20261121125000_audit_invitation_admission',
];

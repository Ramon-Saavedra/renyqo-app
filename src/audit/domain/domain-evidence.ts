// References to existing domain evidence, never entity/payload serialization.
export type DomainEvidence = Readonly<{
  kind:
    | 'INVITATION_COMMAND'
    | 'MEMBERSHIP_ADMISSION'
    | 'PLAN_CHANGE'
    | 'ASSIGNMENT'
    | 'TRANSFER_REQUEST';
  id: string;
}>;
export type DomainAuditEffect = Readonly<{
  effectKey: string;
  evidence: DomainEvidence;
}>;
export const DOMAIN_AUDIT_SCOPES = [
  'provider.invitation',
  'provider.invitation.accept',
  'provider.plan',
  'provider.assignment',
  'provider.transfer',
  'provider.lifecycle',
  'application.lifecycle',
  'application.lifecycle.system',
] as const;
export type DomainAuditScope = (typeof DOMAIN_AUDIT_SCOPES)[number];

export function validDomainEffect(value: DomainAuditEffect) {
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((k) => ['effectKey', 'evidence'].includes(k)) &&
    typeof value.effectKey === 'string' &&
    /^[a-z][a-z0-9_.:-]{0,79}$/.test(value.effectKey) &&
    value.evidence &&
    Object.getPrototypeOf(value.evidence) === Object.prototype &&
    Object.keys(value.evidence).length === 2 &&
    Object.keys(value.evidence).every((k) => ['kind', 'id'].includes(k)) &&
    [
      'INVITATION_COMMAND',
      'MEMBERSHIP_ADMISSION',
      'PLAN_CHANGE',
      'ASSIGNMENT',
      'TRANSFER_REQUEST',
    ].includes(value.evidence.kind) &&
    typeof value.evidence.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.evidence.id,
    )
  );
}

import request from 'supertest';

/** Explicit precondition for scenarios testing lifecycle/admission, not missing facts. */
export const eligibleProfileFields = {
  introduction: 'An eligible test applicant.',
  householdNetIncome: 4000,
  adultsCount: 1,
  childrenCount: 0,
  hasPets: false,
  isSmoker: false,
  schufaAvailable: true,
  incomeProofAvailable: true,
};

export async function createEligibleApplicantProfile(
  agent: ReturnType<typeof request.agent>,
) {
  await agent
    .patch('/api/v1/applicant/profile')
    .send(eligibleProfileFields)
    .expect(200);
}

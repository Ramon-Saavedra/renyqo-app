import 'reflect-metadata';
import { validateSync } from 'class-validator';
import {
  APPLICANT_APPLICATION_OVERVIEW_GROUPS,
  ApplicantApplicationOverviewQueryDto,
} from './applicant-application-overview-query.dto';

describe('ApplicantApplicationOverviewQueryDto', () => {
  it.each([...APPLICANT_APPLICATION_OVERVIEW_GROUPS])(
    'accepts group %s',
    (group) => {
      const query = new ApplicantApplicationOverviewQueryDto();
      query.group = group;
      expect(validateSync(query)).toEqual([]);
    },
  );

  it('rejects an unknown group', () => {
    const query = new ApplicantApplicationOverviewQueryDto();
    Reflect.set(query, 'group', 'OPEN');
    expect(validateSync(query)).not.toHaveLength(0);
  });
});

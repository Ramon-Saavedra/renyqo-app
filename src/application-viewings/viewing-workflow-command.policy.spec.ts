import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ApplicationViewingPolicy } from './application-viewing.policy';
import { ViewingWorkflowCommandPolicy } from './viewing-workflow-command.policy';
import { WorkflowScheduleDto } from './dto/workflow-command.dto';

describe('ViewingWorkflowCommandPolicy', () => {
  const policy = new ViewingWorkflowCommandPolicy(
    new ApplicationViewingPolicy(),
  );
  const now = new Date('2027-01-01T10:00:00Z');
  const dto: WorkflowScheduleDto = {
    requestKey: 'd0739a38-9824-4e38-bbee-6fcd4c11c642',
    expectedWorkflowRevision: 0,
    startsAt: '2027-01-02T04:00:00Z',
    endsAt: '2027-01-02T04:30:00Z',
    timeZone: 'Europe/Berlin',
  };
  it('allows the exact normal lead boundary with a full response window', () => {
    expect(policy.schedule(dto, 'provider', now)).toMatchObject({
      timing: 'NORMAL',
      responseDeadlineAt: new Date('2027-01-01T22:00:00Z'),
    });
    expect(() =>
      policy.schedule(
        { ...dto, startsAt: '2027-01-02T03:59:59Z' },
        'provider',
        now,
      ),
    ).toThrow(BadRequestException);
  });
  it('bounds explicitly short-notice responses by both commitments', () => {
    const candidate = {
      ...dto,
      shortNotice: true,
      startsAt: '2027-01-01T11:00:00Z',
      endsAt: '2027-01-01T11:30:00Z',
    };
    expect(
      policy.schedule(candidate, 'provider', now).responseDeadlineAt,
    ).toEqual(new Date(candidate.startsAt));
    expect(
      policy.schedule(dto, 'applicant', now, new Date('2027-01-01T16:00:00Z')),
    ).toMatchObject({
      timing: 'SHORT_NOTICE',
      responseDeadlineAt: new Date('2027-01-01T16:00:00Z'),
    });
    expect(() =>
      policy.schedule(dto, 'provider', now, new Date('2027-01-01T16:00:00Z')),
    ).toThrow(BadRequestException);
    expect(() => policy.schedule(candidate, 'provider', now, now)).toThrow(
      BadRequestException,
    );
  });
  it('canonicalizes equivalent instants and trimmed messages for retries', () => {
    expect(
      policy.canonicalSchedule({
        ...dto,
        startsAt: '2027-01-02T05:00:00+01:00',
        message: ' hello ',
      }),
    ).toEqual(policy.canonicalSchedule({ ...dto, message: 'hello' }));
  });
  it.each([
    { shortNotice: 'false' },
    { expectedWorkflowRevision: '0' },
    { extra: true },
  ])('rejects coercion and unknown command fields: %j', async (extra) => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    });
    await expect(
      pipe.transform(
        { ...dto, ...extra },
        { type: 'body', metatype: WorkflowScheduleDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

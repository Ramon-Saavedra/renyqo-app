import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ProposeViewingDto,
  RequestViewingChangeDto,
  ViewingActionDto,
} from './viewing-input.dto';

describe('Viewing input validation', () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const proposal = {
    requestKey: '00000000-0000-4000-8000-000000000001',
    startsAt: '2027-01-01T12:00:00+01:00',
    endsAt: '2027-01-01T12:30:00+01:00',
    timeZone: 'Europe/Berlin',
  };
  it('accepts a complete explicit proposal', async () => {
    expect(
      await validate(plainToInstance(ProposeViewingDto, proposal), options),
    ).toEqual([]);
  });
  it('rejects extra fields in actions', async () => {
    expect(
      await validate(
        plainToInstance(ViewingActionDto, { startsAt: proposal.startsAt }),
        options,
      ),
    ).not.toEqual([]);
  });
  it('prevents implicit conversion of text and timestamp inputs', async () => {
    for (const input of [
      { ...proposal, providerNote: 123 },
      { ...proposal, startsAt: 123 },
      { ...proposal, timeZone: 123 },
    ]) {
      expect(
        await validate(
          plainToInstance(ProposeViewingDto, input, {
            enableImplicitConversion: true,
          }),
          options,
        ),
      ).not.toEqual([]);
    }
    expect(
      await validate(
        plainToInstance(
          RequestViewingChangeDto,
          { message: 123 },
          { enableImplicitConversion: true },
        ),
        options,
      ),
    ).not.toEqual([]);
  });
  it('rejects timezone-less dates, markup and oversized messages', async () => {
    expect(
      await validate(
        plainToInstance(ProposeViewingDto, {
          ...proposal,
          startsAt: '2027-01-01T12:00:00',
        }),
        options,
      ),
    ).not.toEqual([]);
    for (const message of ['<b>Hello</b>', 'a'.repeat(501), ' '])
      expect(
        await validate(
          plainToInstance(RequestViewingChangeDto, { message }),
          options,
        ),
      ).not.toEqual([]);
  });
});

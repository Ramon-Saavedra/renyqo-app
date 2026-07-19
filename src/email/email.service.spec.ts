import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { EnvironmentVariables } from '../config/env.validation';
import { EmailService } from './email.service';

const mockSesSend = jest.fn<(command: unknown) => Promise<void>>();

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({
    send: mockSesSend,
  })),
  SendEmailCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

type ConfigValue = string | undefined;

const makeConfigService = (
  values: Record<string, ConfigValue>,
): ConfigService<EnvironmentVariables, true> =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ConfigService<EnvironmentVariables, true>;

describe('EmailService', () => {
  beforeEach(() => {
    mockSesSend.mockResolvedValue();
    jest.clearAllMocks();
  });

  it('sends password reset emails through Amazon SES', async () => {
    const service = new EmailService(
      makeConfigService({
        AWS_REGION: 'eu-central-1',
        SES_FROM_EMAIL: 'no-reply@renyqo.test',
      }),
    );

    await service.sendPasswordResetEmail({
      to: 'user@example.com',
      resetUrl: 'https://app.renyqo.test/reset-password?token=secret',
    });

    expect(SESClient).toHaveBeenCalledWith({ region: 'eu-central-1' });
    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Source: 'no-reply@renyqo.test',
        Destination: { ToAddresses: ['user@example.com'] },
      }),
    );
    expect(mockSesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Message: expect.objectContaining({
            Subject: expect.objectContaining({
              Data: 'Renyqo Passwort zurücksetzen',
            }),
          }),
        }),
      }),
    );
  });

  it('fails clearly when SES configuration is missing', async () => {
    const service = new EmailService(makeConfigService({}));

    await expect(
      service.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.renyqo.test/reset-password?token=secret',
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});

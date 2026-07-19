import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import type { EnvironmentVariables } from '../config/env.validation';

type PasswordResetEmailInput = {
  to: string;
  resetUrl: string;
};

@Injectable()
export class EmailService {
  private readonly sesClient: SESClient | null;
  private readonly fromEmail: string | null;

  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {
    const region = this.configService.get('AWS_REGION', { infer: true });
    this.fromEmail =
      this.configService.get('SES_FROM_EMAIL', { infer: true }) ?? null;
    this.sesClient = region ? new SESClient({ region }) : null;
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    if (!this.sesClient || !this.fromEmail) {
      throw new InternalServerErrorException(
        'Email delivery is not configured',
      );
    }

    await this.sesClient.send(
      new SendEmailCommand({
        Source: this.fromEmail,
        Destination: {
          ToAddresses: [input.to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Renyqo Passwort zurücksetzen',
          },
          Body: {
            Text: {
              Charset: 'UTF-8',
              Data: [
                'Du hast angefordert, dein Renyqo Passwort zurückzusetzen.',
                'Öffne den folgenden Link, um ein neues Passwort festzulegen:',
                input.resetUrl,
                'Wenn du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.',
              ].join('\n\n'),
            },
            Html: {
              Charset: 'UTF-8',
              Data: [
                '<p>Du hast angefordert, dein Renyqo Passwort zurückzusetzen.</p>',
                `<p><a href="${this.escapeHtml(input.resetUrl)}">Passwort zurücksetzen</a></p>`,
                '<p>Wenn du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.</p>',
              ].join(''),
            },
          },
        },
      }),
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

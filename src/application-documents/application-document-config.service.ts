import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApplicationDocumentConfigService {
  constructor(private readonly config: ConfigService) {}

  get region(): string {
    return 'eu-central-1';
  }

  get bucket(): string {
    const value = this.required('DOCUMENTS_S3_BUCKET');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value))
      throw new ServiceUnavailableException(
        'Invalid document bucket configuration',
      );
    return value;
  }

  get account(): string {
    const value = this.required('DOCUMENTS_AWS_ACCOUNT_ID');
    if (!/^\d{12}$/.test(value))
      throw new ServiceUnavailableException(
        'Invalid document account configuration',
      );
    return value;
  }

  get planArn(): string {
    const value = this.required('DOCUMENTS_GUARDDUTY_PLAN_ARN');
    if (
      !value.startsWith(
        `arn:aws:guardduty:${this.region}:${this.account}:malware-protection-plan/`,
      )
    )
      throw new ServiceUnavailableException(
        'Invalid document protection plan configuration',
      );
    return value;
  }

  get queueUrl(): string {
    const value = this.required('DOCUMENTS_SCAN_QUEUE_URL');
    if (
      !value.startsWith(
        `https://sqs.${this.region}.amazonaws.com/${this.account}/`,
      )
    )
      throw new ServiceUnavailableException(
        'Invalid document queue configuration',
      );
    return value;
  }

  get recoveryDelayMs(): number {
    return 5 * 60_000;
  }
  get processingTimeoutMs(): number {
    return 30 * 60_000;
  }

  validateWorker(): void {
    void this.bucket;
    void this.planArn;
    void this.queueUrl;
    const database = this.required('DATABASE_URL');
    if (!/^postgres(?:ql)?:\/\//.test(database))
      throw new ServiceUnavailableException(
        'Invalid worker database configuration',
      );
  }

  private required(key: string): string {
    const value = this.config.get<unknown>(key);
    if (typeof value !== 'string' || !value.trim())
      throw new ServiceUnavailableException(
        'Document storage configuration is incomplete',
      );
    return value.trim();
  }
}

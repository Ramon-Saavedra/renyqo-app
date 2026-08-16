import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  SESSION_SECRET!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  FRONTEND_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AWS_REGION?: string;

  @IsOptional()
  @IsEmail()
  SES_FROM_EMAIL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  CLOUDINARY_CLOUD_NAME?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_SECRET?: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_FOLDER!: string;

  @IsString()
  @IsNotEmpty()
  OPENAI_API_KEY!: string;

  @IsString()
  @IsNotEmpty()
  OPENAI_LISTING_MODEL!: string;

  @IsString()
  @IsNotEmpty()
  OPENAI_TRANSCRIPTION_MODEL!: string;

  @IsInt()
  @Min(1)
  AI_RATE_LIMIT_WINDOW_MS!: number;

  @IsInt()
  @Min(1)
  AI_TEXT_RATE_LIMIT!: number;

  @IsInt()
  @Min(1)
  AI_PDF_RATE_LIMIT!: number;

  @IsInt()
  @Min(1)
  AI_AUDIO_RATE_LIMIT!: number;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const normalizedConfig = normalizeConfig(config);

  const validated = plainToInstance(EnvironmentVariables, normalizedConfig, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));

  const cloudinaryError = validateCloudinaryConfig(validated);
  if (cloudinaryError) {
    messages.push(cloudinaryError);
  }

  const sesError = validateSesConfig(validated);
  if (sesError) {
    messages.push(sesError);
  }

  if (messages.length > 0) {
    throw new Error(`Invalid environment variables:\n${messages.join('\n')}`);
  }

  return validated;
}

function normalizeConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...config,
    CLOUDINARY_CLOUD_NAME: normalizeOptionalString(
      config['CLOUDINARY_CLOUD_NAME'],
    ),
    CLOUDINARY_API_KEY: normalizeOptionalString(config['CLOUDINARY_API_KEY']),
    CLOUDINARY_API_SECRET: normalizeOptionalString(
      config['CLOUDINARY_API_SECRET'],
    ),
    CLOUDINARY_FOLDER:
      normalizeOptionalString(config['CLOUDINARY_FOLDER']) ?? 'renyqo',
    AWS_REGION: normalizeOptionalString(config['AWS_REGION']),
    SES_FROM_EMAIL: normalizeOptionalString(config['SES_FROM_EMAIL']),
    OPENAI_API_KEY: normalizeOptionalString(config['OPENAI_API_KEY']),
    OPENAI_LISTING_MODEL: normalizeOptionalString(
      config['OPENAI_LISTING_MODEL'],
    ),
    OPENAI_TRANSCRIPTION_MODEL: normalizeOptionalString(
      config['OPENAI_TRANSCRIPTION_MODEL'],
    ),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateCloudinaryConfig(config: EnvironmentVariables): string | null {
  const credentials = [
    config.CLOUDINARY_CLOUD_NAME,
    config.CLOUDINARY_API_KEY,
    config.CLOUDINARY_API_SECRET,
  ];
  const configuredCount = credentials.filter(Boolean).length;
  const requiresCloudinary = config.NODE_ENV === NodeEnv.Production;

  if (requiresCloudinary && configuredCount !== credentials.length) {
    return 'Cloudinary credentials are required in production';
  }

  if (
    !requiresCloudinary &&
    configuredCount > 0 &&
    configuredCount !== credentials.length
  ) {
    return 'Cloudinary credentials must be provided together';
  }

  return null;
}

function validateSesConfig(config: EnvironmentVariables): string | null {
  const values = [config.AWS_REGION, config.SES_FROM_EMAIL];
  const configuredCount = values.filter(Boolean).length;
  const requiresSes = config.NODE_ENV === NodeEnv.Production;

  if (requiresSes && configuredCount !== values.length) {
    return 'Amazon SES configuration is required in production';
  }

  if (
    !requiresSes &&
    configuredCount > 0 &&
    configuredCount !== values.length
  ) {
    return 'Amazon SES configuration must include AWS_REGION and SES_FROM_EMAIL';
  }

  return null;
}

import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
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

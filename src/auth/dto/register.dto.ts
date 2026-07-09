import {
  Equals,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export enum PublicRole {
  APPLICANT = 'applicant',
  PROVIDER = 'provider',
}

export enum PublicProviderType {
  PRIVATE = 'private',
  COMPANY = 'company',
}

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsEnum(PublicRole)
  role!: PublicRole;

  @IsOptional()
  @IsEnum(PublicProviderType)
  providerType?: PublicProviderType;

  @ValidateIf(
    (dto: RegisterDto) => dto.providerType === PublicProviderType.COMPANY,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  companyName?: string;

  @Equals(true)
  acceptedTerms!: true;

  @Equals(true)
  acceptedPrivacy!: true;
}

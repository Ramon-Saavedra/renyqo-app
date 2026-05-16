import {
  Equals,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum PublicRole {
  APPLICANT = 'applicant',
  PROVIDER = 'provider',
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

  @Equals(true)
  acceptedTerms!: true;

  @Equals(true)
  acceptedPrivacy!: true;
}

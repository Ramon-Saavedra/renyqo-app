import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';
import { canonicalEmail } from '../identity/canonical-email';

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? canonicalEmail(value) : value,
  )
  @IsEmail()
  email!: string;
}

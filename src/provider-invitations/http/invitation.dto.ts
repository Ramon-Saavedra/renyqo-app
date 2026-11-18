import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { canonicalEmail } from '../../auth/identity/canonical-email';
export class CreateInvitationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? canonicalEmail(value) : value,
  )
  @IsEmail()
  email!: string;
  @IsUUID('4') commandId!: string;
}
export class InvitationMutationDto {
  @IsUUID('4') commandId!: string;
  @IsInt() @Min(1) revision!: number;
}
export class InvitationTokenDto {
  @IsString() @Length(43, 43) token!: string;
}
export class AcceptInvitationDto extends InvitationTokenDto {
  @IsUUID('4') commandId!: string;
}
export class TeamPageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}

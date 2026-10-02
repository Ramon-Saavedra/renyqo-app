import { IsUUID } from 'class-validator';

export class ApplicationConversationParamsDto {
  @IsUUID('4')
  applicationId!: string;
}

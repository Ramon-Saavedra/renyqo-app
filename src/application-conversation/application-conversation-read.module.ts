import { Module } from '@nestjs/common';
import { ApplicationConversationReadService } from './application-conversation-read.service';

@Module({
  providers: [ApplicationConversationReadService],
  exports: [ApplicationConversationReadService],
})
export class ApplicationConversationReadModule {}

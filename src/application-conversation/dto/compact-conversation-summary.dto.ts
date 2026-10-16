import type { conversationCapabilities } from '../application-conversation.policy';
export type ConversationCapabilities = ReturnType<
  typeof conversationCapabilities
>;
export class CompactConversationSummaryDto {
  readonly applicantRepliesEnabled: boolean;
  readonly canCurrentUserSend: boolean;
  readonly canCurrentUserManageApplicantReplies: boolean;
  readonly sendBlockReason: ConversationCapabilities['sendBlockReason'];
  constructor(
    readonly hasMessages: boolean,
    capabilities: ConversationCapabilities,
  ) {
    this.applicantRepliesEnabled = capabilities.applicantRepliesEnabled;
    this.canCurrentUserSend = capabilities.canCurrentUserSend;
    this.canCurrentUserManageApplicantReplies =
      capabilities.canCurrentUserManageApplicantReplies;
    this.sendBlockReason = capabilities.sendBlockReason;
  }
}

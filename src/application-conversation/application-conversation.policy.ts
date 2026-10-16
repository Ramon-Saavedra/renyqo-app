import { ConversationSide } from '../generated/prisma/enums';
import {
  applicationProcessAllowsMutation,
  type ApplicationProcessState,
} from '../applications/application-process.policy';
import type { Prisma } from '../generated/prisma/client';

export type ConversationSendBlockReason =
  | 'LIFECYCLE_READ_ONLY'
  | 'APPLICANT_REPLIES_DISABLED';
export function incomingUnreadMessages(
  side: ConversationSide,
): Prisma.ApplicationMessageWhereInput {
  return { senderType: { not: side }, readAt: null };
}
export function conversationCapabilities(
  application: ApplicationProcessState,
  applicantRepliesEnabled: boolean,
  side: ConversationSide,
) {
  const mutable = applicationProcessAllowsMutation(application);
  const sendBlockReason: ConversationSendBlockReason | null = !mutable
    ? 'LIFECYCLE_READ_ONLY'
    : side === ConversationSide.APPLICANT && !applicantRepliesEnabled
      ? 'APPLICANT_REPLIES_DISABLED'
      : null;
  return {
    applicantRepliesEnabled,
    canCurrentUserSend: sendBlockReason === null,
    canCurrentUserManageApplicantReplies:
      mutable && side === ConversationSide.PROVIDER,
    sendBlockReason,
  };
}

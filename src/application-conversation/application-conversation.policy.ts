import { ConversationSide } from '../generated/prisma/enums';
import {
  applicationProcessAllowsMutation,
  type ApplicationProcessState,
} from '../applications/application-process.policy';
import type { Prisma } from '../generated/prisma/client';

export function incomingUnreadMessages(
  side: ConversationSide,
): Prisma.ApplicationMessageWhereInput {
  return { senderType: { not: side }, readAt: null };
}

export function conversationResponsibility(
  application: ApplicationProcessState,
  sender: ConversationSide | null,
) {
  const isReadOnly = !applicationProcessAllowsMutation(application);
  const expectedResponder = isReadOnly
    ? null
    : sender === ConversationSide.PROVIDER
      ? ConversationSide.APPLICANT
      : ConversationSide.PROVIDER;
  return { isReadOnly, expectedResponder };
}

import { conversationCapabilities } from './application-conversation.policy';
import {
  ApplicationStatus,
  ListingStatus,
  ConversationSide,
} from '../generated/prisma/enums';
describe('Conversation capabilities', () => {
  for (const status of Object.values(ApplicationStatus))
    for (const listingStatus of Object.values(ListingStatus))
      for (const enabled of [false, true]) {
        it(`${status}/${listingStatus}/enabled=${enabled}`, () => {
          const application = { status, listing: { status: listingStatus } };
          const mutable =
            status === ApplicationStatus.ACTIVE &&
            (listingStatus === ListingStatus.PUBLISHED ||
              listingStatus === ListingStatus.PAUSED);
          const provider = conversationCapabilities(
            application,
            enabled,
            ConversationSide.PROVIDER,
          );
          const applicant = conversationCapabilities(
            application,
            enabled,
            ConversationSide.APPLICANT,
          );
          expect(provider.canCurrentUserSend).toBe(mutable);
          expect(provider.canCurrentUserManageApplicantReplies).toBe(mutable);
          expect(applicant.canCurrentUserSend).toBe(mutable && enabled);
          expect(applicant.canCurrentUserManageApplicantReplies).toBe(false);
          expect(applicant.sendBlockReason).toBe(
            !mutable
              ? 'LIFECYCLE_READ_ONLY'
              : enabled
                ? null
                : 'APPLICANT_REPLIES_DISABLED',
          );
        });
      }
});

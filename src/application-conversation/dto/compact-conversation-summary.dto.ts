import type { ConversationSide } from '../../generated/prisma/enums';

export class CompactConversationSummaryDto {
  constructor(
    readonly isOpen: boolean,
    readonly isReadOnly: boolean,
    readonly expectedResponder: ConversationSide | null,
    readonly canCurrentUserSend: boolean,
  ) {}
}

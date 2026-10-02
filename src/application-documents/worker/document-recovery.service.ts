import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationDocumentState } from '../../generated/prisma/enums';
import { ApplicationDocumentFinalizationService } from '../application-document-finalization.service';

@Injectable()
export class DocumentRecoveryService {
  private readonly logger = new Logger(DocumentRecoveryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly finalization: ApplicationDocumentFinalizationService,
  ) {}
  async run(): Promise<void> {
    const files = await this.prisma.applicationDocumentFile.findMany({
      where: {
        state: ApplicationDocumentState.PROCESSING,
        recoverAfter: { lte: new Date() },
      },
      orderBy: [{ recoverAfter: 'asc' }, { id: 'asc' }],
      take: 25,
    });
    for (const file of files) {
      try {
        await this.finalization.recover(file);
      } catch {
        this.logger.error({ signal: 'RECOVERY_FAILED', documentId: file.id });
        await this.prisma.applicationDocumentFile.updateMany({
          where: { id: file.id, state: ApplicationDocumentState.PROCESSING },
          data: { recoverAfter: new Date(Date.now() + 60_000) },
        });
      }
    }
    this.logger.log({ signal: 'WORKER_HEARTBEAT', inspected: files.length });
  }
}

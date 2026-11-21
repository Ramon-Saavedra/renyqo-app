import { Module } from '@nestjs/common';
import { AuditWriter } from './persistence/audit-writer';

// Intentionally not imported by AppModule and exports no runtime API in Slice 1.
@Module({ providers: [AuditWriter] })
export class AuditModule {}

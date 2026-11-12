import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProviderWorkspacesController } from './provider-workspaces.controller';
import { ProviderWorkspacesModule } from './provider-workspaces.module';
import { WorkspaceEstablishment } from './workspace-establishment';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

describe('ProviderWorkspacesModule boundary', () => {
  it('exposes only discovery and no exported mutation providers or infrastructure side effects', async () => {
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        ProviderWorkspacesModule,
      ),
    ).toEqual([ProviderWorkspacesController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProviderWorkspacesModule),
    ).toBeUndefined();
    const module = await Test.createTestingModule({
      imports: [PrismaModule, ProviderWorkspacesModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(module.get(WorkspaceEstablishment)).toBeInstanceOf(
      WorkspaceEstablishment,
    );
    await module.close();
  });
});

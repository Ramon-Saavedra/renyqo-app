import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProviderWorkspacesModule } from './provider-workspaces.module';
import { WorkspaceEstablishment } from './workspace-establishment';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

describe('Dormant ProviderWorkspacesModule boundary', () => {
  it('has no controllers, exported mutation providers or infrastructure side effects', async () => {
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        ProviderWorkspacesModule,
      ),
    ).toBeUndefined();
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

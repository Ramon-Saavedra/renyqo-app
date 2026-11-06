import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProviderWorkspacesModule } from './provider-workspaces.module';
import { WorkspaceEstablishment } from './workspace-establishment';

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
      imports: [ProviderWorkspacesModule],
    }).compile();
    expect(module.get(WorkspaceEstablishment)).toBeInstanceOf(
      WorkspaceEstablishment,
    );
    await module.close();
  });
});

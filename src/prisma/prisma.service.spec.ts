import { PrismaService } from './prisma.service';

describe('Shared Prisma startup boundary', () => {
  it('fails closed on an unsafe production credential at the operational Listing cutover', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const connect = jest.fn().mockResolvedValue(undefined);
    const query = jest
      .fn()
      .mockRejectedValue(new Error('Not a restricted workspace login'));
    try {
      await expect(
        PrismaService.prototype.onModuleInit.call({
          $connect: connect,
          $queryRaw: query,
        }),
      ).rejects.toThrow('Not a restricted workspace login');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
  it('connects with the fully validated application runtime privilege contract', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const query = jest.fn().mockResolvedValue([{ safe: true }]);
    try {
      await PrismaService.prototype.onModuleInit.call({
        $connect: jest.fn().mockResolvedValue(undefined),
        $queryRaw: query,
      });
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});

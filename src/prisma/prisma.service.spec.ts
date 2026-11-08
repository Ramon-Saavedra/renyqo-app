import { PrismaService } from './prisma.service';

describe('Shared Prisma startup boundary', () => {
  it('connects in production without requiring workspace runtime role verification', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const connect = jest.fn().mockResolvedValue(undefined);
    const query = jest
      .fn()
      .mockRejectedValue(new Error('Not a restricted workspace login'));
    try {
      await PrismaService.prototype.onModuleInit.call({
        $connect: connect,
        $queryRaw: query,
      });
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController, ReadinessController } from './health.controller';
import { HealthService } from './health.service';
import { ReadinessService } from './readiness.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns status ok with an ISO timestamp', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });
});

describe('ReadinessController', () => {
  let controller: ReadinessController;
  const check = jest.fn<() => Promise<'ok' | 'unavailable'>>();

  beforeEach(async () => {
    check.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReadinessController],
      providers: [{ provide: ReadinessService, useValue: { check } }],
    }).compile();

    controller = module.get(ReadinessController);
  });

  it('returns ok when the database check succeeds', async () => {
    check.mockResolvedValue('ok');

    await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
  });

  it('returns 503 without database error text when the check fails', async () => {
    check.mockResolvedValue('unavailable');

    try {
      await controller.ready();
      throw new Error('expected unavailable');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(503);
      expect(http.getResponse()).toEqual({ status: 'unavailable' });
    }
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  NotificationCategory as Category,
  notificationCategory,
  notificationTypesForCategory,
} from './notification-category';
import { NotificationQueryDto } from './notification.dto';

describe('Notification category contract', () => {
  it.each([
    ['APPLICATION_REJECTED', Category.APPLICATION],
    ['APPLICATION_RESTORED', Category.APPLICATION],
    ['VIEWING_PROPOSED', Category.VIEWING],
    ['VIEWING_OUTCOME_CORRECTED', Category.VIEWING],
    ['DOCUMENT_REQUESTED', Category.DOCUMENTS],
    ['DOCUMENT_REVIEWED', Category.DOCUMENTS],
  ] as const)(
    'classifies %s without changing notification policy',
    (type, category) => {
      expect(notificationCategory(type)).toBe(category);
      expect(notificationTypesForCategory(category)).toContain(type);
    },
  );
  it('keeps chat outside the bell categories', () => {
    expect(() => notificationCategory('MESSAGE_SENT')).toThrow();
    for (const category of Object.values(Category))
      expect(notificationTypesForCategory(category)).not.toContain(
        'MESSAGE_SENT',
      );
  });
  it.each([undefined, ...Object.values(Category)])(
    'accepts category %s',
    async (category) => {
      expect(
        await validate(plainToInstance(NotificationQueryDto, { category })),
      ).toEqual([]);
    },
  );
  it.each(['VIEWINGS', 'viewing', '', ['VIEWING'], 1])(
    'rejects invalid filter %s',
    async (category) => {
      expect(
        await validate(plainToInstance(NotificationQueryDto, { category })),
      ).not.toEqual([]);
    },
  );
});

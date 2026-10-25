import { ApplicationActivityType } from '../generated/prisma/enums';

export enum NotificationCategory {
  APPLICATION = 'APPLICATION',
  VIEWING = 'VIEWING',
  DOCUMENTS = 'DOCUMENTS',
}

// Classification is independent of the product notification allowlist.
const categories = new Map<ApplicationActivityType, NotificationCategory>();
for (const type of Object.values(ApplicationActivityType)) {
  if (type.startsWith('APPLICATION_'))
    categories.set(type, NotificationCategory.APPLICATION);
  if (type.startsWith('VIEWING_'))
    categories.set(type, NotificationCategory.VIEWING);
  if (type.startsWith('DOCUMENT_'))
    categories.set(type, NotificationCategory.DOCUMENTS);
}

export function notificationCategory(
  type: ApplicationActivityType,
): NotificationCategory {
  const category = categories.get(type);
  if (!category) throw new Error('Unsupported notification activity category');
  return category;
}

export function notificationTypesForCategory(
  category: NotificationCategory,
): ApplicationActivityType[] {
  return [...categories]
    .filter(([, value]) => value === category)
    .map(([type]) => type);
}

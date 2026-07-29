import {
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
  ValidatorConstraint,
  registerDecorator,
} from 'class-validator';
import type { CreateListingDto } from '../dto/create-listing.dto';

@ValidatorConstraint({ name: 'bedroomsNotGreaterThanRooms', async: false })
export class BedroomsNotGreaterThanRoomsConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CreateListingDto;

    if (dto.rooms === undefined || dto.rooms === null) {
      return true;
    }

    if (dto.bedrooms === undefined || dto.bedrooms === null) {
      return true;
    }

    if (typeof dto.rooms !== 'number' || typeof dto.bedrooms !== 'number') {
      return true;
    }

    return dto.bedrooms <= dto.rooms;
  }

  defaultMessage(): string {
    return 'bedrooms must not be greater than rooms';
  }
}

export function BedroomsNotGreaterThanRooms(
  validationOptions?: ValidationOptions,
) {
  return function (object: NonNullable<unknown>, propertyName?: string): void {
    registerDecorator({
      target: object as new (...args: unknown[]) => unknown,
      propertyName: propertyName ?? '',
      options: validationOptions,
      constraints: [],
      validator: BedroomsNotGreaterThanRoomsConstraint,
    });
  };
}

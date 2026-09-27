import { BadRequestException, Injectable } from '@nestjs/common';

import type { Listing, Prisma } from '../generated/prisma/client';
import type { CreateListingDto } from './dto/create-listing.dto';
import type { UpdateListingDto } from './dto/update-listing.dto';

const DEFAULT_DEPOSIT_MONTHS = 2;
const MIN_DEPOSIT_MONTHS = 1;
const MAX_DEPOSIT_MONTHS = 3;
const DEPOSIT_AMOUNT_TOLERANCE = 0.01;

const ELIGIBILITY_CRITERIA_FIELDS = [
  'minimumHouseholdNetIncome',
  'schufaRequired',
  'incomeProofRequired',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
] as const;

@Injectable()
export class ListingInputRules {
  buildCreateData(
    providerId: string,
    dto: CreateListingDto,
  ): Omit<Prisma.ListingUncheckedCreateInput, 'displayOrder'> {
    const draftData = this.stripEmptyValues({
      providerId,
      objectType: dto.objectType,
      city: dto.city,
      zip: dto.zip,
      street: dto.street,
      district: dto.district,
      showExactAddress: dto.showExactAddress,
      livingArea: dto.livingArea,
      rooms: dto.rooms,
      bedrooms: dto.bedrooms,
      coldRent: dto.coldRent,
      additionalCosts: dto.additionalCosts,
      deposit: dto.deposit,
      depositMonths: dto.depositMonths,
      availableFrom: dto.availableFrom
        ? new Date(dto.availableFrom)
        : undefined,
      title: dto.title,
      shortDescription: dto.shortDescription,
      minimumHouseholdNetIncome: dto.minimumHouseholdNetIncome,
      schufaRequired: dto.schufaRequired,
      incomeProofRequired: dto.incomeProofRequired,
      suitableForPeopleCount: dto.suitableForPeopleCount,
      petsPolicy: dto.petsPolicy,
      smokingPolicy: dto.smokingPolicy,
    });

    return {
      providerId,
      ...draftData,
      ...this.buildCreateDepositData(dto),
    };
  }

  hasMeaningfulDraftData(dto: CreateListingDto): boolean {
    return Object.entries(dto).some(([key, value]) => {
      if (value === undefined || value === null) {
        return false;
      }

      if (key === 'depositMonths' && value === DEFAULT_DEPOSIT_MONTHS) {
        return false;
      }

      if (typeof value === 'string') {
        return value.trim().length > 0;
      }

      if (typeof value === 'boolean') {
        return value;
      }

      return true;
    });
  }

  buildUpdateData(
    dto: UpdateListingDto,
    listing: Listing,
  ): Prisma.ListingUncheckedUpdateInput {
    this.assertBedroomsNotGreaterThanRooms(dto);

    const { availableFrom, ...rest } = dto;
    const draftData = this.stripEmptyValues(
      {
        ...rest,
        availableFrom:
          availableFrom !== undefined ? new Date(availableFrom) : undefined,
      },
      ELIGIBILITY_CRITERIA_FIELDS,
    );

    return {
      ...draftData,
      ...this.buildUpdateDepositData(dto, listing),
    };
  }

  buildCreateDepositData(
    dto: CreateListingDto,
  ): Partial<
    Pick<Prisma.ListingUncheckedCreateInput, 'deposit' | 'depositMonths'>
  > {
    const depositMonths = dto.depositMonths ?? DEFAULT_DEPOSIT_MONTHS;
    this.assertDepositMonthsAllowed(depositMonths);

    if (dto.deposit !== undefined && dto.coldRent === undefined) {
      throw new BadRequestException(
        'coldRent is required when deposit is provided',
      );
    }

    if (dto.coldRent === undefined) {
      return dto.depositMonths === undefined
        ? {}
        : { depositMonths: dto.depositMonths };
    }

    const deposit = this.calculateDeposit(dto.coldRent, depositMonths);
    this.assertDepositMatchesCalculation(dto.deposit, deposit);

    return { deposit, depositMonths };
  }

  buildUpdateDepositData(
    dto: UpdateListingDto,
    listing: Listing,
  ): Partial<
    Pick<Prisma.ListingUncheckedUpdateInput, 'deposit' | 'depositMonths'>
  > {
    const coldRent = dto.coldRent ?? listing.coldRent;
    const depositMonths = dto.depositMonths ?? listing.depositMonths;
    this.assertDepositMonthsAllowed(depositMonths);
    const touchesDepositFields =
      dto.coldRent !== undefined ||
      dto.depositMonths !== undefined ||
      dto.deposit !== undefined;

    if (!touchesDepositFields) {
      return {};
    }

    if (dto.deposit !== undefined && coldRent === null) {
      throw new BadRequestException(
        'coldRent is required when deposit is provided',
      );
    }

    if (coldRent === null) {
      return dto.depositMonths === undefined
        ? {}
        : { depositMonths: dto.depositMonths };
    }

    const deposit = this.calculateDeposit(coldRent, depositMonths);
    this.assertDepositMatchesCalculation(dto.deposit, deposit);

    return { deposit, depositMonths };
  }

  calculateDeposit(coldRent: number, depositMonths: number): number {
    return Math.round(coldRent * depositMonths * 100) / 100;
  }

  assertDepositMonthsAllowed(depositMonths: number): void {
    if (
      !Number.isInteger(depositMonths) ||
      depositMonths < MIN_DEPOSIT_MONTHS ||
      depositMonths > MAX_DEPOSIT_MONTHS
    ) {
      throw new BadRequestException('depositMonths must be 1, 2, or 3');
    }
  }

  assertDepositMatchesCalculation(
    providedDeposit: number | undefined,
    calculatedDeposit: number,
  ): void {
    if (providedDeposit === undefined) {
      return;
    }

    if (
      Math.abs(providedDeposit - calculatedDeposit) > DEPOSIT_AMOUNT_TOLERANCE
    ) {
      throw new BadRequestException(
        'deposit must equal coldRent multiplied by depositMonths',
      );
    }
  }

  stripEmptyValues<T extends Record<string, unknown>>(
    data: T,
    preserveNullKeys: readonly string[] = [],
  ): Partial<T> {
    return Object.fromEntries(
      Object.entries(data).filter(([key, value]) => {
        if (
          value === undefined ||
          (value === null && !preserveNullKeys.includes(key))
        ) {
          return false;
        }

        if (typeof value === 'string' && value.trim().length === 0) {
          return false;
        }

        return true;
      }),
    ) as Partial<T>;
  }

  assertBedroomsNotGreaterThanRooms(
    dto: CreateListingDto | UpdateListingDto,
  ): void {
    const { rooms, bedrooms } = dto;

    if (rooms === undefined || rooms === null) {
      return;
    }

    if (bedrooms === undefined || bedrooms === null) {
      return;
    }

    if (typeof rooms !== 'number' || typeof bedrooms !== 'number') {
      return;
    }

    if (bedrooms > rooms) {
      throw new BadRequestException('bedrooms must not be greater than rooms');
    }
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { ObjectType } from '../generated/prisma/enums';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import { ApplicantListingsController } from './applicant-listings.controller';
import { ListingsService } from './listings.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000002';

describe('ApplicantListingsController', () => {
  let controller: ApplicantListingsController;
  let listingsService: jest.Mocked<
    Pick<
      ListingsService,
      'findPublishedForApplicant' | 'findPublishedDetailForApplicant'
    >
  >;

  beforeEach(async () => {
    listingsService = {
      findPublishedForApplicant: jest.fn(),
      findPublishedDetailForApplicant: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantListingsController],
      providers: [{ provide: ListingsService, useValue: listingsService }],
    }).compile();

    controller = module.get<ApplicantListingsController>(
      ApplicantListingsController,
    );
  });

  it('keeps public listing routes free of authentication guards', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ApplicantListingsController),
    ).toBeUndefined();
  });

  describe('findAll', () => {
    it('returns a paginated list of published listings', async () => {
      const page = new ApplicantListingsPageDto([], null);
      listingsService.findPublishedForApplicant.mockResolvedValue(page);

      const result = await controller.findAll({});

      expect(listingsService.findPublishedForApplicant).toHaveBeenCalledWith(
        {},
      );
      expect(result).toBe(page);
    });

    it('passes query filters to the service', async () => {
      const page = new ApplicantListingsPageDto([], null);
      listingsService.findPublishedForApplicant.mockResolvedValue(page);

      await controller.findAll({ city: 'Berlin', minRent: 500 });

      expect(listingsService.findPublishedForApplicant).toHaveBeenCalledWith({
        city: 'Berlin',
        minRent: 500,
      });
    });
  });

  describe('findOne', () => {
    it('returns a published listing detail', async () => {
      const detail = new ApplicantListingDetailDto({
        id: LISTING_ID,
        title: 'Test',
        city: 'Berlin',
        zip: '10115',
        street: null,
        showExactAddress: false,
        objectType: ObjectType.APARTMENT,
        livingArea: 62,
        rooms: 2,
        bedrooms: 1,
        coldRent: 1200,
        additionalCosts: 250,
        deposit: 2400,
        depositMonths: 2,
        availableFrom: new Date('2026-09-01'),
        shortDescription: null,
        minimumHouseholdNetIncome: null,
        schufaRequired: false,
        incomeProofRequired: false,
        suitableForPeopleCount: null,
        petsPolicy: null,
        smokingPolicy: null,
        publishedAt: new Date('2026-07-01'),
        images: [],
      });
      listingsService.findPublishedDetailForApplicant.mockResolvedValue(detail);

      const result = await controller.findOne(LISTING_ID);

      expect(
        listingsService.findPublishedDetailForApplicant,
      ).toHaveBeenCalledWith(LISTING_ID);
      expect(result).toBe(detail);
    });
  });
});

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { ExtractListingTextDto } from './dto/extract-listing-text.dto';
import { ListingExtractionResponseDto } from './dto/listing-extraction-response.dto';
import {
  AUDIO_FILE_PIPE,
  LISTING_ASSISTANCE_AUDIO_MULTER_OPTIONS,
  LISTING_ASSISTANCE_FILE_FIELD,
  LISTING_ASSISTANCE_PDF_MULTER_OPTIONS,
  PDF_FILE_PIPE,
  isPdfFile,
  isAudioFile,
  type ListingAssistanceFile,
} from './listing-assistance-upload.constants';
import { ListingAssistanceService } from './listing-assistance.service';
import { ProviderAiThrottlerGuard } from './guards/provider-ai-throttler.guard';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard, ProviderAiThrottlerGuard)
@Controller('provider/listings/ai-extractions')
export class ListingAssistanceController {
  constructor(
    @Inject(ListingAssistanceService)
    private readonly listingAssistanceService: Pick<
      ListingAssistanceService,
      'extractFromText' | 'extractFromPdf' | 'extractFromAudio'
    >,
  ) {}

  @Post('text')
  @SkipThrottle({ aiPdf: true, aiAudio: true })
  @Throttle({ aiText: {} })
  async extractFromText(
    @Body() dto: ExtractListingTextDto,
  ): Promise<ListingExtractionResponseDto> {
    return this.listingAssistanceService.extractFromText(dto.text);
  }

  @Post('pdf')
  @SkipThrottle({ aiText: true, aiAudio: true })
  @Throttle({ aiPdf: {} })
  @UseInterceptors(
    FileInterceptor(
      LISTING_ASSISTANCE_FILE_FIELD,
      LISTING_ASSISTANCE_PDF_MULTER_OPTIONS,
    ),
  )
  async extractFromPdf(
    @UploadedFile(PDF_FILE_PIPE) file: ListingAssistanceFile,
  ): Promise<ListingExtractionResponseDto> {
    if (!isPdfFile(file)) {
      throw new BadRequestException('file must be a valid PDF');
    }

    return this.listingAssistanceService.extractFromPdf(file);
  }

  @Post('audio')
  @SkipThrottle({ aiText: true, aiPdf: true })
  @Throttle({ aiAudio: {} })
  @UseInterceptors(
    FileInterceptor(
      LISTING_ASSISTANCE_FILE_FIELD,
      LISTING_ASSISTANCE_AUDIO_MULTER_OPTIONS,
    ),
  )
  async extractFromAudio(
    @UploadedFile(AUDIO_FILE_PIPE) file: ListingAssistanceFile,
  ): Promise<ListingExtractionResponseDto> {
    if (!isAudioFile(file)) {
      throw new BadRequestException('file must be a valid audio file');
    }

    return this.listingAssistanceService.extractFromAudio(file);
  }
}

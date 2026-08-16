import { describe, expect, it } from '@jest/globals';
import {
  AUDIO_MAX_FILE_SIZE_BYTES,
  type ListingAssistanceFile,
  PDF_MAX_FILE_SIZE_BYTES,
  isPdfFile,
  isAudioFile,
} from './listing-assistance-upload.constants';

describe('listing assistance upload constants', () => {
  it('keeps the agreed application limits', () => {
    expect(PDF_MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(AUDIO_MAX_FILE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });

  it('requires an audio signature compatible with the declared MIME type', () => {
    expect(
      isAudioFile({
        originalname: 'listing.webm',
        mimetype: 'audio/webm',
        buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      }),
    ).toBe(true);
    expect(
      isAudioFile({
        originalname: 'listing.webm',
        mimetype: 'audio/webm',
        buffer: Buffer.from('not audio'),
      }),
    ).toBe(false);
  });

  it('requires the PDF file signature as well as the declared MIME type', () => {
    const file: ListingAssistanceFile = {
      originalname: 'listing.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    };

    expect(isPdfFile(file)).toBe(true);
    expect(isPdfFile({ ...file, buffer: Buffer.from('not a PDF') })).toBe(
      false,
    );
  });
});

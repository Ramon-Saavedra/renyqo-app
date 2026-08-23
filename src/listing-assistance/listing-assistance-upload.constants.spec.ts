import { describe, expect, it } from '@jest/globals';
import {
  AUDIO_MAX_FILE_SIZE_BYTES,
  type ListingAssistanceFile,
  PDF_MAX_FILE_SIZE_BYTES,
  isPdfFile,
  isAudioFile,
} from './listing-assistance-upload.constants';

function validWave(): Buffer {
  const buffer = Buffer.alloc(46);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(38, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(2, 40);
  return buffer;
}

describe('listing assistance upload constants', () => {
  it('keeps the agreed application limits', () => {
    expect(PDF_MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(AUDIO_MAX_FILE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });

  it.each([
    [
      'audio/webm',
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from([0x42, 0x82, 0x84]),
        Buffer.from('webm'),
        Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x83, 0x81, 0x02]),
        Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
        Buffer.alloc(16),
      ]),
    ],
    [
      'audio/mpeg',
      Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]),
    ],
    ['audio/wav', validWave()],
    [
      'audio/mp4',
      Buffer.concat([
        Buffer.from([0, 0, 0, 12]),
        Buffer.from('ftypM4A moovtraksounmdat'),
        Buffer.alloc(8),
      ]),
    ],
  ])('accepts a valid %s container signature', (mimetype, buffer) => {
    expect(
      isAudioFile({ originalname: 'listing.audio', mimetype, buffer }),
    ).toBe(true);
  });

  it('rejects audio whose content does not match its declared MIME type', () => {
    expect(
      isAudioFile({
        originalname: 'listing.webm',
        mimetype: 'audio/webm',
        buffer: Buffer.from('not audio'),
      }),
    ).toBe(false);
  });

  it('rejects metadata-only and truncated audio containers', () => {
    expect(
      isAudioFile({
        originalname: 'metadata.mp3',
        mimetype: 'audio/mpeg',
        buffer: Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0]),
      }),
    ).toBe(false);
    expect(
      isAudioFile({
        originalname: 'truncated.webm',
        mimetype: 'audio/webm',
        buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82]),
      }),
    ).toBe(false);
  });

  it('requires the PDF file signature as well as the declared MIME type', () => {
    const file: ListingAssistanceFile = {
      originalname: 'listing.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'),
    };

    expect(isPdfFile(file)).toBe(true);
    expect(isPdfFile({ ...file, buffer: Buffer.from('not a PDF') })).toBe(
      false,
    );
  });
});

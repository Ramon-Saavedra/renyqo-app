import {
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
} from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

export const LISTING_ASSISTANCE_FILE_FIELD = 'file';
export const PDF_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const AUDIO_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export interface ListingAssistanceFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

const PDF_MIME_TYPE = 'application/pdf';
const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/webm',
] as const;

export const LISTING_ASSISTANCE_PDF_MULTER_OPTIONS: MulterOptions = {
  storage: undefined,
  limits: { fileSize: PDF_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, file.mimetype === PDF_MIME_TYPE);
  },
};

export const LISTING_ASSISTANCE_AUDIO_MULTER_OPTIONS: MulterOptions = {
  storage: undefined,
  limits: { fileSize: AUDIO_MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, isSupportedAudioMimeType(file.mimetype));
  },
};

export const PDF_FILE_PIPE = new ParseFilePipe({
  validators: [
    new MaxFileSizeValidator({ maxSize: PDF_MAX_FILE_SIZE_BYTES }),
    new FileTypeValidator({ fileType: PDF_MIME_TYPE }),
  ],
});

export const AUDIO_FILE_PIPE = new ParseFilePipe({
  validators: [
    new MaxFileSizeValidator({ maxSize: AUDIO_MAX_FILE_SIZE_BYTES }),
  ],
});

export function isPdfFile(file: ListingAssistanceFile): boolean {
  return (
    file.mimetype === PDF_MIME_TYPE &&
    file.buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  );
}

export function isAudioFile(file: ListingAssistanceFile): boolean {
  const bytes = file.buffer;

  if (file.mimetype === 'audio/mpeg') {
    return (
      bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)
    );
  }

  if (file.mimetype === 'audio/wav') {
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    );
  }

  if (file.mimetype === 'audio/webm') {
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }

  if (file.mimetype === 'audio/mp4' || file.mimetype === 'audio/x-m4a') {
    return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  }

  return false;
}

function isSupportedAudioMimeType(
  mimetype: string,
): mimetype is (typeof AUDIO_MIME_TYPES)[number] {
  return AUDIO_MIME_TYPES.some((supportedType) => supportedType === mimetype);
}

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

const FILE_ONLY_MULTIPART_LIMITS = {
  files: 1,
  fields: 0,
  parts: 2,
  fieldNameSize: 50,
  headerPairs: 20,
};

export const LISTING_ASSISTANCE_PDF_MULTER_OPTIONS: MulterOptions = {
  storage: undefined,
  limits: {
    ...FILE_ONLY_MULTIPART_LIMITS,
    fileSize: PDF_MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_request, file, callback) => {
    callback(null, file.mimetype === PDF_MIME_TYPE);
  },
};

export const LISTING_ASSISTANCE_AUDIO_MULTER_OPTIONS: MulterOptions = {
  storage: undefined,
  limits: {
    ...FILE_ONLY_MULTIPART_LIMITS,
    fileSize: AUDIO_MAX_FILE_SIZE_BYTES,
  },
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
  if (file.mimetype !== PDF_MIME_TYPE || file.buffer.length < 12) return false;

  const header = file.buffer.subarray(0, 8).toString('ascii');
  const trailer = file.buffer
    .subarray(Math.max(0, file.buffer.length - 1024))
    .toString('ascii');

  return /^%PDF-\d\.\d/.test(header) && trailer.includes('%%EOF');
}

export function isAudioFile(file: ListingAssistanceFile): boolean {
  const bytes = file.buffer;

  if (file.mimetype === 'audio/mpeg') {
    return hasCompleteMpegFrame(bytes);
  }

  if (file.mimetype === 'audio/wav') {
    return hasWaveAudioData(bytes);
  }

  if (file.mimetype === 'audio/webm') {
    return (
      bytes.length >= 32 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      bytes.includes(Buffer.from([0x42, 0x82])) &&
      bytes.includes(Buffer.from('webm')) &&
      bytes.includes(Buffer.from([0x16, 0x54, 0xae, 0x6b])) &&
      bytes.includes(Buffer.from([0x83, 0x81, 0x02])) &&
      bytes.includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75]))
    );
  }

  if (file.mimetype === 'audio/mp4' || file.mimetype === 'audio/x-m4a') {
    return (
      bytes.length >= 32 &&
      bytes.readUInt32BE(0) >= 12 &&
      bytes.readUInt32BE(0) <= bytes.length &&
      bytes.subarray(4, 8).toString('ascii') === 'ftyp' &&
      bytes.includes(Buffer.from('moov'), 8) &&
      bytes.includes(Buffer.from('trak'), 8) &&
      bytes.includes(Buffer.from('soun'), 8) &&
      bytes.includes(Buffer.from('mdat'), 8)
    );
  }

  return false;
}

function hasCompleteMpegFrame(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.some((byte) => (byte & 0x80) !== 0)) return false;
    offset =
      10 +
      ((sizeBytes[0] & 0x7f) << 21) +
      ((sizeBytes[1] & 0x7f) << 14) +
      ((sizeBytes[2] & 0x7f) << 7) +
      (sizeBytes[3] & 0x7f);
  }

  const bitrateV1Layer3 = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const sampleRates = [44100, 48000, 32000];
  const maxOffset = Math.min(bytes.length - 4, offset + 4096);

  for (let index = offset; index <= maxOffset; index += 1) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    if (first !== 0xff || (second & 0xfe) !== 0xfa) continue;

    const bitrate = bitrateV1Layer3[third >> 4];
    const sampleRate = sampleRates[(third >> 2) & 0x03];
    if (!bitrate || !sampleRate) continue;

    const padding = (third >> 1) & 0x01;
    const frameLength =
      Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
    if (index + frameLength <= bytes.length) return true;
  }

  return false;
}

function hasWaveAudioData(bytes: Buffer): boolean {
  if (
    bytes.length < 46 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.readUInt32LE(4) + 8 > bytes.length ||
    bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return false;
  }

  let hasFormat = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.length) return false;

    if (chunkType === 'fmt ' && chunkSize >= 16) {
      hasFormat =
        bytes.readUInt16LE(dataOffset) > 0 &&
        bytes.readUInt16LE(dataOffset + 2) > 0 &&
        bytes.readUInt32LE(dataOffset + 4) > 0;
    }
    if (chunkType === 'data' && hasFormat && chunkSize > 0) return true;

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return false;
}

function isSupportedAudioMimeType(
  mimetype: string,
): mimetype is (typeof AUDIO_MIME_TYPES)[number] {
  return AUDIO_MIME_TYPES.some((supportedType) => supportedType === mimetype);
}

import 'dotenv/config';

process.env['OPENAI_API_KEY'] ??= 'e2e-openai-api-key';
process.env['OPENAI_LISTING_MODEL'] ??= 'e2e-listing-model';
process.env['OPENAI_TRANSCRIPTION_MODEL'] ??= 'e2e-transcription-model';
process.env['AI_RATE_LIMIT_WINDOW_MS'] ??= '60000';
process.env['AI_TEXT_RATE_LIMIT'] ??= '10';
process.env['AI_PDF_RATE_LIMIT'] ??= '3';
process.env['AI_AUDIO_RATE_LIMIT'] ??= '3';

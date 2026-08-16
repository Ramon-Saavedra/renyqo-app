export type ListingExtractionCandidate = Record<string, unknown>;

export interface AiProvider {
  extractFromText(text: string): Promise<ListingExtractionCandidate>;
  extractFromPdf(
    file: ListingAssistanceFile,
  ): Promise<ListingExtractionCandidate>;
  transcribeAudio(file: ListingAssistanceFile): Promise<string>;
}
import type { ListingAssistanceFile } from '../listing-assistance-upload.constants';

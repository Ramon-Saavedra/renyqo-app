export class SaveListingResponseDto {
  readonly saved!: boolean;
  readonly savedAt!: Date | null;

  constructor(saved: boolean, savedAt: Date | null) {
    this.saved = saved;
    this.savedAt = savedAt;
  }
}

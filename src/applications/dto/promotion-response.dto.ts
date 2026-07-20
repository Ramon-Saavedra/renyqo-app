export class PromotionResponseDto {
  readonly promotedCount: number;

  constructor(promotedCount: number) {
    this.promotedCount = promotedCount;
  }
}

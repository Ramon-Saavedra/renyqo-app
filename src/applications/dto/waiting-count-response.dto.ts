export class WaitingCountResponseDto {
  readonly waitingCount: number;

  constructor(waitingCount: number) {
    this.waitingCount = waitingCount;
  }
}

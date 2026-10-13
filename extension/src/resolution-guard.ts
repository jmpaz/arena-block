/** A source result may replace a draft only while its input and editor revision are unchanged. */
export class ResolutionGuard {
  private revision = 0;
  private serial = 0;
  changed(): void { this.revision++; }
  begin(): { revision: number; serial: number } { return { revision: this.revision, serial: ++this.serial }; }
  current(ticket: { revision: number; serial: number }): boolean {
    return ticket.revision === this.revision && ticket.serial === this.serial;
  }
}

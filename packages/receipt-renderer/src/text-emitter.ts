import type { TicketLayout } from '@brb/ticket-layout';
import { layoutToLines } from '@brb/ticket-layout';

/**
 * Plain-text rendering of a ticket, for snapshots, logs and the CLI.
 * Adds nothing of its own - the geometry lives in @brb/ticket-layout.
 */
export function emitText(layout: TicketLayout): string {
  return layoutToLines(layout).join('\n');
}

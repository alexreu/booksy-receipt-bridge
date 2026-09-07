/**
 * Native messaging host entry point.
 *
 * Phase 0 stub. The protocol lands in phase 4; this file exists so the app has a
 * real entry point and so the rule below is recorded before any code can break
 * it:
 *
 *   STDOUT BELONGS TO THE PROTOCOL.
 *
 * Chrome reads length-prefixed JSON from this process's stdout. A single stray
 * `console.log` corrupts the frame and the extension sees the host die with no
 * usable error. Diagnostics go to stderr or to a log file. The ESLint config
 * enforces `no-console` for this directory.
 */

process.stderr.write('booksy-receipt-bridge: phase 0 stub, no protocol yet\n');
process.exit(0);

/**
 * Decide whether this process is a native messaging host or a CLI invocation.
 *
 * WHY THIS IS NOT "any argument means CLI": a browser launches a native host
 * WITH arguments. Chrome passes the calling extension's origin, and on Windows
 * also `--parent-window=<handle>`. Treating those as a command made the host
 * print its usage and exit 2, which the extension saw as "Native host has
 * exited" - a failure no unit test caught, because a test spawns the host with
 * no arguments at all. It only showed up on a real browser launch.
 *
 * So messaging is the default for anything that does not name a known command,
 * and only a plausible typo gets the usage text.
 */

export const CLI_COMMANDS = [
  'ping',
  'status',
  'paths',
  'config',
  'parse',
  'ticket',
  'html',
  'escpos',
  '-h',
  '--help',
  '--version',
] as const;

export type HostMode = 'messaging' | 'cli' | 'usage';

/** Arguments a browser is known to hand a native messaging host. */
function isBrowserArgument(argument: string): boolean {
  return (
    argument.startsWith('chrome-extension://') ||
    argument.startsWith('moz-extension://') ||
    argument.startsWith('--parent-window')
  );
}

export function selectMode(argv: readonly string[]): HostMode {
  const first = argv[0];
  if (first === undefined) return 'messaging';
  if (isBrowserArgument(first)) return 'messaging';
  if ((CLI_COMMANDS as readonly string[]).includes(first)) return 'cli';
  // An unrecognised flag is far more likely to be a browser switch we have not
  // seen than a mistyped command, and guessing wrong here kills the host.
  if (first.startsWith('--')) return 'messaging';
  return 'usage';
}

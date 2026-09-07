/**
 * ESC/POS command bytes used by the emitter.
 *
 * Named rather than inlined because a wrong byte here prints garbage on paper
 * with no error anywhere, which is the hardest kind of bug to chase on a device
 * you cannot attach a debugger to.
 */
export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

/** ESC @ - reset to the power-on state. */
export const INIT = [ESC, 0x40] as const;

/** ESC t n - select character code table. */
export function selectCodePage(page: number): number[] {
  return [ESC, 0x74, page];
}

/** ESC a n - 0 left, 1 centre, 2 right. */
export function align(mode: 0 | 1 | 2): number[] {
  return [ESC, 0x61, mode];
}

/** ESC E n - emphasised on/off. */
export function bold(on: boolean): number[] {
  return [ESC, 0x45, on ? 1 : 0];
}

/**
 * GS ! n - character size. Multipliers are 1..8; the byte packs width in the
 * high nibble and height in the low nibble, each as (multiplier - 1).
 */
export function size(widthMultiplier: number, heightMultiplier: number): number[] {
  const clamp = (value: number): number => Math.min(8, Math.max(1, Math.trunc(value)));
  const width = clamp(widthMultiplier) - 1;
  const height = clamp(heightMultiplier) - 1;
  return [GS, 0x21, (width << 4) | height];
}

/** ESC d n - feed n lines. */
export function feed(lines: number): number[] {
  return [ESC, 0x64, Math.min(255, Math.max(0, Math.trunc(lines)))];
}

/**
 * GS V m n - cut. Function B (m = 66) feeds n dots first, so the cut lands past
 * the last printed row instead of through it.
 */
export function cut(feedDots = 0): number[] {
  return [GS, 0x56, 66, Math.min(255, Math.max(0, Math.trunc(feedDots)))];
}

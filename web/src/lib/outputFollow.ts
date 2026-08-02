const TERMINAL_FOLLOW_THRESHOLD = 160;

export function isTerminalNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < TERMINAL_FOLLOW_THRESHOLD;
}

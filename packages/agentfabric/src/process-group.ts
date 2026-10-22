/** Host-only process evidence. Only ESRCH establishes absence. */
export type ProcessGroupState = 'alive' | 'gone' | 'unknown';
export function probeProcessGroup(pgid: number): ProcessGroupState {
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || process.platform === 'win32') return 'unknown';
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';
  }
}

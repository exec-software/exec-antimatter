/**
 * A compact elapsed time for live UI labels. Seconds stay useful for short work,
 * then give way to minutes and hours before the label becomes an unreadable count.
 */
export function formatElapsedSeconds(value: number): string {
  const totalSeconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export const formatElapsedMilliseconds = (milliseconds: number): string =>
  formatElapsedSeconds(milliseconds / 1000);

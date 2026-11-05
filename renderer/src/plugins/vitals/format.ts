/** Units, as short as they can be and still unambiguous. */

export const bytes = (value: number, digits = 1): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const step = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** step;
  return `${scaled.toFixed(step === 0 ? 0 : scaled >= 100 ? 0 : digits)} ${units[step]}`;
};

export const rate = (bytesPerSecond: number): string => `${bytes(bytesPerSecond, 0)}/s`;

/**
 * "6.0 / 31.1 GB" rather than "6.0 GB / 31.1 GB". Repeating a unit that is the same on both
 * sides costs the width a label needs to stay readable, and says nothing.
 */
export function bytesPair(used: number, total: number): string {
  const unitOf = (value: string) => value.slice(value.indexOf(' ') + 1);
  const left = bytes(used);
  const right = bytes(total);
  return unitOf(left) === unitOf(right) ? `${left.slice(0, left.indexOf(' '))} / ${right}` : `${left} / ${right}`;
}

export const percent = (fraction: number, digits = 0): string =>
  `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(digits)}%`;

export const celsius = (value: number): string => `${Math.round(value)}°`;

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

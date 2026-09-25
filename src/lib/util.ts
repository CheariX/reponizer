import { GitError } from "./git";

/** Run `fn` over all items with at most `limit` concurrent executions, preserving order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** What "Copy Error" puts on the clipboard: the message plus git's full stderr, which the toast shortens to one line. */
export function errorDetails(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof GitError) || !error.stderr) return message;
  return `${message}\n\n$ git ${error.args.join(" ")}\n${error.stderr}`;
}

/**
 * A from/to transition for confirmation dialogs. Raycast centres alert text and offers no
 * alignment control, so each value gets a short line of its own with the arrow between them —
 * labelled prefixes would only push the values into an unreadable ragged block. Raycast also caps
 * the message at a few lines, so any lead sentence belongs in the alert title, not above the pair.
 */
export function describeTransition(from: string, to: string): string {
  return `${from}\n↓\n${to}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

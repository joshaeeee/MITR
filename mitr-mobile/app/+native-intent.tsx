export function redirectSystemPath({
  path,
  initial,
}: { path: string; initial: boolean }) {
  try {
    const normalized = (path ?? '').trim();
    if (!normalized) return '/';
    return normalized;
  } catch {
    return '/';
  }
}

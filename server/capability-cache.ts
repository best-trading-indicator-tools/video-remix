/** Share in-flight checks; start the cache lifetime only after a successful check. */
export function cacheCapability<T>(check: () => Promise<T>, ttlMs = 60_000, now = Date.now) {
  let pending: Promise<T> | undefined;
  let cached: { value: T; until: number } | undefined;
  return (): Promise<T> => {
    if (pending) return pending;
    if (cached && cached.until > now()) return Promise.resolve(cached.value);
    pending = Promise.resolve().then(check).then(value => {
      cached = { value, until: now() + ttlMs };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

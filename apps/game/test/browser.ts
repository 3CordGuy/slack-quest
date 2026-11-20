// Stand-ins for what a browser gives the client's code and Node does not.
// Not a test file itself.

/**
 * A localStorage or sessionStorage that lives in `kept`: pass a map of your own to look at what was saved,
 * or to start a test with something already there.
 */
export function memoryStorage(kept = new Map<string, string>()) {
  return {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
}

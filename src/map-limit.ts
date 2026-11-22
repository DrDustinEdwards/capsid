/**
 * Runs `fn` over `items` with at most `limit` in flight and returns the results in the items'
 * order. The tick's reads wait on GitHub and Cloudflare, not CPU, so one at a time would spend the
 * whole four-minute budget waiting. A throw from `fn` rejects, as in a plain loop; a caller that
 * must tolerate one failure catches inside `fn`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

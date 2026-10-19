// No imports: the explorer build loads this through ops-snapshot.ts (.github/workflows/explorer.yml).

/** The body as text, read no further than `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

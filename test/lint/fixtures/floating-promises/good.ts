async function work(): Promise<void> {}

export async function awaited(): Promise<void> {
  await work();
}

export function returned(): Promise<void> {
  return work();
}

export function handled(): void {
  work().catch(() => undefined);
}

export function ignoredOnPurpose(): void {
  void work();
}

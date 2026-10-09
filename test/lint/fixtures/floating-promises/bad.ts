async function work(): Promise<void> {}

// A promise started and dropped: a rejection here is lost.
export function bad(): void {
  work();
}

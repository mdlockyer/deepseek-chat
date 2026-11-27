/**
 * Domain-blind binary blob storage port owned by Tier 1 (The Spine).
 * Implemented by IndexedDB in the app shell and by `@deepseek-chat/test-support` in tests.
 */

export type BlobEntry = {
  readonly id: string
  readonly blob: Blob
}

export type BlobStore = {
  get(id: string): Promise<Blob | undefined>
  put(entries: readonly BlobEntry[]): Promise<void>
  delete(ids: readonly string[]): Promise<void>
  clear(): Promise<void>
  /** Atomically replaces every stored blob with `entries`. */
  replaceAll(entries: readonly BlobEntry[]): Promise<void>
}

/** Synchronous string storage that survives restarts (the app wires localStorage). */
export type KeyValueStore = {
  get(key: string): string | null
  /** `null` removes the key. */
  set(key: string, value: string | null): void
}

/** One secret held by the platform outside web storage (the desktop host's private file). */
export type SecretSlot = {
  load(): Promise<string | null>
  /** `null` deletes the secret. */
  save(value: string | null): Promise<void>
}

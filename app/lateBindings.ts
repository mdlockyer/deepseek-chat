/**
 * Functions of the conversations slice that slices created before it call (the browser stops a
 * reply; workspace files read stored files). Filled in when conversations is created, which
 * happens before the first render.
 */
export const late: {
  stopReply: (sessionId: string) => void
  loadFile: (fileId: string) => Promise<Blob | undefined>
} = {
  stopReply: () => {},
  loadFile: () => Promise.resolve(undefined),
}

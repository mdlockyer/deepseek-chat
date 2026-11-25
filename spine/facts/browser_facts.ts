/**
 * Facts produced by the built-in browser domain.
 * Producer: slices/browser.
 */

/** The user clicked "Take over" in the built-in browser to stop automated control for a session. Discrete. */
export type BrowserControlTakenOver = {
  readonly type: 'BrowserControlTakenOver'
  readonly sessionId: string
}

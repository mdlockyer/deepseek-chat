/**
 * Domain-blind HTTP transport. The app shell supplies the platform implementation (WebView
 * `fetch`, or the desktop host's fetch that bypasses CORS); slices own their endpoints, timeouts,
 * and error handling.
 */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

import { useEffect, useLayoutEffect } from 'react'

/** `useLayoutEffect` in the browser, `useEffect` on the server, where layout effects never run. */
export const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

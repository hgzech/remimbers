import { useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches, kept current as the window resizes.
 *
 * useSyncExternalStore rather than an effect plus state: it reads the right
 * value on the very first render, so a laptop never flashes the phone layout.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}

import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { onSnapshot } from 'firebase/firestore'
import { useAuth } from '../auth/AuthProvider'
import {
  DEFAULT_LANGUAGES,
  sanitizeLanguages,
  saveLanguages,
  settingsDocRef,
} from '../lib/settings'

/**
 * - loading:     we do not yet know whether this user has answered.
 * - needs-setup: the SERVER says there is no prefs doc. First run.
 * - ready:       we have languages to pin.
 */
type Status = 'loading' | 'needs-setup' | 'ready'

interface SettingsState {
  status: Status
  languages: string[]
  save: (languages: string[]) => Promise<void>
}

const Ctx = createContext<SettingsState | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [status, setStatus] = useState<Status>('loading')
  const [languages, setLanguages] = useState<string[]>(DEFAULT_LANGUAGES)

  useEffect(() => {
    // AuthGate only renders this tree once access is 'ok', so `user` is
    // non-null in practice. If sign-out ever nulls it, the whole subtree
    // unmounts and this state goes with it - no reset needed on the way out.
    if (!user) return

    return onSnapshot(settingsDocRef(user.uid), (snap) => {
      if (snap.exists()) {
        const stored = sanitizeLanguages(snap.data().languages)
        // An empty array can only mean the stored codes no longer exist in
        // LANGUAGES. Falling back beats sending `languages[]` with nothing in
        // it, which is auto-detect wearing a costume.
        setLanguages(stored.length ? stored : DEFAULT_LANGUAGES)
        setStatus('ready')
        return
      }

      // "Missing" from the offline cache is not the same claim as "missing".
      // With persistence on, the first snapshot after a cold start is a cache
      // miss for every document that exists, so trusting it would re-ask the
      // question on every launch. Wait for the server to confirm absence; the
      // allowlist read in AuthProvider already proved we can reach it.
      if (!snap.metadata.fromCache) setStatus('needs-setup')
    })
  }, [user])

  const value: SettingsState = {
    status,
    languages,
    save: async (next) => {
      if (!user) throw new Error('not signed in')
      // Optimistic: the snapshot will confirm, but with offline persistence
      // the server round-trip can outlive the screen that asked.
      setLanguages(sanitizeLanguages(next))
      setStatus('ready')
      await saveLanguages(user.uid, next)
    },
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}

/** The languages to pin on a transcription request. */
export function useLanguages(): string[] {
  return useSettings().languages
}

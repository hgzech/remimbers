import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { firebaseConfig } from './env'

export const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

/**
 * Offline persistence is not a nicety here - it is the reason capture can
 * complete without a network round trip. Writes queue locally and sync when
 * connectivity returns, so "speak -> captured" never waits on a server.
 *
 * Multi-tab manager avoids the classic "second tab silently loses persistence"
 * failure when you have the app open on desktop and phone-mirrored.
 */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
})

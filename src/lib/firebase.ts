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
 * We use a NAMED database, not '(default)'.
 *
 * The project has two: an accidental '(default)' in nam5 (created implicitly by
 * `firebase deploy` before anyone chose a region) and this one in europe-west3.
 * A Firestore database's location is permanent, so rather than live with US
 * round trips we point everything at the European one.
 *
 * The catch: SDKs and the CLI both assume '(default)' unless told otherwise.
 * If reads mysteriously return nothing, check that this id and the `database`
 * key in firebase.json still agree - they are the two places that must match.
 */
export const DATABASE_ID = 'remimbers'

/**
 * Offline persistence is not a nicety here - it is the reason capture can
 * complete without a network round trip. Writes queue locally and sync when
 * connectivity returns, so "speak -> captured" never waits on a server.
 *
 * Multi-tab manager avoids the classic "second tab silently loses persistence"
 * failure when the app is open on desktop and phone at once.
 */
export const db = initializeFirestore(
  app,
  {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  },
  DATABASE_ID,
)

/**
 * Typed access to build-time config, with a loud failure if something is
 * missing. A blank Firebase config fails deep inside the SDK with an opaque
 * error; better to say exactly which var is absent.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill it in ` +
        `(see README, "Configure Firebase").`,
    )
  }
  return value
}

export const firebaseConfig = {
  apiKey: required('VITE_FIREBASE_API_KEY', import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: required('VITE_FIREBASE_AUTH_DOMAIN', import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: required('VITE_FIREBASE_PROJECT_ID', import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: required('VITE_FIREBASE_APP_ID', import.meta.env.VITE_FIREBASE_APP_ID),
}

/** Base URL for Cloud Functions. Empty in Phase 0 - nothing calls it yet. */
export const functionsBaseUrl: string = import.meta.env.VITE_FUNCTIONS_BASE_URL ?? ''

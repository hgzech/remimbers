import { auth } from './firebase'
import { functionsBaseUrl } from './env'

/**
 * Call a Cloud Function with the signed-in user's ID token.
 *
 * Every endpoint verifies this token itself. CORS is a browser convention and
 * curl ignores it, so the allowlist in index.ts is a courtesy, not the guard
 * (DESIGN.md section 2.2).
 */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const user = auth.currentUser
  if (!user) throw new Error('not signed in')
  if (!functionsBaseUrl) {
    throw new Error('VITE_FUNCTIONS_BASE_URL is empty - deploy functions first')
  }

  const res = await fetch(`${functionsBaseUrl}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await user.getIdToken()}`,
    },
    body: JSON.stringify(body),
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${name} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json as T
}

/**
 * A console handle for iterating on the generation prompt (evals/run.js).
 *
 * This exposes nothing the signed-in user could not already do from devtools -
 * they hold the ID token either way - but it is a development affordance, not
 * a product feature. Delete it once the Phase 1 prompt has settled.
 */
declare global {
  interface Window {
    remimbers?: { callFunction: typeof callFunction }
  }
}

export function exposeDevHandle() {
  window.remimbers = { callFunction }
}

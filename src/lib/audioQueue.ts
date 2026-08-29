/**
 * Crash insurance for a recording, not an archive (DESIGN.md section 5.1).
 *
 * A blob lives here from the moment recording stops until transcription
 * succeeds, so a dropped signal or a killed tab doesn't silently lose the
 * capture. It is meant to drain in seconds - nothing here reads on a timer.
 */

const DB_NAME = 'remimbers-audio-queue'
const STORE = 'pending'

export interface QueuedAudio {
  id: string
  blob: Blob
  mimeType: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = run(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function enqueue(blob: Blob, mimeType: string): Promise<string> {
  const id = crypto.randomUUID()
  await withStore('readwrite', (store) => store.put({ id, blob, mimeType }))
  return id
}

export async function dequeue(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

export async function getPending(): Promise<QueuedAudio[]> {
  return withStore('readonly', (store) => store.getAll())
}

import { callFunction } from './functions'

/** Must match functions/src/realtime.ts - the model is fixed at token-mint time. */
export const REALTIME_MODEL = 'gpt-realtime-2.1'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

/** Ask the Function to mint a short-lived client secret. */
export async function mintToken(): Promise<string> {
  const { token } = await callFunction<{ token: string }>('realtimeToken', {})
  return token
}

export interface RealtimeSession {
  /** Send one JSON event over the `oai-events` data channel. */
  send(event: unknown): void
  /** Mute/unmute the outgoing mic track without tearing down the session. */
  setMuted(muted: boolean): void
  /** Stop the mic, close the data channel and the peer connection. */
  close(): void
}

/**
 * Open a WebRTC session against the OpenAI Realtime API.
 *
 * Deliberately minimal plumbing (DESIGN.md section 4.2): mic track out, a
 * remote audio track played back, one `oai-events` data channel for JSON
 * events both ways, one SDP exchange to establish the call. Everything about
 * what the session actually does - instructions, tools, turn detection - is
 * the caller's job, sent as a `session.update` once the handle is returned.
 */
export async function createRealtimeSession(
  token: string,
  onEvent: (event: any) => void,
): Promise<RealtimeSession> {
  const pc = new RTCPeerConnection()

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const micTrack = micStream.getAudioTracks()[0]
  pc.addTrack(micTrack, micStream)

  // The model's voice arrives as a remote track - play it as it comes in.
  const audioEl = new Audio()
  audioEl.autoplay = true
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0]
  }

  const channel = pc.createDataChannel('oai-events')
  const opened = new Promise<void>((resolve) => {
    channel.onopen = () => resolve()
  })
  channel.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data))
    } catch {
      // Not JSON - ignore rather than crash the session over one bad frame.
    }
  }

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const res = await fetch(CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    })

    if (!res.ok) {
      const detail = await res.text()
      throw new Error(`realtime call failed ${res.status}: ${detail.slice(0, 300)}`)
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    await opened
  } catch (err) {
    micTrack.stop()
    pc.close()
    throw err
  }

  return {
    send(event: unknown) {
      channel.send(JSON.stringify(event))
    },
    setMuted(muted: boolean) {
      micTrack.enabled = !muted
    },
    close() {
      micTrack.stop()
      channel.close()
      pc.close()
      audioEl.pause()
      audioEl.srcObject = null
    },
  }
}

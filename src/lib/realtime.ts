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
  /**
   * Resolve once the model has finished actually SPEAKING.
   *
   * Not the same thing as `response.done`, which only says the server finished
   * generating. WebRTC paces audio over RTP in real time, so a response the
   * model composed in a moment still takes its full spoken duration to arrive -
   * closing the connection on `response.done` cuts the sentence off. This
   * measures the remote track's actual level instead, which needs no reliance
   * on any particular server event.
   *
   * Waits for speech to start (up to `startTimeoutMs`), then for it to stay
   * quiet for `silenceMs` - 2s by default, which is forgiving enough that a
   * pause between sentences does not read as the end of the turn. Always
   * resolves - a timeout is a reason to close anyway, not an error.
   */
  waitForAudioIdle(opts?: {
    silenceMs?: number
    startTimeoutMs?: number
    maxMs?: number
  }): Promise<void>
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
  // Tapped by waitForAudioIdle to tell speech from silence. Set up lazily on
  // first use so a session that never needs it pays nothing.
  let analyser: AnalyserNode | null = null
  let remoteStream: MediaStream | null = null
  pc.ontrack = (e) => {
    remoteStream = e.streams[0]
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

  let audioCtx: AudioContext | null = null

  /** Current output level, 0..1, or null if the tap can't be set up. */
  function level(): number | null {
    if (!analyser) {
      if (!remoteStream) return null
      try {
        audioCtx = audioCtx ?? new AudioContext()
        // Deliberately not connected to the destination - audioEl already
        // plays this stream, and connecting again would double it.
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        audioCtx.createMediaStreamSource(remoteStream).connect(analyser)
      } catch {
        return null
      }
    }
    const buf = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(buf)
    // Peak deviation from the 128 midpoint - cheaper than RMS and enough to
    // separate speech from the near-flat line of silence.
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
    return peak / 128
  }

  return {
    send(event: unknown) {
      channel.send(JSON.stringify(event))
    },
    setMuted(muted: boolean) {
      micTrack.enabled = !muted
    },
    async waitForAudioIdle(opts) {
      const silenceMs = opts?.silenceMs ?? 2000
      const startTimeoutMs = opts?.startTimeoutMs ?? 4000
      const maxMs = opts?.maxMs ?? 30000
      const THRESHOLD = 0.02
      const TICK = 50

      await audioCtx?.resume().catch(() => {})

      const began = Date.now()
      const sleep = () => new Promise((r) => setTimeout(r, TICK))

      // If the level tap is unavailable, fall back to a flat wait rather than
      // returning at once and cutting the model off mid-word.
      if (level() === null) {
        await new Promise((r) => setTimeout(r, 2500))
        return
      }

      // Speech has to start before its stopping means anything.
      let started = false
      while (Date.now() - began < startTimeoutMs) {
        if ((level() ?? 0) > THRESHOLD) {
          started = true
          break
        }
        await sleep()
      }
      if (!started) return

      let quietSince: number | null = null
      while (Date.now() - began < maxMs) {
        if ((level() ?? 0) > THRESHOLD) {
          quietSince = null
        } else {
          quietSince = quietSince ?? Date.now()
          if (Date.now() - quietSince >= silenceMs) return
        }
        await sleep()
      }
    },
    close() {
      void audioCtx?.close().catch(() => {})
      micTrack.stop()
      channel.close()
      pc.close()
      audioEl.pause()
      audioEl.srcObject = null
    },
  }
}

// Records one push-to-talk clip from the microphone, in the bar window (it owns the mic through getUserMedia).
// The mic is opened when the key goes down and released when it comes up, so nothing listens in between.
// MediaRecorder captures; on stop the clip is decoded and resampled to 16 kHz mono PCM, which is what Whisper
// wants and what the main process hands to every provider (see shared/voice.ts).

import type { AudioClip } from '../shared/voice'

const TARGET_RATE = 16_000
/** Longest single recording; a stuck key shouldn't fill memory. */
export const MAX_RECORDING_MS = 120_000

/** A short sentence for the voice bar from a getUserMedia failure. */
export function micErrorMessage(e: unknown): string {
	const name = e instanceof DOMException || e instanceof Error ? e.name : ''
	if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'No microphone found. Plug one in and try again.'
	if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow it in Windows Settings > Privacy > Microphone.'
	if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app.'
	return "Couldn't use the microphone."
}

export type Recorder = {
	/** Opens the mic and starts recording. Rejects with the getUserMedia error. */
	start: () => Promise<void>
	/** Ends the recording and returns the clip, or null if nothing was recorded. */
	stop: () => Promise<AudioClip | null>
	/** Ends the recording and throws it away. */
	cancel: () => void
}

export function createRecorder({ onLimit }: { onLimit: () => void }): Recorder {
	let stream: MediaStream | null = null
	let recorder: MediaRecorder | null = null
	let chunks: Blob[] = []
	let limitTimer: ReturnType<typeof setTimeout> | null = null

	function release() {
		if (limitTimer != null) clearTimeout(limitTimer)
		limitTimer = null
		stream?.getTracks().forEach((t) => t.stop())
		stream = null
		recorder = null
	}

	async function toClip({ blob }: { blob: Blob }): Promise<AudioClip | null> {
		if (blob.size === 0) return null
		const ctx = new AudioContext()
		try {
			const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
			const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
			const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
			const source = offline.createBufferSource()
			source.buffer = decoded // downmixed to mono and resampled by the offline context
			source.connect(offline.destination)
			source.start()
			const rendered = await offline.startRendering()
			const floats = rendered.getChannelData(0)
			const pcm16 = new Int16Array(floats.length)
			for (let i = 0; i < floats.length; i++) pcm16[i] = Math.round(Math.max(-1, Math.min(1, floats[i] ?? 0)) * 32767)
			return { pcm16, sampleRate: TARGET_RATE }
		} finally {
			void ctx.close()
		}
	}

	return {
		async start() {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
			chunks = []
			recorder = new MediaRecorder(stream)
			recorder.ondataavailable = (e) => chunks.push(e.data)
			recorder.start()
			limitTimer = setTimeout(onLimit, MAX_RECORDING_MS)
		},
		stop() {
			const rec = recorder
			if (rec == null || rec.state === 'inactive') {
				release()
				return Promise.resolve(null)
			}
			return new Promise<AudioClip | null>((resolve, reject) => {
				rec.onstop = () => {
					const blob = new Blob(chunks, { type: rec.mimeType })
					chunks = []
					release()
					toClip({ blob }).then(resolve, reject)
				}
				rec.stop()
			})
		},
		cancel() {
			if (recorder != null && recorder.state !== 'inactive') recorder.onstop = null
			if (recorder != null && recorder.state !== 'inactive') recorder.stop()
			chunks = []
			release()
		},
	}
}

// Speaks a reply: cleans it for the ear, cuts it into sentences, and keeps the next sentence being
// synthesised while the current one plays. One reply at a time; a new one (or stop()) cuts the old one off.

import { isAbortError, toVoiceError, type VoiceError } from './errors'
import { cleanForSpeech, splitForSpeech } from './text'
import type { AudioPlayer, SynthTts } from './tts'

export type Speaker = {
	speak: (args: { text: string }) => Promise<void>
	stop: () => void
}

export function createSpeaker({
	getProvider,
	getVoice,
	player,
	onSpeaking,
	onError,
}: {
	getProvider: () => SynthTts
	getVoice: () => string | null
	player: AudioPlayer
	onSpeaking: (isSpeaking: boolean) => void
	onError: (error: VoiceError) => void
}): Speaker {
	let current: AbortController | null = null

	return {
		stop() {
			current?.abort()
		},
		async speak({ text }) {
			current?.abort()
			const spoken = cleanForSpeech({ text })
			if (spoken === '') return
			const controller = new AbortController()
			current = controller
			const { signal } = controller
			const provider = getProvider()
			const voice = getVoice()
			onSpeaking(true)
			try {
				const chunks = splitForSpeech({ text: spoken })
				const synth = (chunk: string) => {
					const p = provider.synthesize(chunk, { voice, signal })
					p.catch(() => {}) // surfaced when awaited; this only stops "unhandled rejection" if we stop first
					return p
				}
				let next = synth(chunks[0] ?? spoken)
				for (let i = 0; i < chunks.length; i++) {
					const wav = await next
					if (signal.aborted) return
					if (i + 1 < chunks.length) next = synth(chunks[i + 1] ?? '')
					await player.play({ wav, signal })
					if (signal.aborted) return
				}
			} catch (e) {
				if (!signal.aborted && !isAbortError(e)) onError(toVoiceError({ error: e, provider: provider.id }))
			} finally {
				// Only the newest reply clears the flag, so an old one finishing can't hide a newer one.
				if (current === controller) {
					current = null
					onSpeaking(false)
				}
			}
		},
	}
}

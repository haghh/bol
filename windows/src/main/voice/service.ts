// The voice service: picks the speech-to-text and text-to-speech provider named in settings (each call, so
// a change in Settings applies at once) and wraps them so failures come out as short messages.

import { join } from 'node:path'
import type { Settings } from '../../shared/settings'
import type { AudioClip, SpeechToText } from '../../shared/voice'
import type { KeyName } from '../../shared/voice-ipc'
import type { SecretStore } from '../secrets'
import type { Notice } from './download'
import { isAbortError, toVoiceError, VoiceError } from './errors'
import type { FetchFn } from './http'
import { createSpeaker, type Speaker } from './speaker'
import { createDeepgramStt, createOpenAiStt, createWhisperLocalStt } from './stt'
import { createElevenLabsTts, createOpenAiTts, createPiperTts, createWindowsTts, type AudioPlayer, type SynthTts } from './tts'
import { clipSeconds, isSilent } from './wav'

const PROVIDER_NAMES = { 'whisper-local': 'Whisper', openai: 'OpenAI', deepgram: 'Deepgram', windows: 'Windows', piper: 'Piper', elevenlabs: 'ElevenLabs', kokoro: 'Kokoro' }

export type VoiceService = {
	/** Text from one push-to-talk clip; '' when nothing was said. Throws VoiceError. */
	transcribe: (args: { clip: AudioClip; signal?: AbortSignal }) => Promise<string>
	listVoices: (args: { provider: Settings['voice']['tts'] }) => Promise<{ id: string; name: string }[]>
	speaker: Speaker
}

export function createVoiceService({
	root,
	getSettings,
	secrets,
	player,
	notice,
	onSpeaking,
	onError,
	fetchFn,
}: {
	root: string
	getSettings: () => Settings
	secrets: SecretStore
	player: AudioPlayer
	notice: Notice
	onSpeaking: (isSpeaking: boolean) => void
	onError: (error: VoiceError) => void
	fetchFn?: FetchFn
}): VoiceService {
	const getKey = (name: KeyName) => () => secrets.get({ name })

	function stt(): SpeechToText {
		const id = getSettings().voice.stt
		switch (id) {
			case 'whisper-local':
				return createWhisperLocalStt({ root, getModel: () => getSettings().whisperModel, notice, fetchFn })
			case 'openai':
				return createOpenAiStt({ getKey: getKey('openai'), fetchFn })
			case 'deepgram':
				return createDeepgramStt({ getKey: getKey('deepgram'), fetchFn })
		}
	}

	function tts(provider = getSettings().voice.tts): SynthTts {
		switch (provider) {
			case 'windows':
				return createWindowsTts({ player })
			case 'openai':
				return createOpenAiTts({ player, getKey: getKey('openai'), fetchFn })
			case 'elevenlabs':
				return createElevenLabsTts({ player, getKey: getKey('elevenlabs'), fetchFn })
			case 'piper':
				return createPiperTts({ player, root, notice, fetchFn })
			case 'kokoro':
				throw new VoiceError({ kind: 'setup', message: "Kokoro voices aren't available yet. Pick another voice in settings." })
		}
	}

	return {
		async transcribe({ clip, signal }) {
			if (clipSeconds({ clip }) < 0.3 || isSilent({ clip })) return ''
			const provider = stt()
			try {
				return await provider.transcribe(clip, { language: getSettings().language ?? undefined, signal })
			} catch (e) {
				if (isAbortError(e)) throw e
				throw toVoiceError({ error: e, provider: PROVIDER_NAMES[provider.id] })
			}
		},
		async listVoices({ provider }) {
			try {
				return await tts(provider).listVoices()
			} catch (e) {
				throw toVoiceError({ error: e, provider: PROVIDER_NAMES[provider] })
			}
		},
		speaker: createSpeaker({
			getProvider: () => tts(),
			getVoice: () => getSettings().voice.voiceName,
			player,
			onSpeaking,
			onError,
		}),
	}
}

export const defaultVoiceRoot = ({ bolDir }: { bolDir: string }) => join(bolDir, 'voice')

// What the voice bar and the main process say to each other about voice. The provider contracts are in
// voice.ts; this file is the plumbing and the option tables the Settings panel is drawn from.

import type { SttProviderId, TtsProviderId } from './voice'

/** API keys Bol can hold. Values never travel to the renderer, only whether one is set. */
export const KEY_NAMES = ['openai', 'deepgram', 'elevenlabs'] as const
export type KeyName = (typeof KEY_NAMES)[number]
export type KeyStatus = Record<KeyName, boolean>

export const KEY_LABELS: Record<KeyName, string> = { openai: 'OpenAI', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs' }

export type ProviderOption<Id extends string> = { id: Id; label: string; key: KeyName | null; hint: string }

export const STT_OPTIONS: ProviderOption<SttProviderId>[] = [
	{ id: 'whisper-local', label: 'Whisper (local, offline)', key: null, hint: 'Free. Downloads a model on first use.' },
	{ id: 'openai', label: 'OpenAI transcription', key: 'openai', hint: 'Needs an OpenAI API key.' },
	{ id: 'deepgram', label: 'Deepgram', key: 'deepgram', hint: 'Needs a Deepgram API key.' },
]

export const TTS_OPTIONS: ProviderOption<TtsProviderId>[] = [
	{ id: 'windows', label: 'Windows voices', key: null, hint: 'Free, built in, no setup.' },
	{ id: 'piper', label: 'Piper (local)', key: null, hint: 'Free. Downloads a voice on first use.' },
	{ id: 'openai', label: 'OpenAI voices', key: 'openai', hint: 'Needs an OpenAI API key.' },
	{ id: 'elevenlabs', label: 'ElevenLabs', key: 'elevenlabs', hint: 'Needs an ElevenLabs API key.' },
]

/** Push-to-talk, as the main process reports it to the bar. */
export type PushToTalk = 'start' | 'stop' | 'cancel'

/** Everything the main process pushes to the voice bar about voice, on one channel. */
export type VoiceEvent =
	| { type: 'ptt'; action: PushToTalk }
	| { type: 'speaking'; isSpeaking: boolean }
	/** A progress note, e.g. "Downloading the speech model". Not an error. */
	| { type: 'notice'; text: string }
	/** A short, human message: no mic, bad key, no network. */
	| { type: 'error'; text: string }
	/** Play this WAV and answer with `played` when it ends. */
	| { type: 'play'; id: number; wav: Uint8Array }
	| { type: 'stopPlayback' }

export type TranscribeReply = { ok: true; text: string } | { ok: false; error: string }
export type VoicesReply = { ok: true; voices: { id: string; name: string }[] } | { ok: false; error: string }
export type SimpleReply = { ok: true } | { ok: false; error: string }

// The voice layer's contracts. Not implemented yet (build step 3): the voice bar has a text box until then.
//
// Hearing runs in the renderer (the voice bar window owns the mic through getUserMedia). Push-to-talk:
// the main process tells the renderer when the hotkey goes down and up ('voice:start' / 'voice:stop' over
// the preload bridge); the renderer records, transcribes and sends the text as a normal `say` command.
//
// Speaking can run in either process; a provider says which. The voice bar mutes the mic while speaking
// (Settings.voice.muteMicWhileSpeaking) and calls stop() when the user interrupts.

import type { Settings } from './settings'

export type SttProviderId = Settings['voice']['stt']
export type TtsProviderId = Settings['voice']['tts']

/** 16 kHz mono PCM is what Whisper wants; providers that take other formats convert themselves. */
export type AudioClip = { pcm16: Int16Array; sampleRate: number }

export interface SpeechToText {
	readonly id: SttProviderId
	/** Turns one push-to-talk recording into text. Empty string when nothing was said. */
	transcribe(clip: AudioClip, options: { language?: string; signal?: AbortSignal }): Promise<string>
}

export interface TextToSpeech {
	readonly id: TtsProviderId
	/** Voices this provider offers, for Settings. */
	listVoices(): Promise<{ id: string; name: string }[]>
	/** Speaks `text`; resolves when it finishes or is stopped. `onLevel` drives the bar's output meter (0..1). */
	speak(text: string, options: { voice: string | null; signal?: AbortSignal; onLevel?: (level: number) => void }): Promise<void>
}

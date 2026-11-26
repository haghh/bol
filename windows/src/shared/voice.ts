// The voice layer's contracts (build step 3). The implementations are in src/main/voice.
//
// Hearing runs in the renderer (the voice bar window owns the mic through getUserMedia). Push-to-talk:
// the main process tells the renderer when the hotkey goes down and up (VoiceEvent 'ptt' in voice-ipc.ts);
// the renderer records and sends the clip to the main process, which runs the STT provider (so API keys never
// reach the renderer) and returns the text; the renderer sends it as a normal `say` command.
//
// Speaking also runs in the main process: a TTS provider makes a WAV and the voice bar plays it (see
// SynthTts in main/voice/tts.ts). The mic is only open while the hotkey is held, so it is never open while Bol
// speaks; pressing the hotkey during a reply stops it (Settings.voice.muteMicWhileSpeaking is therefore always
// satisfied). Esc and the hotkey interrupt a reply.

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

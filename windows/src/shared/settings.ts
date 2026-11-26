// Bol's settings, kept in ~/.bol/settings.json. Every field has a default, so a missing or partly
// broken file still loads; unknown fields are dropped. API keys do NOT live here (see main/secrets.ts).

import { z } from 'zod'

export const BACKENDS = ['claude-code', 'anthropic', 'openai', 'gemini'] as const
export const STT_PROVIDERS = ['whisper-local', 'openai', 'deepgram'] as const
export const TTS_PROVIDERS = ['windows', 'openai', 'elevenlabs', 'piper', 'kokoro'] as const

export const Settings = z.object({
	/** Electron accelerator for the voice bar. Hold it to talk (see main/voice); a tap opens the bar. */
	hotkey: z.string().catch('Alt+Space'),
	/** Which engine runs requests. Only claude-code exists so far; the others are the API-key engines. */
	backend: z.enum(BACKENDS).catch('claude-code'),
	/** Model override; null uses the backend's default. */
	model: z.string().nullable().catch(null),
	/** Reasoning effort. Never below medium, as in the original. */
	effort: z.enum(['medium', 'high', 'xhigh', 'max']).catch('medium'),
	/** Screen access: "auto" (the agent looks when needed) or "off" (no screenshot or control tools). */
	screen: z.enum(['auto', 'off']).catch('auto'),
	/** Pass --chrome to Claude Code so the Claude in Chrome tools load when the extension is installed. */
	chrome: z.boolean().catch(true),
	/** Folder the agent works in; null is ~/.bol/workspace. */
	workspace: z.string().nullable().catch(null),
	/** Path to claude.exe; null finds it (PATH, then the native installer's ~/.local/bin). */
	claudePath: z.string().nullable().catch(null),
	/** Spoken language for speech-to-text as an ISO 639-1 code ("en"); null detects it. */
	language: z
		.string()
		.regex(/^[a-z]{2,3}$/)
		.nullable()
		.catch(null),
	/** Size of the local Whisper model: bigger is more accurate and slower. */
	whisperModel: z.enum(['tiny', 'base', 'small']).catch('base'),
	/** Ask before each tool call. Off by default: Bol is hands-off. Not wired to the UI yet. */
	askFirst: z.boolean().catch(false),
	voice: z
		.object({
			stt: z.enum(STT_PROVIDERS).catch('whisper-local'),
			tts: z.enum(TTS_PROVIDERS).catch('windows'),
			/** Provider-specific voice name; null is the provider's default. */
			voiceName: z.string().nullable().catch(null),
			muteMicWhileSpeaking: z.boolean().catch(true),
			/** Speak replies aloud. Off is "silent mode": replies only show in the bar. */
			isSpeaking: z.boolean().catch(true),
		})
		.catch({ stt: 'whisper-local', tts: 'windows', voiceName: null, muteMicWhileSpeaking: true, isSpeaking: true }),
})
export type Settings = z.infer<typeof Settings>

export function parseSettings(value: unknown): Settings {
	return Settings.parse(value ?? {})
}

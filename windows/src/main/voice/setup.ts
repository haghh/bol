// Wires the voice layer into the Electron shell: the hold-to-talk key, the IPC the voice bar calls, audio
// playback in the bar window, and speaking each reply the brain gives. index.ts only has to call setupVoice.

import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { BrainEvent } from '../../shared/events'
import { parseSettings, TTS_PROVIDERS, type Settings } from '../../shared/settings'
import type { AudioClip } from '../../shared/voice'
import { KEY_NAMES, type KeyName, type SimpleReply, type TranscribeReply, type VoiceEvent, type VoicesReply } from '../../shared/voice-ipc'
import { BOL_DIR } from '../brain/constants'
import { log, onEvent } from '../brain/protocol'
import { createSecretStore } from '../secrets'
import { toVoiceError, VoiceError } from './errors'
import { parseHotkey } from './hotkey'
import { startPushToTalkHook, type PushToTalkHook } from './hotkey-host'
import { createVoiceService } from './service'
import type { AudioPlayer } from './tts'

/** A press shorter than this is a tap: it toggles the bar like the old shortcut did, instead of recording. */
const TAP_MS = 250
/** A clip longer than this isn't a request, it's a stuck key; stop it. Mirrors the renderer's limit. */
const MAX_CLIP_SAMPLES = 16_000 * 120

export type VoiceShell = {
	getSettings: () => Settings
	applySettings: (next: Settings) => Promise<void>
	getBar: () => BrowserWindow | null
	showBar: () => void
	hideBar: () => void
	/** The bar is on screen and has focus. */
	isBarActive: () => boolean
	resizeBar: (height: number) => void
}

export type VoiceSetup = {
	/** Starts hold-to-talk on `hotkey`. `onFallback` runs if that can't work and a plain shortcut is needed. */
	startPushToTalk: (args: { hotkey: string; onFallback: (reason: string) => void }) => void
	stopPushToTalk: () => void
	stopSpeaking: () => void
	close: () => void
}

export function setupVoice(shell: VoiceShell): VoiceSetup {
	const secrets = createSecretStore({
		file: join(BOL_DIR, 'secrets.json'),
		crypto: {
			isAvailable: () => safeStorage.isEncryptionAvailable(),
			encrypt: (text) => safeStorage.encryptString(text),
			decrypt: (data) => safeStorage.decryptString(data),
		},
	})

	const sendToBar = (event: VoiceEvent) => {
		const bar = shell.getBar()
		if (bar != null && !bar.isDestroyed()) bar.webContents.send('bol:voice', event)
	}
	const sendError = (error: VoiceError) => {
		log({ msg: `voice: ${error.kind}: ${error.message}` })
		sendToBar({ type: 'error', text: error.message })
	}

	// --- Playback happens in the bar window (Web Audio); this is the main-process side of it.
	let nextPlayId = 0
	const plays = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()
	const player: AudioPlayer = {
		play: ({ wav, signal }) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted === true) return resolve()
				const bar = shell.getBar()
				if (bar == null || bar.isDestroyed()) return reject(new VoiceError({ kind: 'failed', message: "Can't play audio: the voice bar isn't open." }))
				const id = ++nextPlayId
				const settle = <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => {
					if (!plays.delete(id)) return
					clearTimeout(timer)
					fn(...args)
				}
				const timer = setTimeout(() => settle(() => reject(new VoiceError({ kind: 'failed', message: 'Audio playback got stuck.' })))(), 5 * 60_000)
				plays.set(id, { resolve: settle(resolve), reject: settle(reject) })
				signal?.addEventListener('abort', () => {
					if (plays.has(id)) {
						sendToBar({ type: 'stopPlayback' })
						plays.get(id)?.resolve()
					}
				})
				sendToBar({ type: 'play', id, wav })
			}),
	}
	ipcMain.on('voice:played', (e, { id, error }: { id: number; error?: string }) => {
		if (e.sender !== shell.getBar()?.webContents) return
		const play = plays.get(id)
		if (error != null) play?.reject(new VoiceError({ kind: 'failed', message: "Couldn't play the voice. Is an audio output connected?" }))
		else play?.resolve()
	})

	const voice = createVoiceService({
		root: join(BOL_DIR, 'voice'),
		getSettings: shell.getSettings,
		secrets,
		player,
		notice: (text) => sendToBar({ type: 'notice', text }),
		onSpeaking: (isSpeaking) => sendToBar({ type: 'speaking', isSpeaking }),
		onError: sendError,
	})

	// --- Speak every finished reply (not errors, not interrupted turns), if speaking is on.
	const offEvents = onEvent((event: BrainEvent) => {
		if (event.type !== 'result' || event.isError || event.isInterrupted === true) return
		if (!shell.getSettings().voice.isSpeaking) return
		void voice.speaker.speak({ text: event.text })
	})

	// --- IPC from the bar. Every handler checks the sender is our bar window and never throws.
	const isFromBar = (e: Electron.IpcMainInvokeEvent) => e.sender === shell.getBar()?.webContents
	const fail = (e: unknown, provider = 'Voice'): { ok: false; error: string } => ({ ok: false, error: toVoiceError({ error: e, provider }).message })

	ipcMain.handle('voice:transcribe', async (e, clip: unknown): Promise<TranscribeReply> => {
		if (!isFromBar(e)) return { ok: false, error: 'Not allowed.' }
		const c = clip as Partial<AudioClip> | null
		if (!(c?.pcm16 instanceof Int16Array) || typeof c.sampleRate !== 'number' || c.pcm16.length > MAX_CLIP_SAMPLES) return { ok: false, error: "That recording couldn't be read." }
		try {
			return { ok: true, text: await voice.transcribe({ clip: { pcm16: c.pcm16, sampleRate: c.sampleRate } }) }
		} catch (err) {
			const error = toVoiceError({ error: err, provider: 'Voice' })
			log({ msg: `voice: transcribe: ${error.kind}: ${error.message}` })
			return { ok: false, error: error.message }
		}
	})
	ipcMain.handle('voice:stopSpeaking', (e) => {
		if (isFromBar(e)) voice.speaker.stop()
	})
	ipcMain.handle('voice:listVoices', async (e, provider: unknown): Promise<VoicesReply> => {
		if (!isFromBar(e) || !(TTS_PROVIDERS as readonly unknown[]).includes(provider)) return { ok: false, error: 'Not allowed.' }
		try {
			return { ok: true, voices: await voice.listVoices({ provider: provider as Settings['voice']['tts'] }) }
		} catch (err) {
			return fail(err)
		}
	})
	ipcMain.handle('voice:keyStatus', async (e) => (isFromBar(e) ? await secrets.has({ names: KEY_NAMES }) : {}))
	ipcMain.handle('voice:setKey', async (e, args: { name: unknown; value: unknown }): Promise<SimpleReply> => {
		if (!isFromBar(e) || !(KEY_NAMES as readonly unknown[]).includes(args.name) || (args.value != null && typeof args.value !== 'string')) return { ok: false, error: 'Not allowed.' }
		try {
			await secrets.set({ name: args.name as KeyName, value: (args.value as string | null) ?? null })
			return { ok: true }
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : "The key couldn't be saved." }
		}
	})
	ipcMain.handle('voice:saveSettings', async (e, patch: unknown): Promise<SimpleReply> => {
		if (!isFromBar(e) || patch == null || typeof patch !== 'object') return { ok: false, error: 'Not allowed.' }
		const { voice: voicePatch, language, whisperModel } = patch as Partial<Settings>
		const current = shell.getSettings()
		// Only the voice-related settings can be changed from the bar; parseSettings drops anything invalid.
		const next = parseSettings({ ...current, language: language === undefined ? current.language : language, whisperModel: whisperModel ?? current.whisperModel, voice: { ...current.voice, ...voicePatch } })
		try {
			await shell.applySettings(next)
			return { ok: true }
		} catch (err) {
			return fail(err)
		}
	})
	ipcMain.handle('voice:speakTest', async (e) => {
		if (isFromBar(e)) await voice.speaker.speak({ text: 'Hello, this is Bol. How do I sound?' })
	})
	ipcMain.on('voice:resize', (e, height: unknown) => {
		if (e.sender === shell.getBar()?.webContents && typeof height === 'number') shell.resizeBar(Math.round(Math.min(640, Math.max(200, height))))
	})

	// --- Hold-to-talk.
	let hook: PushToTalkHook | null = null
	let pressedAt = 0
	let wasBarActive = false
	let isRecording = false

	function onDown() {
		if (isRecording) return
		isRecording = true
		pressedAt = Date.now()
		wasBarActive = shell.isBarActive()
		voice.speaker.stop() // talking over the reply interrupts it
		shell.showBar()
		sendToBar({ type: 'ptt', action: 'start' })
	}

	function onUp() {
		if (!isRecording) return
		isRecording = false
		if (Date.now() - pressedAt < TAP_MS) {
			// A tap, not a hold: behave like the old shortcut (toggle the bar), and drop the recording.
			sendToBar({ type: 'ptt', action: 'cancel' })
			if (wasBarActive) shell.hideBar()
		} else {
			sendToBar({ type: 'ptt', action: 'stop' })
		}
	}

	return {
		startPushToTalk({ hotkey, onFallback }) {
			hook?.stop()
			hook = null
			const combo = parseHotkey({ accelerator: hotkey })
			if (combo == null) {
				log({ msg: `hold-to-talk needs a modifier and one key, like Alt+Space; "${hotkey}" isn't one` })
				return onFallback('unsupported shortcut')
			}
			hook = startPushToTalkHook({
				combo,
				onDown,
				onUp,
				onLog: (msg) => log({ msg }),
				onFailed: (reason) => {
					log({ msg: `hold-to-talk unavailable: ${reason}` })
					sendToBar({ type: 'error', text: "Hold-to-talk isn't available. Press the shortcut to open the bar instead." })
					onFallback(reason)
				},
			})
		},
		stopPushToTalk() {
			hook?.stop()
			hook = null
		},
		stopSpeaking: () => voice.speaker.stop(),
		close() {
			offEvents()
			hook?.stop()
			voice.speaker.stop()
			},
	}
}

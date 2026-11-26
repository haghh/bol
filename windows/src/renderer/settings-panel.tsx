// Voice settings, inside the bar: pick the speech-to-text and text-to-speech providers, a voice, and enter API
// keys. Keys go straight to the main process, which encrypts them with the OS (safeStorage); they are never
// shown again, only "Saved". Changes are saved as soon as they are made.

import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../shared/settings'
import { KEY_LABELS, KEY_NAMES, STT_OPTIONS, TTS_OPTIONS, type KeyName, type KeyStatus } from '../shared/voice-ipc'

type Voice = { id: string; name: string }

export function SettingsPanel({ settings, onDone }: { settings: Settings; onDone: () => void }) {
	const [voices, setVoices] = useState<Voice[]>([])
	const [voicesError, setVoicesError] = useState('')
	const [keys, setKeys] = useState<KeyStatus>({ openai: false, deepgram: false, elevenlabs: false, google: false })
	const [drafts, setDrafts] = useState<Partial<Record<KeyName, string>>>({})
	const [message, setMessage] = useState('')
	const { stt, tts, voiceName, isSpeaking } = settings.voice

	const refreshKeys = useCallback(() => void window.bol.voice.keyStatus().then(setKeys), [])
	useEffect(refreshKeys, [refreshKeys])

	// The voice list depends on the provider (and, for the paid ones, on whether its key is set).
	useEffect(() => {
		let isCurrent = true
		setVoices([])
		setVoicesError('')
		void window.bol.voice.listVoices(tts).then((reply) => {
			if (!isCurrent) return
			if (reply.ok) setVoices(reply.voices)
			else setVoicesError(reply.error)
		})
		return () => {
			isCurrent = false
		}
	}, [tts, keys])

	async function save(patch: Pick<Settings, 'voice' | 'language' | 'whisperModel'>) {
		const reply = await window.bol.voice.saveSettings(patch)
		setMessage(reply.ok ? '' : reply.error)
	}
	const saveVoice = (change: Partial<Settings['voice']>) => save({ voice: { ...settings.voice, ...change }, language: settings.language, whisperModel: settings.whisperModel })

	async function saveKey({ name, value }: { name: KeyName; value: string | null }) {
		const reply = await window.bol.voice.setKey(name, value)
		setMessage(reply.ok ? '' : reply.error)
		if (reply.ok) setDrafts((d) => ({ ...d, [name]: '' }))
		refreshKeys()
	}

	const needed = new Set<KeyName>([STT_OPTIONS.find((o) => o.id === stt)?.key, TTS_OPTIONS.find((o) => o.id === tts)?.key].filter((k): k is KeyName => k != null))

	return (
		<div className="panel">
			<label>
				Hearing
				<select value={stt} onChange={(e) => void saveVoice({ stt: e.target.value as Settings['voice']['stt'] })}>
					{STT_OPTIONS.map((o) => (
						<option key={o.id} value={o.id}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			{stt === 'whisper-local' && (
				<label>
					Whisper model
					<select value={settings.whisperModel} onChange={(e) => void save({ voice: settings.voice, language: settings.language, whisperModel: e.target.value as Settings['whisperModel'] })}>
						<option value="tiny">Tiny (fastest)</option>
						<option value="base">Base (balanced)</option>
						<option value="small">Small (most accurate)</option>
					</select>
				</label>
			)}
			<label>
				Language
				<input
					defaultValue={settings.language ?? ''}
					placeholder="auto (or en, es, fr…)"
					maxLength={3}
					spellCheck={false}
					onBlur={(e) => void save({ voice: settings.voice, whisperModel: settings.whisperModel, language: e.target.value.trim().toLowerCase() === '' ? null : e.target.value.trim().toLowerCase() })}
				/>
			</label>
			<label>
				Speaking
				<select value={tts} onChange={(e) => void saveVoice({ tts: e.target.value as Settings['voice']['tts'], voiceName: null })}>
					{TTS_OPTIONS.map((o) => (
						<option key={o.id} value={o.id}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			<label>
				Voice
				<select value={voiceName ?? ''} onChange={(e) => void saveVoice({ voiceName: e.target.value === '' ? null : e.target.value })}>
					<option value="">Default</option>
					{voices.map((v) => (
						<option key={v.id} value={v.id}>
							{v.name}
						</option>
					))}
				</select>
			</label>
			{voicesError !== '' && <div className="hint is-error">{voicesError}</div>}
			<label className="check">
				<input type="checkbox" checked={isSpeaking} onChange={(e) => void saveVoice({ isSpeaking: e.target.checked })} />
				Speak replies aloud
			</label>

			{KEY_NAMES.map((name) => (
				<div key={name} className={`keyrow ${needed.has(name) ? 'is-needed' : ''}`}>
					<span className="keyname">{KEY_LABELS[name]} key</span>
					<input
						type="password"
						value={drafts[name] ?? ''}
						placeholder={keys[name] ? 'Saved. Paste to replace' : 'Paste API key'}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
					/>
					<button disabled={(drafts[name] ?? '').trim() === ''} onClick={() => void saveKey({ name, value: drafts[name] ?? '' })}>
						Save
					</button>
					{keys[name] && <button onClick={() => void saveKey({ name, value: null })}>Remove</button>}
				</div>
			))}

			{message !== '' && <div className="hint is-error">{message}</div>}
			<div className="buttons">
				<button onClick={() => void window.bol.voice.speakTest()}>Test voice</button>
				<button className="primary" onClick={onDone}>
					Done
				</button>
			</div>
		</div>
	)
}

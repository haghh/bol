// The voice bar: Bol's one window. It follows the original's HUD (src/swift/hud/hud.swift upstream):
// a floating pill at the bottom of the screen that shows what you asked, what Bol is doing, and its reply.
// Hold the hotkey to talk (listening), release to send (thinking), and the reply is read aloud (speaking).
// You can still type into it.

import { useEffect, useReducer, useRef, useState } from 'react'
import type { BrainEvent } from '../shared/events'
import type { Settings } from '../shared/settings'
import type { VoiceEvent } from '../shared/voice-ipc'
import type { ApprovalRequest } from '../preload/index'
import { createRecorder, micErrorMessage, type Recorder } from './audio-capture'
import { createPlayer, type Player } from './audio-player'
import { SettingsPanel } from './settings-panel'

type Phase = 'input' | 'thinking' | 'looking' | 'replied' | 'error' | 'approval' | 'starting'
type VoicePhase = 'idle' | 'listening' | 'transcribing'

type State = {
	phase: Phase
	/** What you asked, shown above the reply. */
	request: string
	/** The reply, error, or the current step's text. */
	text: string
	/** The current step ("Running: list files"). */
	activity: string
	steps: number
	startedAt: number
	approval: ApprovalRequest | null
	/** The latest `say` sequence number, so a stale `idle` is ignored. */
	seq: number
	/** Push-to-talk: recording, or turning the recording into text. */
	voice: VoicePhase
	/** The reply is being read aloud. */
	isSpeaking: boolean
	/** A progress note from the voice layer, e.g. a model download. */
	notice: string
}

type Action =
	| { type: 'asked'; request: string; seq: number }
	| { type: 'event'; event: BrainEvent }
	| { type: 'show' }
	| { type: 'approval'; request: ApprovalRequest | null }
	| { type: 'status'; isReady: boolean; error: string | null }
	| { type: 'voice'; voice: VoicePhase }
	| { type: 'speaking'; isSpeaking: boolean }
	| { type: 'voiceError'; text: string }
	| { type: 'notice'; text: string }

const initial: State = {
	phase: 'starting',
	request: '',
	text: '',
	activity: '',
	steps: 0,
	startedAt: 0,
	approval: null,
	seq: 0,
	voice: 'idle',
	isSpeaking: false,
	notice: '',
}

/** "mcp__bol__left_click" → "left click"; "Bash" → "Bash". */
function toolLabel(name: string): string {
	return name.replace(/^mcp__bol__/, '').replace(/^mcp__([^_]+)__/, '$1: ').replace(/_/g, ' ')
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'asked':
			return { ...state, phase: 'thinking', voice: 'idle', notice: '', request: action.request, text: '', activity: 'Thinking', steps: 0, startedAt: Date.now(), seq: action.seq }
		case 'voice': {
			const isWorking = state.phase === 'thinking' || state.phase === 'looking' || state.phase === 'approval'
			if (action.voice === 'idle') return { ...state, voice: 'idle', notice: '' }
			// Starting to listen clears the last reply, unless the brain is mid-task and that text is its progress.
			return { ...state, voice: action.voice, notice: '', phase: isWorking ? state.phase : 'input', text: isWorking ? state.text : '', activity: action.voice === 'transcribing' ? 'Transcribing' : state.activity }
		}
		case 'speaking':
			return { ...state, isSpeaking: action.isSpeaking }
		case 'voiceError':
			return { ...state, voice: 'idle', phase: 'error', text: action.text, activity: '', notice: '' }
		case 'notice':
			return { ...state, notice: action.text }
		case 'show':
			return state.phase === 'thinking' || state.phase === 'looking' || state.phase === 'approval' || state.phase === 'starting'
				? state
				: { ...state, phase: 'input' }
		case 'approval':
			return action.request == null
				? { ...state, approval: null, phase: 'thinking' }
				: { ...state, approval: action.request, phase: 'approval' }
		case 'status':
			if (action.error != null) return { ...state, phase: 'error', text: action.error }
			return action.isReady && state.phase === 'starting' ? { ...state, phase: 'input' } : state
		case 'event': {
			const e = action.event
			switch (e.type) {
				case 'ready':
					return state.phase === 'starting' ? { ...state, phase: 'input' } : state
				case 'tool':
					if (e.job != null) return state
					return { ...state, phase: state.phase === 'approval' ? 'approval' : 'thinking', activity: e.summary === '' ? toolLabel(e.name) : `${toolLabel(e.name)}: ${e.summary}`, steps: state.steps + 1 }
				case 'screen':
					return e.job != null ? state : { ...state, phase: 'looking', activity: e.reason }
				case 'blocked':
					return { ...state, activity: `Blocked for safety: ${e.reason}` }
				case 'result':
					if (e.isInterrupted) return { ...state, phase: 'input', text: '', activity: '' }
					if (e.job != null) return { ...state, phase: e.isError ? 'error' : 'replied', request: 'Task finished', text: e.text }
					return { ...state, phase: e.isError ? 'error' : 'replied', text: e.text, activity: '' }
				default:
					return state
			}
		}
	}
}

function useElapsed(since: number, isRunning: boolean): string {
	const [, tick] = useState(0)
	useEffect(() => {
		if (!isRunning) return
		const timer = setInterval(() => tick((n) => n + 1), 1000)
		return () => clearInterval(timer)
	}, [isRunning])
	const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const SETTINGS_HEIGHT = 520
const BAR_HEIGHT = 200

export function VoiceBar() {
	const [state, dispatch] = useReducer(reducer, initial)
	const [draft, setDraft] = useState('')
	const [isHovering, setIsHovering] = useState(false)
	const [isSettingsOpen, setIsSettingsOpen] = useState(false)
	const [settings, setSettings] = useState<Settings | null>(null)
	const [level, setLevel] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)
	const stateRef = useRef(state)
	stateRef.current = state
	const isBusy = state.phase === 'thinking' || state.phase === 'looking' || state.voice === 'transcribing'
	const isVoiceActive = state.voice !== 'idle' || state.isSpeaking
	const elapsed = useElapsed(state.startedAt, isBusy)

	/** Hiding the bar also stops the reply being read aloud. */
	function hide() {
		void window.bol.voice.stopSpeaking()
		window.bol.hide()
	}

	async function ask({ text }: { text: string }) {
		const reply = await window.bol.send({ type: 'say', text })
		dispatch({ type: 'asked', request: text, seq: reply.seq ?? 0 })
	}

	useEffect(() => {
		const offs = [
			window.bol.onEvent((event) => dispatch({ type: 'event', event })),
			window.bol.onShow(() => {
				dispatch({ type: 'show' })
				setTimeout(() => inputRef.current?.focus(), 0)
			}),
			window.bol.onApproval((request) => dispatch({ type: 'approval', request })),
			window.bol.onSettings(setSettings),
		]
		void window.bol.status().then((s) => dispatch({ type: 'status', isReady: s.isReady, error: s.error }))
		void window.bol.settings().then(setSettings)
		return () => offs.forEach((off) => off())
	}, [])

	// Push-to-talk and spoken replies. The main process says when the key goes down and up and what to play.
	const recorderRef = useRef<Recorder | null>(null)
	const abandonRef = useRef<() => void>(() => {})
	const playerRef = useRef<Player | null>(null)
	useEffect(() => {
		let isHeld = false
		let isOpening = false
		/** A stop or cancel that arrived while the mic was still opening. */
		let pending: 'stop' | 'cancel' | null = null

		const recorder = createRecorder({ onLimit: () => void finish() })
		const player = createPlayer({ onLevel: setLevel })
		recorderRef.current = recorder
		abandonRef.current = abandon
		playerRef.current = player

		async function begin() {
			if (isHeld) return
			isHeld = true
			isOpening = true
			pending = null
			try {
				await recorder.start()
			} catch (e) {
				isHeld = false
				isOpening = false
				dispatch({ type: 'voiceError', text: micErrorMessage(e) })
				return
			}
			isOpening = false
			if (pending === 'cancel') return abandon()
			dispatch({ type: 'voice', voice: 'listening' })
			if (pending === 'stop') await finish()
		}

		function abandon() {
			isHeld = false
			recorder.cancel()
			dispatch({ type: 'voice', voice: 'idle' })
		}

		async function finish() {
			if (!isHeld) return
			if (isOpening) {
				pending = 'stop'
				return
			}
			isHeld = false
			dispatch({ type: 'voice', voice: 'transcribing' })
			try {
				const clip = await recorder.stop()
				if (clip == null) return dispatch({ type: 'voiceError', text: "Didn't catch that. Hold the keys and speak." })
				const reply = await window.bol.voice.transcribe(clip)
				if (!reply.ok) return dispatch({ type: 'voiceError', text: reply.error })
				if (reply.text === '') return dispatch({ type: 'voiceError', text: "Didn't catch that. Hold the keys and speak." })
				await ask({ text: reply.text })
			} catch {
				dispatch({ type: 'voiceError', text: "Couldn't process that recording." })
			}
		}

		const handle = (event: VoiceEvent) => {
			switch (event.type) {
				case 'ptt':
					if (event.action === 'start') void begin()
					else if (event.action === 'stop') void finish()
					else if (isOpening) pending = 'cancel'
					else if (isHeld) abandon()
					return
				case 'speaking':
					dispatch({ type: 'speaking', isSpeaking: event.isSpeaking })
					if (!event.isSpeaking) setLevel(0)
					return
				case 'notice':
					return dispatch({ type: 'notice', text: event.text })
				case 'error':
					return dispatch({ type: 'voiceError', text: event.text })
				case 'play':
					player.play({ wav: event.wav }).then(
						() => window.bol.voice.played(event.id),
						(e: unknown) => window.bol.voice.played(event.id, e instanceof Error ? e.message : 'failed'),
					)
					return
				case 'stopPlayback':
					return player.stop()
			}
		}
		const off = window.bol.voice.onEvent(handle)
		return () => {
			off()
			recorder.cancel()
			player.stop()
		}
	}, [])

	// Replies hide on their own after a while, unless the pointer is on the bar (as in the original) or it is still talking.
	useEffect(() => {
		if ((state.phase !== 'replied' && state.phase !== 'error') || isHovering || isVoiceActive || isSettingsOpen) return
		const words = state.text.split(/\s+/).length
		const timer = setTimeout(() => window.bol.hide(), Math.min(30_000, 6_000 + words * 300))
		return () => clearTimeout(timer)
	}, [state.phase, state.text, isHovering, isVoiceActive, isSettingsOpen])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			const s = stateRef.current
			if (s.voice === 'listening') {
				abandonRef.current()
			} else if (s.isSpeaking) void window.bol.voice.stopSpeaking()
			else if (isSettingsOpen) closeSettings()
			else if (isBusy) void window.bol.send({ type: 'interrupt' })
			else window.bol.hide()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	})

	function openSettings() {
		setIsSettingsOpen(true)
		window.bol.voice.resize(SETTINGS_HEIGHT)
	}

	function closeSettings() {
		setIsSettingsOpen(false)
		window.bol.voice.resize(BAR_HEIGHT)
	}

	async function submit() {
		const text = draft.trim()
		if (text === '') return
		setDraft('')
		await ask({ text })
	}

	function answer(isAllowed: boolean) {
		if (state.approval == null) return
		window.bol.approve(state.approval.id, isAllowed)
		dispatch({ type: 'approval', request: null })
	}

	const label: Record<Phase, string> = {
		starting: 'Starting',
		input: 'Ask Bol',
		thinking: 'Thinking',
		looking: 'Looking',
		replied: 'Bol',
		error: 'Problem',
		approval: 'Allow this?',
	}
	const title = isSettingsOpen
		? 'Voice settings'
		: state.voice === 'listening'
			? 'Listening'
			: state.voice === 'transcribing'
				? 'Thinking'
				: state.isSpeaking
					? 'Speaking'
					: label[state.phase]
	const orbClass = state.voice === 'listening' ? 'is-listening' : isBusy ? 'is-busy' : state.isSpeaking ? 'is-speaking' : ''

	return (
		<div className="stage">
			<div
				className={`bar phase-${state.phase} ${isSettingsOpen ? 'is-settings' : ''}`}
				onMouseEnter={() => setIsHovering(true)}
				onMouseLeave={() => setIsHovering(false)}
			>
				<div className="header">
					<span className={`orb ${orbClass}`} style={state.isSpeaking ? { transform: `scale(${1 + level * 0.9})` } : undefined} aria-hidden />
					<span className="status">{title}</span>
					{isBusy && !isSettingsOpen && (
						<span className="meta">
							{state.steps > 0 ? `${state.steps} step${state.steps === 1 ? '' : 's'} · ` : ''}
							{elapsed}
						</span>
					)}
					{state.isSpeaking && !isSettingsOpen && <span className="meta">Esc to stop</span>}
					<button className="gear" onClick={isSettingsOpen ? closeSettings : openSettings} aria-label="Voice settings" title="Voice settings">
						⚙
					</button>
					<button className="close" onClick={hide} aria-label="Hide">
						×
					</button>
				</div>

				{isSettingsOpen && settings != null ? (
					<SettingsPanel settings={settings} onDone={closeSettings} />
				) : (
					<>
						{state.request !== '' && state.phase !== 'input' && state.phase !== 'starting' && <div className="context">{state.request}</div>}

						{(state.phase === 'input' || state.phase === 'replied' || state.phase === 'error') && state.text !== '' && (
							<div className={`reply ${state.phase === 'error' ? 'is-error' : ''}`}>{state.text}</div>
						)}

						{state.voice === 'listening' && <div className="activity">Release to send</div>}
						{state.notice !== '' && <div className="activity">{state.notice}</div>}
						{isBusy && state.notice === '' && <div className="activity">{state.activity}</div>}

						{state.phase === 'approval' && state.approval != null && (
							<div className="approval">
								<div className="activity">
									{toolLabel(state.approval.tool)}
									{state.approval.summary === '' ? '' : `: ${state.approval.summary}`}
								</div>
								<div className="buttons">
									<button onClick={() => answer(false)}>Deny</button>
									<button className="primary" onClick={() => answer(true)} autoFocus>
										Allow
									</button>
								</div>
							</div>
						)}

						{state.phase !== 'approval' && state.phase !== 'starting' && (
							<form
								className="ask"
								onSubmit={(e) => {
									e.preventDefault()
									void submit()
								}}
							>
								<input
									ref={inputRef}
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									placeholder={isBusy ? 'Add to the request, or Esc to stop' : 'Hold the hotkey to talk, or type and press Enter'}
									autoFocus
									spellCheck={false}
								/>
							</form>
						)}
					</>
				)}
			</div>
		</div>
	)
}

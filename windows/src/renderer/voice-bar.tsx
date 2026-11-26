// The voice bar: Bol's one window. It follows the original's HUD (src/swift/hud/hud.swift upstream):
// a floating pill at the bottom of the screen that shows what you asked, what Bol is doing, and its reply.
// Until the voice step lands, you type into it.

import { useEffect, useReducer, useRef, useState } from 'react'
import type { BrainEvent } from '../shared/events'
import type { ApprovalRequest } from '../preload/index'

type Phase = 'input' | 'thinking' | 'looking' | 'replied' | 'error' | 'approval' | 'starting'

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
}

type Action =
	| { type: 'asked'; request: string; seq: number }
	| { type: 'event'; event: BrainEvent }
	| { type: 'show' }
	| { type: 'approval'; request: ApprovalRequest | null }
	| { type: 'status'; isReady: boolean; error: string | null }

const initial: State = {
	phase: 'starting',
	request: '',
	text: '',
	activity: '',
	steps: 0,
	startedAt: 0,
	approval: null,
	seq: 0,
}

/** "mcp__bol__left_click" → "left click"; "Bash" → "Bash". */
function toolLabel(name: string): string {
	return name.replace(/^mcp__bol__/, '').replace(/^mcp__([^_]+)__/, '$1: ').replace(/_/g, ' ')
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'asked':
			return { ...state, phase: 'thinking', request: action.request, text: '', activity: 'Thinking', steps: 0, startedAt: Date.now(), seq: action.seq }
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

export function VoiceBar() {
	const [state, dispatch] = useReducer(reducer, initial)
	const [draft, setDraft] = useState('')
	const [isHovering, setIsHovering] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const isBusy = state.phase === 'thinking' || state.phase === 'looking'
	const elapsed = useElapsed(state.startedAt, isBusy)

	useEffect(() => {
		const offs = [
			window.bol.onEvent((event) => dispatch({ type: 'event', event })),
			window.bol.onShow(() => {
				dispatch({ type: 'show' })
				setTimeout(() => inputRef.current?.focus(), 0)
			}),
			window.bol.onApproval((request) => dispatch({ type: 'approval', request })),
		]
		void window.bol.status().then((s) => dispatch({ type: 'status', isReady: s.isReady, error: s.error }))
		return () => offs.forEach((off) => off())
	}, [])

	// Replies hide on their own after a while, unless the pointer is on the bar (as in the original).
	useEffect(() => {
		if ((state.phase !== 'replied' && state.phase !== 'error') || isHovering) return
		const words = state.text.split(/\s+/).length
		const timer = setTimeout(() => window.bol.hide(), Math.min(30_000, 6_000 + words * 300))
		return () => clearTimeout(timer)
	}, [state.phase, state.text, isHovering])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			if (isBusy) void window.bol.send({ type: 'interrupt' })
			else window.bol.hide()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [isBusy])

	async function submit() {
		const text = draft.trim()
		if (text === '') return
		setDraft('')
		const reply = await window.bol.send({ type: 'say', text })
		dispatch({ type: 'asked', request: text, seq: reply.seq ?? 0 })
	}

	function answer(isAllowed: boolean) {
		if (state.approval == null) return
		window.bol.approve(state.approval.id, isAllowed)
		dispatch({ type: 'approval', request: null })
	}

	const label: Record<Phase, string> = {
		starting: 'Starting',
		input: 'Ask Bol',
		thinking: 'Working',
		looking: 'Looking',
		replied: 'Bol',
		error: 'Problem',
		approval: 'Allow this?',
	}

	return (
		<div className="stage">
			<div
				className={`bar phase-${state.phase}`}
				onMouseEnter={() => setIsHovering(true)}
				onMouseLeave={() => setIsHovering(false)}
			>
				<div className="header">
					<span className={`orb ${isBusy ? 'is-busy' : ''}`} aria-hidden />
					<span className="status">{label[state.phase]}</span>
					{isBusy && (
						<span className="meta">
							{state.steps > 0 ? `${state.steps} step${state.steps === 1 ? '' : 's'} · ` : ''}
							{elapsed}
						</span>
					)}
					<button className="close" onClick={() => window.bol.hide()} aria-label="Hide">
						×
					</button>
				</div>

				{state.request !== '' && state.phase !== 'input' && state.phase !== 'starting' && (
					<div className="context">{state.request}</div>
				)}

				{(state.phase === 'input' || state.phase === 'replied' || state.phase === 'error') && state.text !== '' && (
					<div className={`reply ${state.phase === 'error' ? 'is-error' : ''}`}>{state.text}</div>
				)}

				{isBusy && <div className="activity">{state.activity}</div>}

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
							placeholder={isBusy ? 'Add to the request, or Esc to stop' : 'Type a request and press Enter'}
							autoFocus
							spellCheck={false}
						/>
					</form>
				)}
			</div>
		</div>
	)
}

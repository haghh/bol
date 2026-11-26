// The brain's events. On macOS these went to the Swift app as JSON lines on stdout; here the brain runs
// inside the Electron main process (or the text CLI), so they go through an in-process bus instead.
// The event shapes are unchanged: see src/shared/events.ts.

import { EventEmitter } from 'node:events'
import type { BrainEvent } from '../../shared/events'

export const bus = new EventEmitter()

export function emit(obj: BrainEvent) {
	bus.emit('event', obj)
}

export function log({ msg }: { msg: string }) {
	emit({ type: 'log', msg })
}

export function onEvent(listener: (event: BrainEvent) => void): () => void {
	bus.on('event', listener)
	return () => bus.off('event', listener)
}

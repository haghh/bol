// Picks the engine for the backend in settings.

import type { Settings } from '../shared/settings'
import { createApiEngine } from './api/engine'
import { createClaudeCodeEngine } from './brain/index'
import type { Engine } from './engine'

export function createEngine({ settings }: { settings: Settings }): Engine {
	return settings.backend === 'claude-code' ? createClaudeCodeEngine({ settings }) : createApiEngine({ settings })
}

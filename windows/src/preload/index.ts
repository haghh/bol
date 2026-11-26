// The voice bar's only way into the main process: a small, typed bridge.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BrainEvent, Command } from '../shared/events'
import type { Settings } from '../shared/settings'

export type ApprovalRequest = { id: string; tool: string; summary: string; job: string | null }
export type EngineStatus = { isReady: boolean; backend: string | null; error: string | null }

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
	const handler = (_e: IpcRendererEvent, value: T) => listener(value)
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.off(channel, handler)
}

const api = {
	send: (command: Command): Promise<{ ok: boolean; seq?: number; error?: string }> =>
		ipcRenderer.invoke('bol:command', command),
	hide: () => ipcRenderer.send('bol:hide'),
	approve: (id: string, isAllowed: boolean) => ipcRenderer.send('bol:approve', { id, isAllowed }),
	settings: (): Promise<Settings> => ipcRenderer.invoke('bol:settings'),
	status: (): Promise<EngineStatus> => ipcRenderer.invoke('bol:status'),
	onEvent: (listener: (event: BrainEvent) => void) => subscribe('bol:event', listener),
	onShow: (listener: (args: { isListening: boolean }) => void) => subscribe('bol:show', listener),
	onApproval: (listener: (request: ApprovalRequest) => void) => subscribe('bol:approval', listener),
	onSettings: (listener: (settings: Settings) => void) => subscribe('bol:settings', listener),
}

export type BolApi = typeof api

contextBridge.exposeInMainWorld('bol', api)

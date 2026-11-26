import type { BolApi } from '../preload/index'

declare global {
	interface Window {
		bol: BolApi
	}
}

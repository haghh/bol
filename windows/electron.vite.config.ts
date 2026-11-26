import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
	main: {
		build: {
			rollupOptions: { input: { index: resolve('src/main/index.ts') } },
		},
	},
	preload: {
		build: {
			// Sandboxed preloads must be CommonJS.
			rollupOptions: {
				input: { index: resolve('src/preload/index.ts') },
				output: { format: 'cjs', entryFileNames: '[name].cjs' },
			},
		},
	},
	renderer: {
		root: resolve('src/renderer'),
		build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
		plugins: [react()],
	},
})

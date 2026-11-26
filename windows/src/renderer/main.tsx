import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceBar } from './voice-bar'
import './styles.css'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<VoiceBar />
	</StrictMode>,
)

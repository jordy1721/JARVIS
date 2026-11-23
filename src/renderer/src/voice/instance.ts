import { VoiceController } from './controller'
import { api, getState, setState } from '../store'
import { onSpeakingChange } from './tts'

export const voice = new VoiceController({
  onState: (s, caption) => setState({ state: s, caption: caption ?? '' }),
  onTranscript: (text) => {
    setState({ state: 'thinking', caption: text })
    api.invoke('chat:send', text, true)
  },
  onModelProgress: (t) => setState({ modelProgress: t }),
  onSttStatus: (state, detail) => setState({ sttStatus: { state, detail } }),
  onLevel: (() => {
    let last = 0
    return (level: number) => {
      const now = performance.now()
      if (now - last > 80) {
        last = now
        setState({ level })
      }
    }
  })()
})


// Show "Speaking" in the app while JARVIS talks.
onSpeakingChange((speaking) => {
  const st = getState().state
  if (speaking) setState({ state: 'speaking' })
  else if (st === 'speaking') setState({ state: 'idle' })
})

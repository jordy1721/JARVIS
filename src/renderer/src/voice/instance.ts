import { VoiceController } from './controller'
import { api, setState } from '../store'

export const voice = new VoiceController({
  onState: (s, caption) => setState({ state: s, caption: caption ?? '' }),
  onTranscript: (text) => {
    setState({ state: 'thinking', caption: text })
    api.invoke('chat:send', text, true)
  },
  onModelProgress: (t) => setState({ modelProgress: t }),
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


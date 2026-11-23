import { Component, type ReactNode } from 'react'

/** If anything in the UI crashes (for example after a bad self-modification), show a way out. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; msg: string }> {
  state = { error: null as Error | null, msg: '' }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    window.jarvis.send('renderer:error', `${error.message}\n${error.stack ?? ''}`)
    window.jarvis.send('renderer:ready') // the window works; the boundary handles recovery
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h2>Something in JARVIS’s screen broke</h2>
        <p className="muted">This usually comes from the most recent code change. You can undo it in one click.</p>
        <pre className="code small error">{this.state.error.message}</pre>
        <div className="row">
          <button
            className="btn primary"
            onClick={async () => {
              const msg: string = await window.jarvis.invoke('code:undoLast')
              this.setState({ msg })
            }}
          >
            Undo last code change
          </button>
          <button className="btn ghost" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
        {this.state.msg && <p>{this.state.msg}</p>}
      </div>
    )
  }
}

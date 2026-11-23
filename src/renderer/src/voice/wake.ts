function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/**
 * Speech recognition often mishears names ("Jarvis" → "Java's", "Jarvas", "Travis").
 * Looks for the wake word (or something close to it) in the first few words.
 * Returns the command after it, "" if only the wake word was said, or null if absent.
 */
export function stripWakeWord(text: string, wakeWord: string): string | null {
  const wake = wakeWord.toLowerCase().replace(/[^a-z]/g, '')
  if (!wake) return text
  const words = text.split(/\s+/)
  const tolerance = wake.length >= 6 ? 2 : 1
  for (let i = 0; i < Math.min(4, words.length); i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '')
    // also try two words glued together ("jar vis")
    const two = (w + (words[i + 1] ?? '').toLowerCase().replace(/[^a-z]/g, '')).slice(0, wake.length + 1)
    if (w.length >= 3 && editDistance(w, wake) <= tolerance) return words.slice(i + 1).join(' ').replace(/^[,.!?\s]+/, '').trim()
    if (editDistance(two, wake) <= tolerance && w.length < wake.length) return words.slice(i + 2).join(' ').replace(/^[,.!?\s]+/, '').trim()
  }
  return null
}

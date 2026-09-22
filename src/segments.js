// Turning Whisper's raw output into something worth reading.
//
// `transcribe({ metadata: true })` resolves to segments shaped like
// `{ text, startMs, endMs, append, id }`. They are not sentences: Whisper emits
// them as it decodes, so they arrive clipped mid-phrase, padded with spaces,
// and occasionally flagged `append: true` to mean "this continues the segment
// before it rather than starting a new one".
//
// Everything downstream — the transcript in the note, the timestamp on an
// action item — reads better if that is cleaned up once, here.

/**
 * Collapse raw Whisper segments into utterances.
 *
 * Segments flagged `append` are folded into the previous utterance, keeping its
 * start time and extending its end time. Empty segments are dropped: Whisper
 * emits them for silence, and they would otherwise become blank transcript lines.
 *
 * @param {Array<{text: string, startMs: number, endMs: number, append: boolean}>} segments
 * @returns {Array<{text: string, startMs: number, endMs: number}>}
 */
export function mergeSegments (segments) {
  const merged = []

  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue

    const previous = merged[merged.length - 1]

    if (segment.append && previous) {
      previous.text = `${previous.text} ${text}`.replace(/\s+/g, ' ')
      previous.endMs = segment.endMs
      continue
    }

    merged.push({ text, startMs: segment.startMs, endMs: segment.endMs })
  }

  return merged
}

/**
 * Format a millisecond offset as a timestamp.
 *
 * Recordings under an hour get m:ss, longer ones h:mm:ss — a voice memo showing
 * "0:00:07" reads like a bug report, not a note.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatTimestamp (ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (n) => String(n).padStart(2, '0')

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

/**
 * Join utterances into plain prose, for feeding to the language model.
 *
 * Timestamps are deliberately left out. A 1B model given "[0:14] we should ..."
 * starts echoing the brackets back inside its summary; the timestamps are
 * recovered afterwards by align.js instead.
 *
 * @param {Array<{text: string}>} utterances
 * @returns {string}
 */
export function toPlainText (utterances) {
  return utterances.map((u) => u.text).join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Split utterances into groups whose combined text stays under `maxChars`.
 *
 * Used by the map-reduce path for long recordings. Splitting on utterance
 * boundaries rather than by character count keeps sentences intact, so no
 * chunk begins halfway through a thought.
 *
 * @param {Array<{text: string, startMs: number, endMs: number}>} utterances
 * @param {number} maxChars
 * @returns {Array<Array<{text: string, startMs: number, endMs: number}>>}
 */
export function groupUtterances (utterances, maxChars) {
  const groups = []
  let current = []
  let length = 0

  for (const utterance of utterances) {
    // +1 for the space that toPlainText will insert between utterances.
    const cost = utterance.text.length + 1

    if (current.length > 0 && length + cost > maxChars) {
      groups.push(current)
      current = []
      length = 0
    }

    current.push(utterance)
    length += cost
  }

  if (current.length > 0) groups.push(current)

  return groups
}

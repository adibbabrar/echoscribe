// Putting a timestamp on a line the model wrote.
//
// The obvious approach is to number the transcript and ask the model to cite
// the line it used. A 1B model does that unreliably — it invents indices, cites
// the same one for everything, or silently stops citing halfway down the list —
// and a wrong timestamp is worse than none, because it sends you to the wrong
// part of the recording with full confidence.
//
// So the model is never asked. It writes the action items; this file finds
// where each one came from by matching words back against the transcript. It is
// deterministic, it costs no tokens, and when nothing matches well enough it
// says so instead of guessing.

// Words carried by almost every spoken sentence. Left in, they make every line
// look like a 40% match for every utterance and flatten the ranking.
const STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'get', 'go',
  'going', 'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'like', 'me', 'my', 'need', 'needs', 'of', 'on',
  'or', 'our', 'out', 'she', 'should', 'so', 'some', 'take', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to', 'up', 'us',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would',
  'you', 'your'
])

// A window of three utterances is about one spoken sentence either side of the
// match. Wider than that and a single shared word starts dragging in unrelated
// speech from further down the recording.
const MAX_WINDOW = 3

// Below this share of a line's meaningful words, the best match is almost
// always coincidence — two lines that happen to share "release" and "Friday".
// Tuned against the sample recordings; see the README.
const MIN_OVERLAP = 0.34

/**
 * Reduce a string to the set of words worth matching on.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function contentWords (text) {
  const words = text
    .toLowerCase()
    // Keep apostrophes so "won't" stays one word rather than becoming "won" + "t".
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))

  return new Set(words)
}

/**
 * The share of a line's meaningful words that appear in some text.
 *
 * @param {Set<string>} target  Content words of the line being placed.
 * @param {string} text
 * @returns {number}
 */
function recall (target, text) {
  const words = contentWords(text)

  let hits = 0
  for (const word of target) {
    if (words.has(word)) hits++
  }

  return hits / target.size
}

/**
 * Is this candidate a better match than the one we are holding?
 *
 * Score first, but a tie goes to the narrower window. Without that rule a
 * three-utterance window starting a sentence early scores exactly the same as
 * the one sentence that actually contains the phrase — it holds every word the
 * line needs, plus some — and because the search walks forward from the start
 * of the recording, the early window is always seen first. The timestamps then
 * come out consistently a few seconds ahead of the thing they point at.
 *
 * Start position is never compared: the loop order already means the earliest
 * window of a given size is the one being held.
 */
function better (candidate, best) {
  // Scores are ratios of small integers, so exact equality is reachable, but
  // 2/6 and 1/3 are the same match and must not be treated as different.
  const EPSILON = 1e-9

  if (candidate.score > best.score + EPSILON) return true
  if (candidate.score < best.score - EPSILON) return false

  return candidate.size < best.size
}

/**
 * Find the moment in the recording that a line of text came from.
 *
 * Scores every run of up to MAX_WINDOW consecutive utterances by how much of
 * the line's vocabulary it accounts for, and returns the start of the best run.
 *
 * Ties break toward the narrower window, and then — by loop order — the
 * earlier one: when a phrase recurs, the first and tightest occurrence is the
 * one worth linking to.
 *
 * @param {string} line
 * @param {Array<{text: string, startMs: number, endMs: number}>} utterances
 * @returns {{startMs: number, score: number}|null} Null when nothing matched
 *          well enough to be trusted.
 */
export function locate (line, utterances) {
  const target = contentWords(line)
  if (target.size === 0) return null

  let best = null

  for (let start = 0; start < utterances.length; start++) {
    for (let size = 1; size <= MAX_WINDOW && start + size <= utterances.length; size++) {
      const window = utterances.slice(start, start + size)

      const score = recall(target, window.map((u) => u.text).join(' '))

      if (!best || better({ score, size }, best)) {
        best = { start, size, score }
      }
    }
  }

  if (!best || best.score < MIN_OVERLAP) return null

  // The window found the right region; now point inside it.
  //
  // A window is allowed to span three utterances so that a sentence split
  // across them still matches, but its first utterance is often only scene
  // setting. "Update the status page to reflect the new maintenance window"
  // matches a window covering 0:19-0:25 because "maintenance window" is said
  // at 0:19 - while the task itself is not asked until 0:25. Scoring each
  // utterance on its own and taking the strongest puts the timestamp on the
  // line that carries the content rather than the one that happens to come
  // first.
  const window = utterances.slice(best.start, best.start + best.size)
  let pick = window[0]
  let pickScore = -1

  for (const utterance of window) {
    const score = recall(target, utterance.text)
    // Strictly greater: on a tie the earlier utterance keeps it.
    if (score > pickScore) {
      pickScore = score
      pick = utterance
    }
  }

  return { startMs: pick.startMs, score: best.score }
}

/**
 * Attach a timestamp to each line, where one can be found.
 *
 * @param {string[]} lines
 * @param {Array<{text: string, startMs: number, endMs: number}>} utterances
 * @returns {Array<{text: string, startMs: number|null}>}
 */
export function locateAll (lines, utterances) {
  return lines.map((text) => {
    const match = locate(text, utterances)
    return { text, startMs: match ? match.startMs : null }
  })
}

// Words that reverse a sentence's meaning. A line holding one of these is not
// a restatement of an otherwise identical line that does not.
const NEGATIONS = /\b(not|never|no|none|nothing|cannot|can't|won't|don't|doesn't|isn't|aren't|without)\b/i

/**
 * Does this line negate something?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isNegated (text) {
  return NEGATIONS.test(text)
}

/**
 * How much two lines say the same thing, from 0 to 1.
 *
 * Dividing by the smaller vocabulary rather than the union is deliberate. The
 * pair this exists to catch is "Raj will write the rollback procedure before
 * Friday" against "Raj will review the rollback procedure before Friday" —
 * greedy decoding produces that kind of restatement constantly, and it differs
 * by a single verb. Union-based similarity scores those two lower than their
 * near-identity deserves, because every word either one adds enlarges the
 * denominator.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity (a, b) {
  // Opposites share almost all of their vocabulary. "We are not going to
  // include the distributed case" against "We decided to include the
  // distributed case" differs by one word and scores 0.75 - over the
  // deduplication threshold - so without this check one of a contradictory
  // pair gets silently dropped, and nothing says it will be the wrong one.
  // Surfacing both is worse-looking and more honest.
  if (isNegated(a) !== isNegated(b)) return 0

  const first = contentWords(a)
  const second = contentWords(b)

  if (first.size === 0 || second.size === 0) return 0

  let shared = 0
  for (const word of first) {
    if (second.has(word)) shared++
  }

  return shared / Math.min(first.size, second.size)
}

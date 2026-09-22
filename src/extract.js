// Turning a transcript into a note, using the local language model.
//
// Three separate, narrow calls rather than one call asking for JSON with three
// fields. A 1B model asked for structured output spends its attention on
// getting the brackets right and produces worse content inside them, and one
// malformed brace loses the whole response. Three focused prompts each return
// plain text, each is independently parseable, and a failure in one still
// leaves the other two usable.
import { completion } from '@qvac/sdk'
import { groupUtterances, toPlainText } from './segments.js'
import { similarity } from './align.js'

// Roughly 9000 characters of transcript fits inside an 8192-token context
// alongside the instructions and the reply, at the ~3.5 chars/token that
// English speech averages. Past that, the map-reduce path takes over.
const SINGLE_PASS_CHARS = 9000

// Chunk size for long recordings. Smaller than the single-pass budget so that
// the summary of a chunk has somewhere to go.
const CHUNK_CHARS = 6000

const SYSTEM_PROMPT = [
  'You turn transcripts of spoken recordings into notes.',
  '',
  'Rules:',
  '- Use only what the transcript says. Never add facts, names, dates or numbers that are not in it.',
  '- Speech is messy. Ignore filler words, false starts and repetition.',
  '- Write plainly. No preamble, no sign-off, no commentary about the transcript itself.'
].join('\n')

// Added only when the recording is not English. Timestamps are found by
// matching each line's words against the transcript, so a note written in
// English about a Spanish recording could not be placed at all. It is not in
// the default prompt because on English audio it made the model copy whole
// transcript sentences into the action list instead of rewriting them.
const SAME_LANGUAGE_RULE = '\n- Write in the same language as the transcript.'

/**
 * Run one completion and return the whole reply.
 *
 * Streaming is used even though nothing is displayed, because it lets long
 * replies arrive incrementally rather than sitting behind one large response.
 *
 * @param {{modelId: string, system: string}} model
 * @param {string} instruction  What to do with the transcript.
 * @param {string} transcript   The text to work from.
 * @returns {Promise<string>}
 */
async function ask ({ modelId, system }, instruction, transcript) {
  const history = [
    { role: 'system', content: system },
    { role: 'user', content: `Transcript:\n"""\n${transcript}\n"""\n\n${instruction}` }
  ]

  let reply = ''
  const run = completion({ modelId, history, stream: true })

  for await (const event of run.events) {
    if (event.type === 'contentDelta') reply += event.text
  }

  return reply.trim()
}

/**
 * Pull a list out of a model reply.
 *
 * The model is asked for bullets and usually complies, but not always: it may
 * number them, drop the markers entirely, or open with "Here are the action
 * items:". This accepts all of those and throws away the lead-in.
 *
 * @param {string} reply
 * @returns {string[]}
 */
export function parseList (reply) {
  const items = []

  for (const rawLine of reply.split('\n')) {
    let line = rawLine.trim()
    if (!line) continue

    // Strip a leading bullet or "1." / "1)" marker.
    const stripped = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '')
    const wasMarked = stripped !== line
    line = stripped.trim()

    // Lines ending in a colon are headers the model added ("Action items:"),
    // never content — unless they were bulleted, in which case they are.
    if (!wasMarked && line.endsWith(':')) continue

    // Drop bold/italic emphasis the model sometimes wraps items in.
    line = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim()

    if (!line) continue

    // The prompt asks for "none" when there is nothing to report. Checked after
    // marker stripping, because it arrives as "- None" about half the time.
    if (/^none\.?$/i.test(line)) continue

    // A model that has run out of things to say starts restating the request.
    if (/^(here are|the following|in summary)/i.test(line) && !wasMarked) continue

    items.push(line)
  }

  return items
}

// Above this overlap, two lines are saying the same thing. Measured on the
// sample recordings: genuine restatements of one task scored 0.80-1.00, while
// the closest pair of genuinely different tasks ("Priya will update the status
// page" against "Priya will notify support") scored 0.33. Nothing real landed
// between 0.4 and 0.8, so the cut sits in that empty band.
const DUPLICATE_OVERLAP = 0.75

/**
 * Drop lines that restate a line already in the list, keeping the first.
 *
 * Greedy decoding makes a model that has run out of material paraphrase its
 * own last answer rather than stop, so a five-item list is often two real
 * items and three rewordings. Exact-match deduplication never catches those,
 * because a single swapped verb makes the strings different.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupe (items) {
  const kept = []

  for (const item of items) {
    if (kept.some((existing) => similarity(existing, item) >= DUPLICATE_OVERLAP)) continue
    kept.push(item)
  }

  return kept
}

// The last two sentences fix a real failure on the standup sample. The speaker
// runs the replica test "today" and moves the migration to "Saturday night",
// and the model merged the two, putting the replica test on Saturday and
// calling the forty-minute import "a 40-minute delay".
const SUMMARY_INSTRUCTION = [
  'Summarise what was said in 2 to 4 sentences. Write it as a short paragraph, not a list.',
  'Keep every day, time and number attached to the thing it was said about.',
  'Do not move a plan to a different day, and do not turn a duration into a delay.'
].join(' ')

// Naming the two grammatical shapes a commitment takes is what made this
// usable. Asked only for "things somebody said they would do", the model
// returned whichever task was phrased most like an assignment, then looped:
// on the standup sample it emitted the same line about Raj twelve times.
//
// "Never write a sentence fragment" earns its place too. An earlier version
// that told the model to work through the transcript from beginning to end got
// it chopping speech into fragments instead - "the production replica",
// "about the new window" - one per line.
const ACTIONS_INSTRUCTION = [
  'List every task somebody agreed to do or was asked to do.',
  'Include tasks the speaker took on themselves ("I will", "I am going to")',
  'as well as tasks given to a named person.',
  'Write each task as one complete sentence on its own line, starting with "- ".',
  'Never write a sentence fragment.',
  'If there are no tasks, reply with exactly: none'
].join(' ')

// Listing the phrases that actually mark a decision in speech beats defining
// one. Told abstractly that "a decision is a choice, not a task", the model
// returned the task list again with "Decide to" glued on the front.
const DECISIONS_INSTRUCTION = [
  'List the choices that were already settled in this recording,',
  'such as things introduced by "we decided", "we agreed", "instead of",',
  '"rather than" or "we are not going to".',
  'Write each one as one complete sentence on its own line, starting with "- ".',
  'Do not list work that still has to be done.',
  'If nothing was settled, reply with exactly: none'
].join(' ')

/**
 * Summarise a transcript, folding long ones down in two stages.
 *
 * Long recordings are summarised chunk by chunk, then those summaries are
 * summarised together. The intermediate summaries are discarded — only the
 * final paragraph is returned — but they are what keeps a 40-minute lecture
 * inside an 8192-token context.
 *
 * @param {object} params
 * @param {{modelId: string, system: string}} params.model
 * @param {string} params.transcript
 * @param {Array} params.utterances
 * @param {(stage: string) => void} [params.onStage]
 * @returns {Promise<string>}
 */
async function summarise ({ model, transcript, utterances, onStage = () => {} }) {
  if (transcript.length <= SINGLE_PASS_CHARS) {
    onStage('summarising')
    return ask(model, SUMMARY_INSTRUCTION, transcript)
  }

  const groups = groupUtterances(utterances, CHUNK_CHARS)
  const partials = []

  for (const [index, group] of groups.entries()) {
    onStage(`summarising part ${index + 1} of ${groups.length}`)
    partials.push(await ask(model, SUMMARY_INSTRUCTION, toPlainText(group)))
  }

  onStage('combining summaries')

  return ask(
    model,
    'Combine these notes from consecutive parts of one recording into a single summary of 3 to 5 sentences.',
    partials.join('\n\n')
  )
}

/**
 * Extract a list across a transcript of any length.
 *
 * Unlike the summary, the chunk results are concatenated rather than passed
 * back through the model: a second pass over a list of action items tends to
 * merge unrelated ones together and drop the least-wordy.
 */
async function extractList ({ model, transcript, utterances, instruction, label, onStage }) {
  if (transcript.length <= SINGLE_PASS_CHARS) {
    onStage(`finding ${label}`)
    return dedupe(parseList(await ask(model, instruction, transcript)))
  }

  const groups = groupUtterances(utterances, CHUNK_CHARS)
  const items = []

  for (const [index, group] of groups.entries()) {
    onStage(`finding ${label} in part ${index + 1} of ${groups.length}`)
    items.push(...parseList(await ask(model, instruction, toPlainText(group))))
  }

  // Deduplicated once at the end rather than per chunk: consecutive chunks of
  // one recording overlap in subject matter, and the same task is often picked
  // up on both sides of a chunk boundary.
  return dedupe(items)
}

/**
 * Build the whole note body from a transcript.
 *
 * @param {object} params
 * @param {string} params.modelId
 * @param {Array<{text: string, startMs: number, endMs: number}>} params.utterances
 * @param {boolean} [params.nonEnglish]  The recording is in another language.
 * @param {(stage: string) => void} [params.onStage]
 * @returns {Promise<{summary: string, actions: string[], decisions: string[], chunked: boolean}>}
 */
export async function extractNote ({ modelId, utterances, nonEnglish = false, onStage = () => {} }) {
  const transcript = toPlainText(utterances)
  const model = { modelId, system: nonEnglish ? SYSTEM_PROMPT + SAME_LANGUAGE_RULE : SYSTEM_PROMPT }

  const summary = await summarise({ model, transcript, utterances, onStage })

  const actions = await extractList({
    model, transcript, utterances, onStage,
    instruction: ACTIONS_INSTRUCTION,
    label: 'action items'
  })

  const decisions = await extractList({
    model, transcript, utterances, onStage,
    instruction: DECISIONS_INSTRUCTION,
    label: 'decisions'
  })

  // A task and the decision to do it are described in almost the same words, so
  // the same line frequently comes back from both prompts. Actions win: a task
  // listed under Decisions is wrong twice over, and one listed under Action
  // items is at worst redundant.
  const distinctDecisions = decisions.filter(
    (decision) => !actions.some((action) => similarity(action, decision) >= DUPLICATE_OVERLAP)
  )

  return {
    summary,
    actions,
    decisions: distinctDecisions,
    chunked: transcript.length > SINGLE_PASS_CHARS
  }
}

// echoscribe: turn one recording into a note. `npm run note -- <file>`
//
// The whole pipeline lives here in order: transcribe, extract, align, render.
import { unloadModel, close } from '@qvac/sdk'
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { ASR_MODEL, LLM_MODEL, LLM_CONTEXT, asrConfig, loadWithProgress } from './models.js'
import { parseCli } from './args.js'
import { transcribeFile, isSupportedAudio, SUPPORTED_AUDIO_FORMATS } from './transcribe.js'
import { extractNote } from './extract.js'
import { locateAll } from './align.js'
import { renderNote } from './note.js'
import { formatTimestamp } from './segments.js'

const NOTES_DIR = 'notes'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const style = (code, text) => (process.stdout.isTTY ? `${code}${text}${RESET}` : text)
const stage = (text) => process.stderr.write(`  ${text}...\n`)

/**
 * Process one audio file and write its note.
 *
 * Takes already-loaded model ids so that batch.js can reuse them across many
 * files — loading Whisper and Llama costs several seconds, and paying that per
 * file would dominate the runtime of a batch.
 *
 * @returns {Promise<{notePath: string, summary: string, actions: Array, decisions: Array}>}
 */
export async function processFile ({ asrModelId, llmModelId, filePath, lang, notesDir = NOTES_DIR }) {
  const startedAt = Date.now()

  stage(`transcribing ${basename(filePath)}`)
  const utterances = await transcribeFile({ modelId: asrModelId, filePath })

  if (utterances.length === 0) {
    throw new Error('No speech was found in this file.')
  }

  const { summary, actions, decisions } = await extractNote({
    modelId: llmModelId,
    utterances,
    nonEnglish: Boolean(lang) && lang !== 'en',
    onStage: stage
  })

  // Timestamps are recovered from the transcript, not asked of the model.
  const locatedActions = locateAll(actions, utterances)
  const locatedDecisions = locateAll(decisions, utterances)

  const note = renderNote({
    sourcePath: filePath,
    summary,
    actions: locatedActions,
    decisions: locatedDecisions,
    utterances,
    meta: {
      asrModel: ASR_MODEL.name,
      llmModel: LLM_MODEL.name,
      durationMs: utterances[utterances.length - 1].endMs,
      elapsedMs: Date.now() - startedAt
    }
  })

  mkdirSync(notesDir, { recursive: true })
  const notePath = join(notesDir, `${basename(filePath, extname(filePath))}.md`)
  writeFileSync(notePath, note)

  return { notePath, summary, actions: locatedActions, decisions: locatedDecisions }
}

/** Print the note to the terminal, so a run is readable without opening a file. */
export function printResult ({ notePath, summary, actions, decisions }) {
  const list = (items) => items
    .map(({ text, startMs }) => `  - ${text}${startMs === null ? '' : style(DIM, ` (${formatTimestamp(startMs)})`)}`)
    .join('\n')

  console.log(`\n${style(BOLD, 'Summary')}\n${summary}`)

  console.log(`\n${style(BOLD, 'Action items')}`)
  console.log(actions.length ? list(actions) : style(DIM, '  none found'))

  console.log(`\n${style(BOLD, 'Decisions')}`)
  console.log(decisions.length ? list(decisions) : style(DIM, '  none found'))

  console.log(`\n${style(DIM, `Note written to ${notePath}`)}`)
}

// Only run as a script, so batch.js can import processFile without this firing.
if (import.meta.url === `file://${process.argv[1]}`) {
  let input, lang
  try {
    ({ input, lang } = parseCli())
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  if (!input) {
    console.error('Usage: npm run note -- <audio-file> [--lang es|fr|...|auto]')
    console.error(`Supported formats: ${SUPPORTED_AUDIO_FORMATS.join(' ')}`)
    console.error('No recording to hand? Run `npm run samples` first.')
    process.exit(1)
  }

  const filePath = resolve(input)

  // Both checks happen before any model loads: a typo in a filename should not
  // cost a 30-second model load before it is reported.
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    console.error(`No such file: ${input}`)
    process.exit(1)
  }

  if (!isSupportedAudio(filePath)) {
    console.error(`Unsupported format: ${extname(filePath) || '(no extension)'}`)
    console.error(`The SDK reads: ${SUPPORTED_AUDIO_FORMATS.join(' ')}`)
    process.exit(1)
  }

  let asrModelId
  let llmModelId

  try {
    asrModelId = await loadWithProgress(ASR_MODEL, 'speech model', asrConfig(lang))
    llmModelId = await loadWithProgress(LLM_MODEL, 'language model', {
      ctx_size: LLM_CONTEXT,
      // Greedy decoding. At the engine default the same recording produces a
      // different set of action items on every run, which makes the output
      // impossible to trust or to test against.
      temp: 0
    })

    const result = await processFile({ asrModelId, llmModelId, filePath, lang })
    printResult(result)
  } catch (error) {
    console.error(`\nFailed: ${error?.message ?? error}`)
    process.exitCode = 1
  } finally {
    if (asrModelId) await unloadModel({ modelId: asrModelId }).catch(() => {})
    if (llmModelId) await unloadModel({ modelId: llmModelId }).catch(() => {})
    // Without this the SDK's background worker keeps the event loop alive and
    // the command never returns to the shell.
    await close().catch(() => {})
  }
}

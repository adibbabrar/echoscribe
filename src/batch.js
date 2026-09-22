// Process a whole folder of recordings. `npm run batch -- [folder]`
//
// The point of this command is that the models are loaded once and reused for
// every file. Loading Whisper and Llama costs most of a minute; paying that per
// recording would dominate the run for a folder of short memos.
import { unloadModel, close } from '@qvac/sdk'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename, extname } from 'node:path'
import { ASR_MODEL, LLM_MODEL, LLM_CONTEXT, loadWithProgress } from './models.js'
import { isSupportedAudio, SUPPORTED_AUDIO_FORMATS } from './transcribe.js'
import { processFile } from './memo.js'

const DEFAULT_INPUT = 'samples'
const NOTES_DIR = 'notes'

const input = resolve(process.argv[2] ?? DEFAULT_INPUT)

if (!existsSync(input) || !statSync(input).isDirectory()) {
  console.error(`Not a folder: ${process.argv[2] ?? DEFAULT_INPUT}`)
  console.error('Usage: npm run batch -- <folder-of-recordings>')
  process.exit(1)
}

const files = readdirSync(input)
  .filter(isSupportedAudio)
  .sort()
  .map((name) => join(input, name))

if (files.length === 0) {
  console.error(`No audio files in ${input}`)
  console.error(`Looking for: ${SUPPORTED_AUDIO_FORMATS.join(' ')}`)
  console.error('No recordings yet? Run `npm run samples` to generate two.')
  process.exit(1)
}

// Skipping files that already have a note makes the command resumable. A batch
// of long recordings can take a while, and interrupting it should not mean
// starting over.
const pending = files.filter(
  (file) => !existsSync(join(NOTES_DIR, `${basename(file, extname(file))}.md`))
)

const skipped = files.length - pending.length
if (skipped > 0) {
  console.error(`  skipping ${skipped} recording${skipped === 1 ? '' : 's'} that already ${skipped === 1 ? 'has a note' : 'have notes'}`)
}

if (pending.length === 0) {
  console.error('  Nothing to do. Delete a note to have it rebuilt.')
  process.exit(0)
}

let asrModelId
let llmModelId
let failures = 0

try {
  asrModelId = await loadWithProgress(ASR_MODEL, 'speech model')
  llmModelId = await loadWithProgress(LLM_MODEL, 'language model', { ctx_size: LLM_CONTEXT, temp: 0 })

  for (const [index, file] of pending.entries()) {
    console.error(`\n[${index + 1}/${pending.length}] ${basename(file)}`)

    try {
      const { notePath } = await processFile({ asrModelId, llmModelId, filePath: file })
      console.error(`  wrote ${notePath}`)
    } catch (error) {
      // One unreadable file should not abandon the rest of the folder.
      console.error(`  failed: ${error?.message ?? error}`)
      failures++
    }
  }

  const written = pending.length - failures
  console.error(`\nDone. ${written} note${written === 1 ? '' : 's'} written` +
    `${failures > 0 ? `, ${failures} failed` : ''}.`)

  if (failures > 0) process.exitCode = 1
} catch (error) {
  console.error(`\nFailed: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  if (asrModelId) await unloadModel({ modelId: asrModelId }).catch(() => {})
  if (llmModelId) await unloadModel({ modelId: llmModelId }).catch(() => {})
  await close().catch(() => {})
}

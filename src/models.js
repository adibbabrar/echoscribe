// Model choices for echoscribe, plus a loader that reports download progress.
//
// Both models run on-device. The SDK pulls the weights from the QVAC registry
// the first time they are needed, caches them under ~/.qvac, and every
// inference after that is local — no network, no API key, no per-call bill.
import { loadModel } from '@qvac/sdk'
import { WHISPER_BASE_Q8_0, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'

// Speech-to-text. The multilingual "base" build rather than an English-only
// one: the English-only models mangle non-English names and accented speech,
// which is exactly what a personal recording tends to contain. At 82 MB it is
// still a small download.
export const ASR_MODEL = WHISPER_BASE_Q8_0

// The model that turns a raw transcript into a usable note.
export const LLM_MODEL = LLAMA_3_2_1B_INST_Q4_0

// Transcripts run long, and the default context is not always enough to hold
// a whole recording plus the instructions and the answer. 8192 leaves room for
// roughly 25 minutes of speech before the map-reduce path in extract.js kicks in.
export const LLM_CONTEXT = 8192

const megabytes = (bytes) => (bytes / 1e6).toFixed(1)

/**
 * Load a model, drawing a single self-updating progress line on stderr.
 *
 * Progress goes to stderr rather than stdout so that `npm run note ... > out.md`
 * still produces a clean file.
 *
 * @param {object} modelSrc        A QVAC model constant.
 * @param {string} label           Name to show while loading.
 * @param {object} [modelConfig]   Engine settings, e.g. { ctx_size }.
 * @returns {Promise<string>}      The loaded model's id.
 */
export async function loadWithProgress (modelSrc, label, modelConfig) {
  let drew = false
  let lastPercent = -1

  const modelId = await loadModel({
    modelSrc,
    ...(modelConfig ? { modelConfig } : {}),
    onProgress: (p) => {
      // Floor rather than round: at 99.6% there are still bytes in flight, and
      // printing "100%" before the file is written makes the wait that follows
      // look like a hang.
      const percent = Math.floor(p.percentage)
      const size = Number.isFinite(p.total) && p.total > 0
        ? ` (${megabytes(p.downloaded)}/${megabytes(p.total)} MB)`
        : ''
      const line = `  loading ${label} ${percent}%${size}`

      if (process.stderr.isTTY) {
        process.stderr.write(`\r${line}`)
      } else if (percent !== lastPercent) {
        // Without a TTY, \r does nothing and every update becomes its own line,
        // so only print when the whole percent actually changes.
        process.stderr.write(`${line}\n`)
      }

      drew = true
      lastPercent = percent
    }
  })

  // Terminate the progress line here rather than in the callback: a model that
  // is already cached never reports progress at all, and one that finishes may
  // never report a final 100%.
  if (drew && process.stderr.isTTY) process.stderr.write('\n')

  return modelId
}

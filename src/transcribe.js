// Speech to timestamped text.
import { transcribe, SUPPORTED_AUDIO_FORMATS } from '@qvac/sdk'
import { extname } from 'node:path'
import { mergeSegments } from './segments.js'

export { SUPPORTED_AUDIO_FORMATS }

/**
 * True when the SDK's audio decoder recognises this file's extension.
 *
 * Checked before loading a model, because loading Whisper and then failing on
 * the file makes the user wait for an error that was knowable immediately.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSupportedAudio (filePath) {
  return SUPPORTED_AUDIO_FORMATS.includes(extname(filePath).toLowerCase())
}

/**
 * Transcribe a file into merged, timestamped utterances.
 *
 * `metadata: true` is what makes the timestamps possible: without it the SDK
 * resolves to one joined string, and there is no way to tell which part of the
 * recording any sentence came from. It is a Whisper-engine feature, which is
 * part of why models.js picks a Whisper build.
 *
 * @param {object} params
 * @param {string} params.modelId
 * @param {string} params.filePath
 * @returns {Promise<Array<{text: string, startMs: number, endMs: number}>>}
 */
export async function transcribeFile ({ modelId, filePath }) {
  const segments = await transcribe({ modelId, audioChunk: filePath, metadata: true })

  return mergeSegments(segments)
}

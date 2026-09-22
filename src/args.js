// Command-line options shared by `note` and `batch`.
import { parseArgs } from 'node:util'

// Whisper takes a two-letter code ("es", "fr", "hi") or "auto" to detect the
// language itself. Anything else is caught here rather than surfacing as an
// engine error after a model load.
const LANGUAGE_CODE = /^(auto|[a-z]{2,3})$/

/**
 * @returns {{ input: string | undefined, lang: string | undefined }}
 */
export function parseCli (argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { lang: { type: 'string' } },
    allowPositionals: true
  })

  const lang = values.lang?.toLowerCase()
  if (lang !== undefined && !LANGUAGE_CODE.test(lang)) {
    throw new Error(`--lang takes a language code such as es, fr or hi, or "auto" (got "${values.lang}")`)
  }

  return { input: positionals[0], lang }
}

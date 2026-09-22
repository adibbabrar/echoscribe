// Smoke test: prove both models load and run on this machine, before you feed
// a real recording to a pipeline that takes minutes. `npm run check`
import { completion, unloadModel, close } from '@qvac/sdk'
import { getSystemResources } from '@qvac/sdk'
import { ASR_MODEL, LLM_MODEL, loadWithProgress } from './models.js'

let llmModelId
let asrModelId

try {
  // Reported before the downloads start, because "not enough disk" is the most
  // common way a first run fails and it is cheap to warn about early.
  const resources = await getSystemResources().catch(() => null)
  if (resources) {
    console.error(`  machine: ${process.platform}/${process.arch}, node ${process.versions.node}`)
  }

  asrModelId = await loadWithProgress(ASR_MODEL, 'speech model')
  console.error(`  speech model ready (${ASR_MODEL.name})`)

  llmModelId = await loadWithProgress(LLM_MODEL, 'language model', { ctx_size: 512, temp: 0 })

  const run = completion({
    modelId: llmModelId,
    history: [{ role: 'user', content: 'Reply with one short sentence confirming you are running locally.' }],
    stream: true
  })

  for await (const event of run.events) {
    if (event.type === 'contentDelta') process.stdout.write(event.text)
  }

  process.stdout.write('\n')
  console.error('\n  Check passed. Both models ran on this device.')
} catch (error) {
  console.error(`\n  Check failed: ${error?.message ?? error}`)
  console.error('  The first run needs network access to download the weights,')
  console.error('  and roughly 1 GB of free disk for the cache in ~/.qvac.')
  process.exitCode = 1
} finally {
  if (asrModelId) await unloadModel({ modelId: asrModelId }).catch(() => {})
  if (llmModelId) await unloadModel({ modelId: llmModelId }).catch(() => {})
  await close().catch(() => {})
}

// Regenerate the sample recordings with macOS's built-in speech synthesiser.
//
// The generated files are committed, so this script is not needed to try the
// app — `say` only exists on macOS, and a checkout should be runnable anywhere.
// It is here to change what the samples say, or to add your own.
//
// Synthesised speech makes a fair test fixture. It is clean and evenly paced,
// so a word the pipeline gets wrong is the model's limit rather than a bad
// microphone, and it commits no real person's voice to a public repository.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SAMPLES_DIR = 'samples'

const SAMPLES = [
  {
    name: 'standup',
    voice: 'Samantha',
    // Written to contain both things the app looks for: commitments somebody
    // made, and choices that were settled. Some are stated plainly, some are
    // buried mid-sentence, which is the case the matcher in align.js has to
    // handle.
    text: [
      'Morning everyone, quick standup.',
      'Yesterday I finished the migration script for the user table, and it ran clean against the staging copy.',
      'Today I am going to run it against the production replica, so we can time how long the real thing takes.',
      'One thing came up. The import is slower than we expected, about forty minutes, which is too long for the maintenance window we announced.',
      'So we decided to move the migration to Saturday night instead of Thursday.',
      'Priya, can you update the status page and let support know about the new window?',
      'Also we agreed to drop the legacy avatar column entirely rather than migrating it, since nothing has read from it since March.',
      'Raj is going to write the rollback procedure before Friday, and we will not start the migration until that is reviewed.',
      'Last thing, the staging database is still on the old instance size. I will resize it this afternoon so the timing test is actually representative.',
      'That is everything from me.'
    ].join(' ')
  },
  {
    name: 'voice-memo',
    voice: 'Daniel',
    // A rambling solo memo, the messier case: no structure, and the tasks are
    // half-formed rather than assigned.
    text: [
      'Note to self, walking back from the library.',
      'The chapter on cache invalidation is going to need rewriting. The example I used is too abstract and nobody I showed it to understood the point.',
      'I think the fix is to use the avatar bug from last term as the worked example, because everybody already knows that story.',
      'I should email Professor Hasan about whether that is allowed, since it came out of a graded project.',
      'Also I keep putting off the benchmark section. I am going to give it two hours on Sunday and whatever I have at the end of that is what goes in.',
      'Decided I am not going to include the distributed case at all. It doubles the length and it is not what the chapter is about.',
      'Oh, and I need to renew the library loan before the eleventh or I get charged again.'
    ].join(' ')
  }
]

if (process.platform !== 'darwin') {
  console.error('This script uses the macOS `say` command, which is not available here.')
  console.error('Any .m4a, .mp3, .wav, .ogg, .flac or .aac file will work instead:')
  console.error('  npm run note -- /path/to/your-recording.m4a')
  process.exit(1)
}

mkdirSync(SAMPLES_DIR, { recursive: true })

for (const sample of SAMPLES) {
  const path = join(SAMPLES_DIR, `${sample.name}.m4a`)

  // --data-format=aac is what makes this an .m4a the SDK's decoder accepts;
  // `say -o` writes uncompressed AIFF by default regardless of the extension.
  execFileSync('say', ['-v', sample.voice, '-o', path, '--data-format=aac', sample.text])

  console.log(`  wrote ${path}`)
}

console.log('\nTry it:\n  npm run note -- samples/standup.m4a')

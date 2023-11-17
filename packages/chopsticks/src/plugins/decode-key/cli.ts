import { Config } from '../../schema/index.js'
import { HexString } from '@polkadot/util/types'
import { decodeKey } from '@acala-network/chopsticks-core'
import { defaultOptions } from '../../cli-options.js'
import { setupContext } from '../../context.js'
import type { Argv } from 'yargs'

export const cli = (y: Argv) => {
  y.command(
    'decode-key <key>',
    'Deocde a key',
    (yargs) =>
      yargs
        .positional('key', {
          desc: 'Key to decode',
          type: 'string',
        })
        .options({
          ...defaultOptions,
        }),
    async (argv) => {
      const context = await setupContext(argv as Config)
      const { storage, decodedKey } = decodeKey(
        await context.chain.head.meta,
        context.chain.head,
        argv.key as HexString,
      )
      if (storage && decodedKey) {
        console.log(
          `${storage.section}.${storage.method}`,
          decodedKey.args.map((x) => JSON.stringify(x.toHuman())).join(', '),
        )
      } else {
        console.log('Unknown')
      }
      process.exit(0)
    },
  )
}

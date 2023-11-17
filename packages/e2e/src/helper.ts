import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api'
import { Codec, RegisteredTypes } from '@polkadot/types/types'
import { HexString } from '@polkadot/util/types'
import { ProviderInterface } from '@polkadot/rpc-provider/types'
import { beforeAll, beforeEach, expect, vi } from 'vitest'

import { Api } from '@tanssi/chopsticks'
import { Blockchain, BuildBlockMode, StorageValues } from '@tanssi/chopsticks-core'
import {
  InherentProviders,
  ParaInherentEnter,
  SetBabeRandomness,
  SetNimbusAuthorInherent,
  SetTimestamp,
  SetValidationData,
} from '@tanssi/chopsticks-core/blockchain/inherent/index.js'
import { SqliteDatabase } from '@tanssi/chopsticks-db'
import { createServer } from '@tanssi/chopsticks/server.js'
import { defer } from '@tanssi/chopsticks-core/utils/index.js'
import { genesisFromUrl } from '@tanssi/chopsticks/context.js'
import { handler } from '@tanssi/chopsticks/rpc/index.js'

export { expectJson, expectHex, testingPairs } from '@tanssi/chopsticks-testing'

export type SetupOption = {
  endpoint?: string
  blockHash?: HexString
  mockSignatureHost?: boolean
  allowUnresolvedImports?: boolean
  genesis?: string
  registeredTypes?: RegisteredTypes
  runtimeLogLevel?: number
}

export const env = {
  acala: {
    endpoint: 'wss://acala-rpc.aca-api.network',
    // 3,800,000
    blockHash: '0x0df086f32a9c3399f7fa158d3d77a1790830bd309134c5853718141c969299c7' as HexString,
  },
  rococo: {
    endpoint: 'wss://rococo-rpc.polkadot.io',
    blockHash: '0xd7fef00504decd41d5d2e9a04346f6bc639fd428083e3ca941f636a8f88d456a' as HexString,
  },
  mandalaGenesis: {
    genesis:
      'https://raw.githubusercontent.com/AcalaNetwork/Acala/2c43dbbb380136f2c35bd0db08b286f346b71d61/resources/mandala-dist.json',
  },
}

export const setupAll = async ({
  endpoint,
  blockHash,
  mockSignatureHost,
  allowUnresolvedImports,
  genesis,
  registeredTypes = {},
  runtimeLogLevel,
}: SetupOption) => {
  let provider: ProviderInterface
  if (genesis) {
    provider = await genesisFromUrl(genesis)
  } else if (/^(https|http):\/\//.test(endpoint || '')) {
    provider = new HttpProvider(endpoint)
  } else {
    provider = new WsProvider(endpoint, 3_000)
  }
  const api = new Api(provider)

  await api.isReady

  const header = await api.getHeader(blockHash)
  if (!header) {
    throw new Error(`Cannot find header for ${blockHash}`)
  }

  return {
    async setup() {
      const inherents = new InherentProviders(new SetTimestamp(), [
        new SetValidationData(),
        new ParaInherentEnter(),
        new SetNimbusAuthorInherent(),
        new SetBabeRandomness(),
        new SetLatestAuthorData(),
      ])

      blockHash ??= await api.getBlockHash().then((hash) => hash ?? undefined)
      if (!blockHash) {
        throw new Error('Cannot find block hash')
      }

      const chain = new Blockchain({
        api,
        buildBlockMode: BuildBlockMode.Manual,
        inherentProvider: inherents,
        header: {
          hash: blockHash,
          number: Number(header.number),
        },
        mockSignatureHost,
        allowUnresolvedImports,
        registeredTypes,
        runtimeLogLevel,
        db: !process.env.RUN_TESTS_WITHOUT_DB ? new SqliteDatabase('e2e-tests-db.sqlite') : undefined,
      })

      const { port, close } = await createServer(handler({ chain }))

      const ws = new WsProvider(`ws://localhost:${port}`, 3_000, undefined, 300_000)
      const apiPromise = await ApiPromise.create({
        provider: ws,
        noInitWarn: true,
      })

      await apiPromise.isReady

      return {
        chain,
        ws,
        api: apiPromise,
        async teardown() {
          await apiPromise.disconnect()
          await delay(100)
          await close()
        },
      }
    },
    async teardownAll() {
      await delay(100)
      await api.disconnect()
    },
  }
}

export let api: ApiPromise
export let chain: Blockchain
export let ws: WsProvider

export const setupApi = (option: SetupOption) => {
  let setup: Awaited<ReturnType<typeof setupAll>>['setup']

  beforeAll(async () => {
    const res = await setupAll(option)
    setup = res.setup

    return res.teardownAll
  })

  beforeEach(async () => {
    const res = await setup()
    api = res.api
    chain = res.chain
    ws = res.ws

    return res.teardown
  })
}

type CodecOrArray = Codec | Codec[]

export const matchSnapshot = (codec: CodecOrArray | Promise<CodecOrArray>) => {
  return expect(
    Promise.resolve(codec).then((x) => (Array.isArray(x) ? x.map((x) => x.toHuman()) : x.toHuman())),
  ).resolves.toMatchSnapshot()
}

export const dev = {
  newBlock: (param?: { count?: number; to?: number }): Promise<string> => {
    return ws.send('dev_newBlock', [param])
  },
  setStorage: (values: StorageValues, blockHash?: string) => {
    return ws.send('dev_setStorage', [values, blockHash])
  },
  timeTravel: (date: string | number) => {
    return ws.send<number>('dev_timeTravel', [date])
  },
  setHead: (hashOrNumber: string | number) => {
    return ws.send('dev_setHead', [hashOrNumber])
  },
}

export const mockCallback = () => {
  let next = defer()
  const callback = vi.fn((...args) => {
    delay(100).then(() => {
      next.resolve(args)
      next = defer()
    })
  })

  return {
    callback,
    async next() {
      return next.promise
    },
  }
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export { defer }

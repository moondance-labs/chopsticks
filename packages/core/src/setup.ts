import '@polkadot/types-codec'
import { HexString } from '@polkadot/util/types'
import { HttpProvider, WsProvider } from '@polkadot/rpc-provider'
import { ProviderInterface } from '@polkadot/rpc-provider/types'
import { RegisteredTypes } from '@polkadot/types/types'

import { Api } from './api.js'
import { Blockchain } from './blockchain/index.js'
import { BuildBlockMode } from './blockchain/txpool.js'
import { Database } from './database.js'
import { GenesisProvider } from './genesis-provider.js'
import {
  InherentProviders,
  ParaInherentEnter,
  SetBabeRandomness,
  SetNimbusAuthorInherent,
  SetTimestamp,
  SetValidationData,
} from './blockchain/inherent/index.js'
import { defaultLogger } from './logger.js'
import { SetLatestAuthorData } from './blockchain/inherent/parachain/latest-author.js'

export type SetupOptions = {
  endpoint?: string
  block?: string | number | null
  genesis?: GenesisProvider
  buildBlockMode?: BuildBlockMode
  db?: Database
  mockSignatureHost?: boolean
  allowUnresolvedImports?: boolean
  runtimeLogLevel?: number
  registeredTypes?: RegisteredTypes
  offchainWorker?: boolean
  maxMemoryBlockCount?: number
}

export const setup = async (options: SetupOptions) => {
  let provider: ProviderInterface
  if (options.genesis) {
    provider = options.genesis
  } else if (/^(https|http):\/\//.test(options.endpoint || '')) {
    provider = new HttpProvider(options.endpoint)
  } else {
    provider = new WsProvider(options.endpoint, 3_000)
  }
  const api = new Api(provider)
  await api.isReady

  let blockHash: string
  if (options.block == null) {
    blockHash = await api.getBlockHash().then((hash) => {
      if (!hash) {
        // should not happen, but just in case
        throw new Error('Cannot find block hash')
      }
      return hash
    })
  } else if (typeof options.block === 'string' && options.block.startsWith('0x')) {
    blockHash = options.block as string
  } else if (Number.isInteger(+options.block)) {
    blockHash = await api.getBlockHash(Number(options.block)).then((hash) => {
      if (!hash) {
        throw new Error(`Cannot find block hash for ${options.block}`)
      }
      return hash
    })
  } else {
    throw new Error(`Invalid block number or hash: ${options.block}`)
  }

  defaultLogger.debug({ ...options, blockHash }, 'Args')

  const header = await api.getHeader(blockHash)
  if (!header) {
    throw new Error(`Cannot find header for ${blockHash}`)
  }

  const inherents = new InherentProviders(new SetTimestamp(), [
    new SetValidationData(),
    new ParaInherentEnter(),
    new SetNimbusAuthorInherent(),
    new SetBabeRandomness(),
    new SetLatestAuthorData(),
  ])

  return new Blockchain({
    api,
    buildBlockMode: options.buildBlockMode,
    inherentProvider: inherents,
    db: options.db,
    header: {
      hash: blockHash as HexString,
      number: Number(header.number),
    },
    mockSignatureHost: options.mockSignatureHost,
    allowUnresolvedImports: options.allowUnresolvedImports,
    runtimeLogLevel: options.runtimeLogLevel,
    registeredTypes: options.registeredTypes || {},
    offchainWorker: options.offchainWorker,
    maxMemoryBlockCount: options.maxMemoryBlockCount,
  })
}

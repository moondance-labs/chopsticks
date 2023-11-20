import {
  AccountInfo,
  ApplyExtrinsicResult,
  Call,
  ConsensusEngineId,
  Header,
  RawBabePreDigest,
  TransactionValidityError,
} from '@polkadot/types/interfaces'
import { Block } from './block.js'
import { Blockchain } from './index.js'
import { Bytes, GenericExtrinsic } from '@polkadot/types'
import { HexString } from '@polkadot/util/types'
import { StorageLayer, StorageValueKind } from './storage-layer.js'
import { TaskCallResponse } from '../wasm-executor/index.js'
import { compactAddLength, hexToU8a, stringToHex, u8aConcat, u8aToBigInt } from '@polkadot/util'
import { compactHex } from '../utils/index.js'
import { defaultLogger, truncate } from '../logger.js'
import { getCurrentSlot } from '../utils/time-travel.js'

const logger = defaultLogger.child({ name: 'block-builder' })

const parseHeader = (header: Header) => {
  if (header.digest.logs.length === 0) {
    return {}
  }
  const preRuntimes = header.digest.logs
    .filter((log) => log.isPreRuntime)!
    .map((digestItem) => ({ consensusEngine: digestItem.asPreRuntime[0], slot: digestItem.asPreRuntime[1] }))!
  const rest = header.digest.logs.filter((log) => !log.isPreRuntime)!

  return { preRuntimes, rest }
}

const getAuraAuthorities = async (chain: Blockchain) => {
  const registry = (await chain.head.meta).registry
  const rawResponse = await chain.head.call('AuraApi_authorities', [])
  const authorities = registry.createType('Vec<AuthorityId>', hexToU8a(rawResponse.result))
  return authorities
}

const getNotingAuthorities = async (chain: Blockchain) => {
  const meta = await chain.head.meta
  const authorities = await chain.head.read(
    'Vec<NimbusPrimitivesNimbusCryptoPublic>',
    meta.query.authoritiesNoting.authorities,
  )
  return authorities!
}

type PreRuntime = {
  consensusEngine: ConsensusEngineId
  slot: Bytes
}

const isContainerChain = async (chain: Blockchain) => (await chain.head.meta).query.authoritiesNoting !== undefined

const isTanssi = (preRuntimes: PreRuntime[]) =>
  preRuntimes?.find(({ consensusEngine }) => consensusEngine.isAura) &&
  preRuntimes?.find(({ consensusEngine }) => consensusEngine.isNimbus)

const getNewSlot = (digest: RawBabePreDigest, slotNumber: number) => {
  if (digest.isPrimary) {
    return {
      primary: {
        ...digest.asPrimary.toJSON(),
        slotNumber,
      },
    }
  }
  if (digest.isSecondaryPlain) {
    return {
      secondaryPlain: {
        ...digest.asSecondaryPlain.toJSON(),
        slotNumber,
      },
    }
  }
  if (digest.isSecondaryVRF) {
    return {
      secondaryVRF: {
        ...digest.asSecondaryVRF.toJSON(),
        slotNumber,
      },
    }
  }
  return digest.toJSON()
}

export const newHeader = async (head: Block, unsafeBlockHeight?: number) => {
  const meta = await head.meta
  const parentHeader = await head.header

  let newLogs = parentHeader.digest.logs as any

  const { preRuntimes, rest } = parseHeader(parentHeader)

  // Tanssi Consensus Logic
  if (preRuntimes && isTanssi(preRuntimes)) {
    const authorities = (await isContainerChain(head.chain))
      ? await getNotingAuthorities(head.chain)
      : await getAuraAuthorities(head.chain)
    const auraBlob = preRuntimes?.find((x) => x.consensusEngine.isAura)
    const nimbusBlob = preRuntimes?.find((x) => x.consensusEngine.toString() == 'nmbs')

    const prevSlot = Number(newLogs[0].asPreRuntime[1].reverse().toHex())
    const newSlot = compactAddLength(meta.registry.createType('Slot', prevSlot + 1).toU8a())
    const newKey = (await isContainerChain(head.chain))
      ? authorities[0]
      : meta.registry.createType('NimbusPrimitivesNimbusCryptoPublic', authorities[(prevSlot + 1) % authorities.length])

    newLogs = [
      { PreRuntime: [auraBlob!.consensusEngine, newSlot] },
      { PreRuntime: [nimbusBlob?.consensusEngine, newKey] },
      ...rest!,
    ]
  } else {
    const { consensusEngine, slot: originalSlot } = preRuntimes![0]

    // Standard Consensus Logic
    if (consensusEngine.isAura) {
      // Get slot from previous digest (reversed to get big endian value)
      const prevSlot = u8aToBigInt(originalSlot, { isLe: true })
      const newSlot = compactAddLength(meta.registry.createType('Slot', prevSlot + 1n).toU8a())
      newLogs = [{ PreRuntime: [consensusEngine, newSlot] }, ...rest!]
    } else if (consensusEngine.isBabe) {
      const slot = await getCurrentSlot(head.chain)
      const digest = meta.registry.createType<RawBabePreDigest>('RawBabePreDigest', slot)
      const newSlot = compactAddLength(
        meta.registry.createType('RawBabePreDigest', getNewSlot(digest, slot + 1)).toU8a(),
      )
      newLogs = [{ PreRuntime: [consensusEngine, newSlot] }, ...rest!]
    } else if (consensusEngine?.toString() == 'nmbs') {
      const nmbsKey = stringToHex('nmbs')
      newLogs = [
        {
          // Using previous block author
          PreRuntime: [
            consensusEngine,
            parentHeader.digest.logs
              .find((log) => log.isPreRuntime && log.asPreRuntime[0].toHex() == nmbsKey)
              ?.asPreRuntime[1].toHex(),
          ],
        },
        ...rest!,
      ]

      if (meta.query.randomness) {
        // TODO: shouldn't modify existing head
        // reset notFirstBlock so randomness will skip validation
        head.pushStorageLayer().set(compactHex(meta.query.randomness.notFirstBlock()), StorageValueKind.Deleted)
      }
    }
  }

  const header = meta.registry.createType<Header>('Header', {
    parentHash: head.hash,
    number: unsafeBlockHeight ?? head.number + 1,
    stateRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    extrinsicsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    digest: {
      logs: newLogs,
    },
  })

  return header
}

const initNewBlock = async (
  head: Block,
  header: Header,
  inherents: HexString[],
  storageLayer?: StorageLayer,
  callback?: BuildBlockCallbacks,
) => {
  const blockNumber = header.number.toNumber()
  const hash: HexString = `0x${Math.round(Math.random() * 100000000)
    .toString(16)
    .padEnd(64, '0')}`
  const newBlock = new Block(head.chain, blockNumber, hash, head, {
    header,
    extrinsics: [],
    storage: storageLayer ?? head.storage,
  })

  {
    // initialize block
    const resp = await newBlock.call('Core_initialize_block', [header.toHex()])
    newBlock.pushStorageLayer().setAll(resp.storageDiff)

    callback?.onPhaseApplied?.('initialize', resp)
  }

  const layers: StorageLayer[] = []
  // apply inherents
  for (const extrinsic of inherents) {
    try {
      const resp = await newBlock.call('BlockBuilder_apply_extrinsic', [extrinsic])
      const layer = newBlock.pushStorageLayer()
      layer.setAll(resp.storageDiff)
      layers.push(layer)

      callback?.onPhaseApplied?.(layers.length - 1, resp)
    } catch (e) {
      logger.warn('Failed to apply inherents %o %s', e, e)
      throw new Error('Failed to apply inherents')
    }
  }

  return {
    block: newBlock,
    layers: layers,
  }
}

export type BuildBlockCallbacks = {
  onApplyExtrinsicError?: (extrinsic: HexString, error: TransactionValidityError) => void
  onPhaseApplied?: (phase: 'initialize' | 'finalize' | number, resp: TaskCallResponse) => void
}

export const buildBlock = async (
  head: Block,
  inherents: HexString[],
  extrinsics: HexString[],
  ump: Record<number, HexString[]>,
  callbacks?: BuildBlockCallbacks,
  unsafeBlockHeight?: number,
): Promise<[Block, HexString[]]> => {
  const registry = await head.registry
  const header = await newHeader(head, unsafeBlockHeight)
  const newBlockNumber = header.number.toNumber()

  logger.info(
    {
      number: newBlockNumber,
      extrinsicsCount: extrinsics.length,
      umpCount: Object.keys(ump).length,
    },
    `Try building block #${newBlockNumber.toLocaleString()}`,
  )

  let layer: StorageLayer | undefined
  // apply ump via storage override hack
  if (Object.keys(ump).length > 0) {
    const meta = await head.meta
    layer = new StorageLayer(head.storage)
    for (const [paraId, upwardMessages] of Object.entries(ump)) {
      const upwardMessagesU8a = upwardMessages.map((x) => hexToU8a(x))
      const messagesCount = upwardMessages.length
      const messagesSize = upwardMessagesU8a.map((x) => x.length).reduce((s, i) => s + i, 0)

      if (meta.query.ump) {
        const queueSize = meta.registry.createType('(u32, u32)', [messagesCount, messagesSize])

        const messages = meta.registry.createType('Vec<Bytes>', upwardMessages)

        // TODO: make sure we append instead of replace
        layer.setAll([
          [compactHex(meta.query.ump.relayDispatchQueues(paraId)), messages.toHex()],
          [compactHex(meta.query.ump.relayDispatchQueueSize(paraId)), queueSize.toHex()],
        ])
      } else if (meta.query.messageQueue) {
        // TODO: make sure we append instead of replace
        const origin = { ump: { para: paraId } }

        let last = 0
        let heap = new Uint8Array(0)

        for (const message of upwardMessagesU8a) {
          const payloadLen = message.length
          const header = meta.registry.createType('(u32, bool)', [payloadLen, false])
          last = heap.length
          heap = u8aConcat(heap, header.toU8a(), message)
        }

        layer.setAll([
          [
            compactHex(meta.query.messageQueue.bookStateFor(origin)),
            meta.registry
              .createType('PalletMessageQueueBookState', {
                begin: 0,
                end: 1,
                count: 1,
                readyNeighbours: { prev: origin, next: origin },
                messageCount: messagesCount,
                size_: messagesSize,
              })
              .toHex(),
          ],
          [
            compactHex(meta.query.messageQueue.serviceHead(origin)),
            meta.registry.createType('PolkadotRuntimeParachainsInclusionAggregateMessageOrigin', origin).toHex(),
          ],
          [
            compactHex(meta.query.messageQueue.pages(origin, 0)),
            meta.registry
              .createType('PalletMessageQueuePage', {
                remaining: messagesCount,
                remaining_size: messagesSize,
                first_index: 0,
                first: 0,
                last,
                heap: compactAddLength(heap),
              })
              .toHex(),
          ],
        ])
      } else {
        throw new Error('Unknown ump storage')
      }

      logger.trace({ paraId, upwardMessages: truncate(upwardMessages) }, 'Pushed UMP')
    }

    if (meta.query.ump) {
      const needsDispatch = meta.registry.createType('Vec<u32>', Object.keys(ump))
      layer.set(compactHex(meta.query.ump.needsDispatch()), needsDispatch.toHex())
    }
  }

  const { block: newBlock } = await initNewBlock(head, header, inherents, layer)

  const pendingExtrinsics: HexString[] = []
  const includedExtrinsic: HexString[] = []

  // apply extrinsics
  for (const extrinsic of extrinsics) {
    try {
      const resp = await newBlock.call('BlockBuilder_apply_extrinsic', [extrinsic])
      const outcome = registry.createType<ApplyExtrinsicResult>('ApplyExtrinsicResult', resp.result)
      if (outcome.isErr) {
        callbacks?.onApplyExtrinsicError?.(extrinsic, outcome.asErr)
        continue
      }
      newBlock.pushStorageLayer().setAll(resp.storageDiff)
      includedExtrinsic.push(extrinsic)

      callbacks?.onPhaseApplied?.(includedExtrinsic.length - 1, resp)
    } catch (e) {
      logger.info('Failed to apply extrinsic %o %s', e, e)
      pendingExtrinsics.push(extrinsic)
    }
  }

  {
    // finalize block
    const resp = await newBlock.call('BlockBuilder_finalize_block', [])

    newBlock.pushStorageLayer().setAll(resp.storageDiff)

    callbacks?.onPhaseApplied?.('finalize', resp)
  }

  const blockData = registry.createType('Block', {
    header,
    extrinsics: includedExtrinsic,
  })

  const storageDiff = await newBlock.storageDiff()

  if (logger.level.toLowerCase() === 'trace') {
    logger.trace(
      Object.entries(storageDiff).map(([key, value]) => [key, truncate(value)]),
      'Final block',
    )
  }

  const finalBlock = new Block(head.chain, newBlock.number, blockData.hash.toHex(), head, {
    header,
    extrinsics: [...inherents, ...includedExtrinsic],
    storage: head.storage,
    storageDiff,
  })

  logger.info(
    {
      number: newBlock.number,
      hash: finalBlock.hash,
      extrinsics: truncate(includedExtrinsic),
      pendingExtrinsicsCount: pendingExtrinsics.length,
      ump: truncate(ump),
    },
    'Block built',
  )

  return [finalBlock, pendingExtrinsics]
}

export const dryRunExtrinsic = async (
  head: Block,
  inherents: HexString[],
  extrinsic: HexString | { call: HexString; address: string },
): Promise<TaskCallResponse> => {
  const registry = await head.registry
  const header = await newHeader(head)
  const { block: newBlock } = await initNewBlock(head, header, inherents)

  if (typeof extrinsic !== 'string') {
    if (!head.chain.mockSignatureHost) {
      throw new Error(
        'Cannot fake signature because mock signature host is not enabled. Start chain with `mockSignatureHost: true`',
      )
    }

    const meta = await head.meta
    const call = registry.createType<Call>('Call', hexToU8a(extrinsic.call))
    const generic = registry.createType<GenericExtrinsic>('GenericExtrinsic', call)

    const accountRaw = await head.get(compactHex(meta.query.system.account(extrinsic.address)))
    const account = registry.createType<AccountInfo>('AccountInfo', hexToU8a(accountRaw))

    generic.signFake(extrinsic.address, {
      blockHash: head.hash,
      genesisHash: head.hash,
      runtimeVersion: await head.runtimeVersion,
      nonce: account.nonce,
    })

    const mockSignature = new Uint8Array(64)
    mockSignature.fill(0xcd)
    mockSignature.set([0xde, 0xad, 0xbe, 0xef])
    generic.signature.set(mockSignature)

    defaultLogger.info({ call: call.toHuman() }, 'dry_run_call')

    return newBlock.call('BlockBuilder_apply_extrinsic', [generic.toHex()])
  }

  defaultLogger.info(
    { call: registry.createType('GenericExtrinsic', hexToU8a(extrinsic)).toHuman() },
    'dry_run_extrinsic',
  )
  return newBlock.call('BlockBuilder_apply_extrinsic', [extrinsic])
}

export const dryRunInherents = async (
  head: Block,
  inherents: HexString[],
): Promise<[HexString, HexString | null][]> => {
  const header = await newHeader(head)
  const { layers } = await initNewBlock(head, header, inherents)
  const storage = {}
  for (const layer of layers) {
    await layer.mergeInto(storage)
  }
  return Object.entries(storage) as [HexString, HexString | null][]
}

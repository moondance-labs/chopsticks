import { GenericExtrinsic } from '@polkadot/types'
import { HexString } from '@polkadot/util/types'

import { Block } from '../../block.js'
import { BuildBlockParams } from '../../txpool.js'
import { CreateInherents } from '../index.js'

export type LatestAuthorData = {
  relayStorageProof: {
    trieNodes: HexString[]
  }
}

const MOCK_LATEST_AUTHOR = {
  relayStorageProof: {
    trieNodes: [],
  },
} satisfies LatestAuthorData

export class SetLatestAuthorData implements CreateInherents {
  async createInherents(parent: Block, _params: BuildBlockParams): Promise<HexString[]> {
    const meta = await parent.meta
    if (!meta.tx.authorNoting?.setLatestAuthorData) {
      return []
    }

    const data = MOCK_LATEST_AUTHOR

    const inherent = new GenericExtrinsic(meta.registry, meta.tx.authorNoting.setLatestAuthorData(data))

    return [inherent.toHex()]
  }
}

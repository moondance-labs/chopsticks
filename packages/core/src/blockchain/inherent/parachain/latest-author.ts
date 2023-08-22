import { GenericExtrinsic } from '@polkadot/types'
import { HexString } from '@polkadot/util/types'

import { Block } from '../../block'
import { BuildBlockParams } from '../../txpool'
import { CreateInherents } from '..'

const MOCK_LATEST_AUTHOR = {
  relayStorageProof: {
    trieNodes: [],
  },
}

export type LatestAuthorData = {
  relayStorageProof: {
    trieNodes: HexString[]
  }
}

export class SetLatestAuthorData implements CreateInherents {
  async createInherents(parent: Block, _params: BuildBlockParams): Promise<HexString[]> {
    const meta = await parent.meta
    if (!meta.tx.authorNoting?.setLatestAuthorData) {
      return []
    }

    let data: LatestAuthorData

    data =  MOCK_LATEST_AUTHOR as LatestAuthorData

    const inherent = new GenericExtrinsic(meta.registry, meta.tx.authorNoting.setLatestAuthorData(data))

    return [inherent.toHex()]
  }
}

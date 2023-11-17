import { beforeEach, describe, it } from 'vitest'

import { DownwardMessage } from '@tanssi/chopsticks-core/blockchain/txpool'
import { connectDownward } from '@tanssi/chopsticks-core/xcm/downward'
import { connectUpward } from '@tanssi/chopsticks-core/xcm/upward'
import { matchSystemEvents, testingPairs } from '@tanssi/chopsticks-testing'
import { setStorage } from '@tanssi/chopsticks-core/utils/set-storage'

import { matchSnapshot } from './helper.js'
import networks, { Network } from './networks.js'

const downwardMessages: DownwardMessage[] = [
  {
    sentAt: 1,
    msg: '0x0210010400010000078155a74e390a1300010000078155a74e39010300286bee0d01000400010100c0cbffafddbe39f71f0190c2369adfc59eaa4c81a308ebcad88cdd9c400ba57c',
  },
]

describe('XCM', async () => {
  let acala: Network
  let polkadot: Network

  beforeEach(async () => {
    acala = await networks.acala()
    polkadot = await networks.polkadot()

    return async () => {
      await acala.teardown()
      await polkadot.teardown()
    }
  })

  it('Acala handles downward messages', async () => {
    await acala.chain.newBlock({ downwardMessages })
    await matchSystemEvents(acala)
  })

  it('Polkadot send downward messages to Acala', async () => {
    await connectDownward(polkadot.chain, acala.chain)

    const { alice } = testingPairs()

    polkadot.dev.setStorage({
      System: {
        Account: [[[alice.address], { data: { free: 1000 * 1e10 } }]],
      },
    })

    await polkadot.api.tx.xcmPallet
      .reserveTransferAssets(
        { V0: { X1: { Parachain: 2000 } } },
        {
          V0: {
            X1: {
              AccountId32: {
                network: 'Any',
                id: alice.addressRaw,
              },
            },
          },
        },
        {
          V0: [
            {
              ConcreteFungible: { id: 'Null', amount: 100e10 },
            },
          ],
        },
        0,
      )
      .signAndSend(alice)

    await polkadot.chain.newBlock()
    await matchSystemEvents(polkadot)

    await acala.chain.newBlock()
    await matchSystemEvents(acala)
  })

  it('Acala send upward messages to Polkadot', async () => {
    await connectUpward(acala.chain, polkadot.chain)

    const { alice } = testingPairs()

    await setStorage(acala.chain, {
      System: {
        Account: [[[alice.address], { data: { free: 1000 * 1e10 } }]],
      },
      Tokens: {
        Accounts: [[[alice.address, { token: 'DOT' }], { free: 1000e10 }]],
      },
    })

    await matchSnapshot(polkadot.api.query.system.account(alice.address))
    await matchSnapshot(acala.api.query.system.account(alice.address))
    await matchSnapshot(acala.api.query.tokens.accounts(alice.address, { token: 'DOT' }))

    await acala.api.tx.xTokens
      .transfer(
        {
          Token: 'DOT',
        },
        10e10,
        {
          V1: {
            parents: 1,
            interior: {
              X1: {
                AccountId32: {
                  network: 'Any',
                  id: alice.addressRaw,
                },
              },
            },
          },
        },
        {
          Unlimited: null,
        },
      )
      .signAndSend(alice)

    await acala.chain.newBlock()
    await matchSystemEvents(acala)
    await matchSnapshot(acala.api.query.tokens.accounts(alice.address, { token: 'DOT' }))

    await polkadot.chain.newBlock()

    await matchSnapshot(polkadot.api.query.system.account(alice.address))
    await matchSystemEvents(polkadot)
  })
})

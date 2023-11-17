import { Blockchain } from '../blockchain/index.js'
import { defaultLogger } from '../logger.js'

export const logger = defaultLogger.child({ name: 'rpc' })

export class ResponseError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ResponseError'
    this.code = code
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
    }
  }
}

export interface Context {
  /**
   * The blockchain instance
   */
  chain: Blockchain
}

export interface SubscriptionManager {
  subscribe: (method: string, subid: string, onCancel?: () => void) => (data: any) => void
  unsubscribe: (subid: string) => void
}

export type Handler<TParams = any, TReturn = any> = (
  context: Context,
  params: TParams,
  subscriptionManager: SubscriptionManager,
) => Promise<TReturn>
export type Handlers = Record<string, Handler>

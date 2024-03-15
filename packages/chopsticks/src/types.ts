/**
 * Chopsticks JSON RPC and CLI.
 *
 * @remarks
 * This package extends the `@tanssi/chopsticks-core` package a with JSON RPC server and CLI support.
 *
 * @privateRemarks
 * Above is the package documentation for 'chopsticks' package.
 * `export` below is for tsdoc.
 *
 * @packageDocumentation
 */
export type {
  ChainProperties,
  RuntimeVersion,
  Context,
  SubscriptionManager,
  Handler,
} from '@tanssi/chopsticks-core'
export * from '@tanssi/chopsticks-core/rpc/substrate/index.js'
export * as DevRPC from '@tanssi/chopsticks-core/rpc/dev/index.js'
export * from './plugins/types.js'

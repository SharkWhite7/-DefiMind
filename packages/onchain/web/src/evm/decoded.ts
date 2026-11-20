import { USDC_DECIMALS } from '@defimind/shared'
import {
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem'
import { allowanceModuleAbi } from '../../../src/evm/safe.js'
import { MULTI_SEND_CALL_ONLY, safeAbi } from './calls.js'

const abi = [
  ...safeAbi,
  ...allowanceModuleAbi,
  ...erc20Abi,
  ...parseAbi([
    'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
    'function multiSend(bytes transactions) payable',
    'function enableModule(address module)',
  ]),
]

const units = (amount: bigint) =>
  `${formatUnits(amount, USDC_DECIMALS)} (${amount} base units at ${USDC_DECIMALS} decimals)`
const UNKNOWN = 'A call this page cannot read: reject this transaction.'

/**
 * What the call Phantom is about to send does, read from its bytes alone and not from the link or
 * whoever served the page: who gains a right or receives tokens, and how much. Anything it cannot
 * read is named as such, for the owner to reject.
 */
export function decodeEvm(to: Address, data: Hex): string[] {
  let call
  try {
    call = decodeFunctionData({ abi, data })
  } catch {
    return [UNKNOWN]
  }
  const { functionName, args } = call
  switch (functionName) {
    case 'transfer': {
      const [recipient, amount] = args
      return [`Send ${units(amount)} of token ${to} to ${recipient}.`]
    }
    case 'createProxyWithNonce': {
      const [, initializer] = args
      const setup = decodeFunctionData({ abi: safeAbi, data: initializer })
      if (setup.functionName !== 'setup') return [UNKNOWN]
      const [owners, threshold] = setup.args
      return [`Create a Safe owned by ${owners.join(', ')}, threshold ${threshold}.`]
    }
    case 'execTransaction': {
      const [target, value, inner, operation] = args
      if (value !== 0n) return [`The Safe sends ${value} wei of its own coin: reject this.`]
      if (operation === 1) {
        return isAddressEqual(target, MULTI_SEND_CALL_ONLY) ? batch(inner) : [UNKNOWN]
      }
      return inside(target, inner)
    }
    default:
      return [UNKNOWN]
  }
}

/** A call the Safe makes itself. */
function inside(to: Address, data: Hex): string[] {
  let call
  try {
    call = decodeFunctionData({ abi, data })
  } catch {
    return [UNKNOWN]
  }
  const { functionName, args } = call
  switch (functionName) {
    case 'enableModule':
      return [`Enable module ${args[0]} on the Safe.`]
    case 'addDelegate':
      return [`Make ${args[0]} a delegate of module ${to}.`]
    case 'removeDelegate':
      return [`Remove ${args[0]} as a delegate of module ${to}, with its allowances.`]
    case 'setAllowance': {
      const [delegate, token, amount, resetMin] = args
      return [`Let ${delegate} draw ${units(amount)} of token ${token}, every ${resetMin} minutes.`]
    }
    default:
      return [UNKNOWN]
  }
}

/** MultiSend's packed list: operation, to, value, data length, data. */
function batch(data: Hex): string[] {
  const call = decodeFunctionData({ abi, data })
  if (call.functionName !== 'multiSend') return [UNKNOWN]
  const packed = call.args[0] as Hex
  const lines: string[] = []
  for (let at = 0; at < size(packed);) {
    const operation = Number(slice(packed, at, at + 1))
    const to = getAddress(slice(packed, at + 1, at + 21))
    const value = BigInt(slice(packed, at + 21, at + 53))
    const length = Number(BigInt(slice(packed, at + 53, at + 85)))
    const inner = length ? slice(packed, at + 85, at + 85 + length) : '0x'
    lines.push(...(operation !== 0 || value !== 0n ? [UNKNOWN] : inside(to, inner)))
    at += 85 + length
  }
  return lines
}

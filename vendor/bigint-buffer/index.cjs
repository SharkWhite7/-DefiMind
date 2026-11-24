'use strict'
/* global Buffer, module */
// bigint-buffer 1.1.5's JavaScript fallback, verbatim in behaviour. The upstream package's native
// toBigIntLE overflows (GHSA-3gc7-fjrx-p6mg) and has no fixed release, so the binding is gone here.

function fromHex(hex) {
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`)
}

function toBigIntLE(buf) {
  return fromHex(Buffer.from(buf).reverse().toString('hex'))
}

function toBigIntBE(buf) {
  return fromHex(Buffer.from(buf).toString('hex'))
}

function toBufferBE(num, width) {
  const hex = num.toString(16)
  return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex')
}

function toBufferLE(num, width) {
  return toBufferBE(num, width).reverse()
}

module.exports = { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE }

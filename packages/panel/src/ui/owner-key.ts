import { card, el } from './dom.js'

/**
 * CR-022, HIGH-3. Facts only: what one key behind every vault means, and the trade-off of the safer
 * set-ups. The vault's threshold and signers join this once guard-core reads them (ON-29, GC-64).
 */
const RISK =
  'One wallet controls every vault you make here. Whoever has its recovery phrase can empty each vault, past every daily limit.'

const SAFER = [
  'Safer: a separate wallet for each chain, or a vault that needs 2 of 3 signatures, one of them on a hardware key.',
  'A 2-of-3 vault is slower to stop in an emergency, because a second signer must sign too. The signing page here works with a one-signer vault; with 2 of 3, you approve changes in Squads or Safe.',
]

/** Where the guide creates the vault: the moment the owner picks the wallet that will control it. */
export function ownerKeyNote() {
  return [el('p', { class: 'flag' }, RISK), el('p', { class: 'muted' }, SAFER[0])]
}

export function ownerKeyCard() {
  return card(
    el('h2', {}, 'Who controls your vaults'),
    el('p', { class: 'flag' }, RISK),
    ...SAFER.map((line) => el('p', {}, line)),
  )
}

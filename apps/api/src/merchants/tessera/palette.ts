export const TESSERA_PALETTE = [
  '#0B0B0C', '#F5F2EA', '#FFFFFF', '#FFB020',
  '#7C4DFF', '#00D3F2', '#C6F432', '#FF3B30',
] as const

export type TesseraColor = typeof TESSERA_PALETTE[number]

export function isTesseraColor(value: unknown): value is TesseraColor {
  return typeof value === 'string' && (TESSERA_PALETTE as readonly string[]).includes(value)
}

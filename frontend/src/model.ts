export type Adjustments = Record<'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks', number>

export const neutralAdjustments: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
}

export interface Selection {
  inPoint: number
  outPoint: number
  coverTime: number
}

export type OutputFormat = 'apple' | 'samsung'
export type WorkspaceMode = 'edit' | 'live'

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function isValidSelection({ inPoint, outPoint, coverTime }: Selection, duration: number) {
  return Number.isFinite(duration) && 0 <= inPoint && inPoint < outPoint && outPoint <= duration &&
    inPoint <= coverTime && coverTime <= outPoint
}

export function timecode(seconds: number) {
  const hundredths = Math.max(0, Math.round(seconds * 100))
  const minutes = Math.floor(hundredths / 6000)
  const wholeSeconds = Math.floor(hundredths / 100) % 60
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`
}

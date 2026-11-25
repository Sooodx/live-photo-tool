import { clamp } from '../model.ts'
import type { Adjustments } from '../model.ts'

type ToneZones = Pick<Adjustments, 'highlights' | 'shadows' | 'whites' | 'blacks'>

export const curveXs = [0, 0.25, 0.5, 0.75, 1] as const

export function toneCurvePoints({ highlights, shadows, whites, blacks }: ToneZones) {
  const h = clamp(highlights / 100, -1, 1)
  const s = clamp(shadows / 100, -1, 1)
  const w = clamp(whites / 100, -1, 1)
  const b = clamp(blacks / 100, -1, 1)
  const ys = [
    b * 0.1,
    0.25 + s * 0.15 + b * 0.1,
    0.5 + s * 0.05 + h * 0.05,
    0.75 + h * 0.15 + w * 0.1,
    1 + w * 0.1,
  ]
  let previous = 0
  return ys.map(value => {
    previous = Math.max(previous, clamp(value, 0, 1))
    // FFmpeg receives the points rounded to four decimals.
    return Number(previous.toFixed(4))
  })
}

export function buildToneCurve(zones: ToneZones): Uint8Array {
  const ys = toneCurvePoints(zones)
  if (ys.every((value, index) => value === curveXs[index])) {
    return Uint8Array.from({ length: 256 }, (_, i) => i)
  }

  // Solve the natural spline's tridiagonal system with zero endpoint curvature.
  const step = curveXs[1] - curveXs[0]
  const second = new Float64Array(ys.length)
  const upper = new Float64Array(ys.length)
  for (let i = 1; i < ys.length - 1; i++) {
    const denominator = 4 * step - step * upper[i - 1]
    const rhs = 6 * ((ys[i + 1] - ys[i]) / step - (ys[i] - ys[i - 1]) / step)
    upper[i] = step / denominator
    second[i] = (rhs - step * second[i - 1]) / denominator
  }
  for (let i = ys.length - 2; i > 0; i--) {
    second[i] -= upper[i] * second[i + 1]
  }

  const samples = new Uint8Array(256)
  for (let i = 0; i < curveXs.length - 1; i++) {
    const start = Math.trunc(curveXs[i] * 255)
    const end = Math.trunc(curveXs[i + 1] * 255)
    const slope = (ys[i + 1] - ys[i]) / step - step * (2 * second[i] + second[i + 1]) / 6
    const cubic = (second[i + 1] - second[i]) / (6 * step)
    // FFmpeg quantizes the knot positions before sampling each interval.
    for (let index = start; index < end; index++) {
      const x = (index - start) / 255
      const y = ys[i] + slope * x + second[i] / 2 * x ** 2 + cubic * x ** 3
      samples[index] = Math.trunc(clamp(y, 0, 1) * 255)
    }
  }
  samples[255] = Math.trunc(ys.at(-1)! * 255)
  return samples
}

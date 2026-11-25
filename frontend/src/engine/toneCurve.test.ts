import assert from 'node:assert/strict'
import test from 'node:test'
import { neutralAdjustments } from '../model.ts'
import { buildToneCurve, toneCurvePoints } from './toneCurve.ts'

test('neutral controls yield exact 8-bit identity', () => {
  assert.deepEqual(buildToneCurve(neutralAdjustments), Uint8Array.from({ length: 256 }, (_, i) => i))
})

test('control points stay monotonic across all extreme slider combinations', () => {
  const keys = ['highlights', 'shadows', 'whites', 'blacks'] as const
  for (let mask = 0; mask < 2 ** keys.length; mask++) {
    const controls = { ...neutralAdjustments }
    keys.forEach((key, bit) => { controls[key] = mask & (1 << bit) ? 100 : -100 })
    const points = toneCurvePoints(controls)
    assert.ok(points.every((value, i) => i === 0 || value >= points[i - 1]))
  }
})

test('sampled curve is monotonic for a representative grade and honors its endpoints', () => {
  const curve = buildToneCurve({ highlights: -10, shadows: 25, whites: -20, blacks: 20 })
  assert.equal(curve.length, 256)
  assert.ok(curve.every((value, i) => i === 0 || value >= curve[i - 1]))
  assert.equal(curve[0], 5)
  assert.equal(curve[63], 78)
  assert.equal(curve[255], 249)
})

test('out-of-range controls and spline values clamp at the boundaries', () => {
  const limits = { highlights: 100, shadows: -100, whites: 100, blacks: -100 }
  const outside = { highlights: 300, shadows: -200, whites: 500, blacks: -120 }
  const curve = buildToneCurve(outside)
  assert.deepEqual(curve, buildToneCurve(limits))
  assert.deepEqual(toneCurvePoints(outside), [0, 0, 0.5, 1, 1])
  assert.equal(curve[0], 0)
  assert.equal(curve[255], 255)
})

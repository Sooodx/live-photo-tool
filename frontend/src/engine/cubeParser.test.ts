import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCube } from './cubeParser.ts'

function cube(size: number, transform = (r: number, g: number, b: number) => [r, g, b]) {
  const rows = [`LUT_3D_SIZE ${size}`]
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(transform(r / (size - 1), g / (size - 1), b / (size - 1)).join(' '))
      }
    }
  }
  return rows.join('\n')
}

test('33-point identity LUT preserves red-fastest texture order', () => {
  const lut = parseCube(cube(33))
  assert.equal(lut.size, 33)
  assert.equal(lut.rgba32f.length, 33 ** 3 * 4)
  assert.deepEqual(lut.domainMin, [0, 0, 0])
  assert.deepEqual(lut.domainMax, [1, 1, 1])
  assert.deepEqual([...lut.rgba32f.slice(4, 8)], [1 / 32, 0, 0, 1])
  assert.deepEqual([...lut.rgba32f.slice(33 * 4, 34 * 4)], [0, 1 / 32, 0, 1])
  assert.deepEqual([...lut.rgba32f.slice(33 ** 2 * 4, 33 ** 2 * 4 + 4)], [0, 0, 1 / 32, 1])
  assert.deepEqual([...lut.rgba8.slice(-4)], [255, 255, 255, 255])
})

test('33-point non-identity LUT parses title, comments and per-channel domains', () => {
  const source = '\uFEFF# Example\r\nTITLE "Swap # channels" # example\r\n' +
    'DOMAIN_MIN -0.5 0.1 0\r\nDOMAIN_MAX 1.5 0.9 2\r\n' +
    cube(33, (r, g, b) => [b, g + 0.5, 1 - r]).replaceAll('\n', '\r\n')
  const lut = parseCube(source)
  assert.equal(lut.title, 'Swap # channels')
  assert.deepEqual(lut.domainMin, [-0.5, 0.1, 0])
  assert.deepEqual(lut.domainMax, [1.5, 0.9, 2])
  assert.deepEqual([...lut.rgba32f.slice(-4)], [1, 1.5, 0, 1])
  assert.deepEqual([...lut.rgba8.slice(-4)], [255, 255, 0, 255])
})

test('65-point LUT produces tightly packed float and byte textures', () => {
  const lut = parseCube(cube(65))
  assert.equal(lut.size, 65)
  assert.equal(lut.rgba8.length, 65 ** 3 * 4)
  const center = (32 + 32 * 65 + 32 * 65 ** 2) * 4
  assert.deepEqual([...lut.rgba32f.slice(center, center + 4)], [0.5, 0.5, 0.5, 1])
  assert.deepEqual([...lut.rgba8.slice(center, center + 4)], [128, 128, 128, 255])
})

test('malformed cubes, unsupported dimensions and inverted domains are rejected', () => {
  assert.throws(() => parseCube('0 0 0'), /LUT_3D_SIZE/)
  assert.throws(() => parseCube('LUT_3D_SIZE 32\n0 0 0'), /33 或 65/)
  assert.throws(() => parseCube('LUT_3D_SIZE 33\n0 0 0'), /行数/)
  assert.throws(() => parseCube('LUT_3D_SIZE 33\nInfinity 0 0'), /RGB/)
  const valid = cube(33)
  assert.throws(() => parseCube(valid + '\n0 0 0'), /超过/)
  assert.throws(() => parseCube('DOMAIN_MIN 0 1 0\n' + valid), /DOMAIN_MAX/)
})

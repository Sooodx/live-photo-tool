type Triple = [number, number, number]

export interface CubeLut {
  title: string | undefined
  size: number
  domainMin: Triple
  domainMax: Triple
  rgba32f: Float32Array
  rgba8: Uint8Array
}

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

function readTriple(tokens: string[], line: number): Triple {
  const values = tokens.map(Number)
  if (tokens.length !== 3 || tokens.some(token => !decimal.test(token)) ||
      values.some(value => !Number.isFinite(Math.fround(value)))) {
    throw new Error(`.cube 第 ${line} 行需要三个有效的 RGB 数值`)
  }
  return [values[0], values[1], values[2]]
}

export function parseCube(source: string): CubeLut {
  let title: string | undefined
  let size = 0
  let domainMin: Triple | undefined
  let domainMax: Triple | undefined
  let rgba32f = new Float32Array()
  let rgba8 = new Uint8Array()
  let offset = 0

  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue

    if (/^TITLE\s/i.test(line)) {
      const match = /^TITLE\s+"([^"]*)"\s*(?:#.*)?$/i.exec(line)
      if (offset || title !== undefined || !match) throw new Error(`.cube 第 ${index + 1} 行 TITLE 无效`)
      title = match[1]
      continue
    }

    const tokens = line.split('#', 1)[0].trim().split(/\s+/)
    const directive = tokens[0].toUpperCase()
    switch (directive) {
      case 'LUT_3D_SIZE':
        if (size || tokens.length !== 2 || !/^(33|65)$/.test(tokens[1])) {
          throw new Error('.cube 仅支持 33 或 65 点 3D LUT')
        }
        size = Number(tokens[1])
        rgba32f = new Float32Array(size ** 3 * 4)
        rgba8 = new Uint8Array(rgba32f.length)
        break
      case 'DOMAIN_MIN':
        if (offset || domainMin) throw new Error('.cube DOMAIN_MIN 重复或位置无效')
        domainMin = readTriple(tokens.slice(1), index + 1)
        break
      case 'DOMAIN_MAX':
        if (offset || domainMax) throw new Error('.cube DOMAIN_MAX 重复或位置无效')
        domainMax = readTriple(tokens.slice(1), index + 1)
        break
      default: {
        if (!size) throw new Error('.cube 缺少 LUT_3D_SIZE 声明')
        if (offset === rgba32f.length) throw new Error('.cube RGB 数据行数超过声明的尺寸')
        const rgb = readTriple(tokens, index + 1)
        // .cube and texImage3D both increment R first, then G, then B.
        rgba32f.set(rgb, offset)
        for (let channel = 0; channel < 3; channel++) {
          rgba8[offset + channel] = Math.round(Math.min(1, Math.max(0, rgb[channel])) * 255)
        }
        rgba32f[offset + 3] = 1
        rgba8[offset + 3] = 255
        offset += 4
      }
    }
  }

  if (!size || offset !== rgba32f.length) throw new Error('.cube RGB 数据行数与声明的尺寸不符')
  const min = domainMin ?? [0, 0, 0]
  const max = domainMax ?? [1, 1, 1]
  if (min.some((value, channel) => Math.fround(value) >= Math.fround(max[channel]))) {
    throw new Error('.cube DOMAIN_MAX 的各通道值必须大于 DOMAIN_MIN')
  }
  return { title, size, domainMin: min, domainMax: max, rgba32f, rgba8 }
}

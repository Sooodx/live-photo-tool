import { parseCube } from './cubeParser'

self.onmessage = ({ data }: MessageEvent<{ id: number; source: string }>) => {
  try {
    const lut = parseCube(data.source)
    self.postMessage({ id: data.id, lut }, { transfer: [lut.rgba8.buffer, lut.rgba32f.buffer] })
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}

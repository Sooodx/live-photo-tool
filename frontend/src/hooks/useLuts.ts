import { useEffect, useRef, useState } from 'react'
import { getLuts, getRawLut, uploadLut } from '../api'
import type { LutInfo } from '../api'
import { parseCube } from '../engine/cubeParser'
import type { CubeLut } from '../engine/cubeParser'

function createLutLoader(signal: AbortSignal) {
  let worker: Worker | undefined
  try {
    worker = new Worker(new URL('../engine/lutWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    // Some browsers restrict workers in private or embedded contexts.
  }
  const cache = new Map<string, Promise<CubeLut>>()
  const requests = new Map<number, { resolve: (lut: CubeLut) => void; reject: (error: unknown) => void }>()
  let requestId = 0

  if (worker) {
    worker.onmessage = ({ data }: MessageEvent<{ id: number; lut?: CubeLut; error?: string }>) => {
      const task = requests.get(data.id)
      requests.delete(data.id)
      if (data.lut) task?.resolve(data.lut)
      else task?.reject(new Error(data.error || 'LUT 解析失败'))
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = undefined
      for (const task of requests.values()) task.reject(new Error('LUT 解析器暂不可用，请重试'))
      requests.clear()
    }
  }
  signal.addEventListener('abort', () => {
    worker?.terminate()
    for (const task of requests.values()) task.reject(signal.reason)
    requests.clear()
    cache.clear()
  }, { once: true })

  const parse = (source: string) => new Promise<CubeLut>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    if (!worker) {
      resolve(parseCube(source))
      return
    }
    const id = ++requestId
    requests.set(id, { resolve, reject })
    worker.postMessage({ id, source })
  })

  const load = (url: string) => {
    const cached = cache.get(url)
    if (cached) return cached
    const result = getRawLut(url, signal).then(parse)
    cache.set(url, result)
    void result.catch(() => {
      if (cache.get(url) === result) cache.delete(url)
    })
    return result
  }

  return { parse, load, remember: (url: string, lut: CubeLut) => cache.set(url, Promise.resolve(lut)) }
}

export function useLuts(sessionId: string, notify: (message: string, isError?: boolean) => void) {
  const [list, setList] = useState<LutInfo[]>([])
  const [requestedId, setRequestedId] = useState('')
  const [active, setActive] = useState<{ id: string; lut: CubeLut } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const context = useRef<{ signal: AbortSignal; loader: ReturnType<typeof createLutLoader> } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const loader = createLutLoader(signal)
    context.current = { signal, loader }

    void getLuts(signal).then(({ luts }) => {
      if (signal.aborted) return
      setList(previous => {
        const ids = new Set(luts.map(lut => lut.id))
        return [...luts, ...previous.filter(lut => !ids.has(lut.id))]
      })
    }).catch(error => {
      if (!signal.aborted) notify(error instanceof Error ? error.message : '无法加载 LUT 列表', true)
    })

    return () => {
      context.current = null
      controller.abort()
    }
  }, [sessionId, notify])

  async function select(id: string, entry = list.find(lut => lut.id === id)) {
    const current = context.current
    if (!current) return
    const revision = ++generation.current
    setRequestedId(id)

    if (!entry) {
      setLoading(false)
      setActive(null)
      return
    }

    setLoading(true)
    try {
      const lut = await current.loader.load(entry.raw_url)
      if (!current.signal.aborted && revision === generation.current) setActive({ id, lut })
    } catch (error) {
      if (current.signal.aborted || revision !== generation.current) return
      setRequestedId(active?.id ?? '')
      notify(error instanceof Error ? error.message : '无法读取 LUT', true)
    } finally {
      if (!current.signal.aborted && revision === generation.current) setLoading(false)
    }
  }

  async function upload(file: File) {
    const current = context.current
    if (!current || uploading) return
    const revision = generation.current
    if (!/\.cube$/i.test(file.name)) {
      notify('请选择 .cube 文件', true)
      return
    }

    setUploading(true)
    try {
      const lut = await current.loader.parse(await file.text())
      if (current.signal.aborted) return
      const result = await uploadLut(file, current.signal)
      if (current.signal.aborted) return
      const entry: LutInfo = {
        id: result.lut_id,
        name: result.name,
        size: result.size,
        raw_url: result.raw_url,
        source: 'custom',
        description: '用户上传',
      }
      current.loader.remember(entry.raw_url, lut)
      setList(previous => previous.some(lut => lut.id === entry.id) ? previous : [...previous, entry])
      if (generation.current === revision) await select(entry.id, entry)
      notify('LUT 已保存到「我的 LUT」')
    } catch (error) {
      if (!current.signal.aborted) notify(error instanceof Error ? error.message : 'LUT 上传失败', true)
    } finally {
      if (!current.signal.aborted) setUploading(false)
    }
  }

  return { list, active, requestedId, select, upload, uploading, loading }
}

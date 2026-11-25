import type { Adjustments, OutputFormat } from './model'

export interface SessionInfo {
  session_id: string
  filename: string
  duration: number
  width: number
  height: number
  fps: number
  has_audio: boolean
  status: SessionStatus['status']
}

export interface SessionStatus {
  session_id: string
  status: 'processing' | 'ready' | 'error'
  proxy_progress: number
  stage: 'proxy' | 'thumbnails' | 'ready' | 'error'
  error: string | null
}

export interface Thumbnail {
  index: number
  time: number
  url: string
}

export interface ThumbnailList {
  count: number
  fps_sample: number
  width: number
  height: number
  items: Thumbnail[]
}

export interface LutInfo {
  id: string
  name: string
  description: string
  source: 'builtin' | 'user' | 'custom'
  size: number
  raw_url: string
}

interface UploadedLut {
  lut_id: string
  name: string
  size: number
  valid: true
  raw_url: string
}

export interface ColorPayload {
  lut_id: string
  lut_intensity: number
  adjustments: Adjustments
}

interface ClipPayload extends ColorPayload {
  in_point: number
  out_point: number
}

interface ExportPayload extends ClipPayload {
  cover_time: number
  format: OutputFormat
  output_name: string
}

const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`
export const proxyUrl = (id: string) => `${sessionPath(id)}/proxy`

function errorMessage(body: unknown, statusText: string) {
  if (body && typeof body === 'object') {
    const data = body as { detail?: unknown; error?: unknown }
    const message = data.detail || data.error
    if (typeof message === 'string') return message
    if (Array.isArray(message)) {
      const details = message.map(entry => entry?.msg).filter(Boolean)
      if (details.length) return details.join('；')
    }
  }
  return statusText || '请求失败，请重试'
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, init)
  if (response.ok) return response
  const body: unknown = await response.json().catch(() => null)
  throw new Error(errorMessage(body, response.statusText))
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json()
}

function postBlob(path: string, body: object, signal?: AbortSignal) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).then(response => response.blob())
}

export function uploadVideo(file: File, onProgress: (progress: number) => void, signal: AbortSignal) {
  return new Promise<SessionInfo>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const xhr = new XMLHttpRequest()
    const cancel = () => xhr.abort()
    xhr.open('POST', '/api/upload')
    xhr.responseType = 'json'
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(100 * event.loaded / event.total)))
    }
    xhr.upload.onload = () => onProgress(100)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.session_id) {
        resolve(xhr.response)
      } else {
        reject(new Error(errorMessage(xhr.response, xhr.statusText)))
      }
    }
    xhr.onerror = () => reject(new Error('视频上传失败，连接已中断'))
    xhr.onabort = () => reject(signal.reason ?? new DOMException('上传已取消', 'AbortError'))
    xhr.onloadend = () => signal.removeEventListener('abort', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

export function waitForSession(id: string, onStatus: (status: SessionStatus) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const path = sessionPath(id)
    let stream: EventSource | undefined
    let timer: number | undefined
    let settled = false
    let polling = false
    let pollFailures = 0
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      stream?.close()
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(signal.reason ?? new DOMException('会话已取消', 'AbortError'))

    const update = (status: SessionStatus) => {
      if (settled || status.session_id !== id) return
      onStatus(status)
      if (status.status === 'ready') finish()
      if (status.status === 'error') finish(new Error(status.error || '无法生成视频代理或缩略图'))
    }

    const poll = async () => {
      try {
        update(await json<SessionStatus>(`${path}/status`, { signal }))
        pollFailures = 0
      } catch (error) {
        if (++pollFailures >= 3) finish(error)
      }
      if (!settled) timer = window.setTimeout(poll, 1200)
    }

    const fallback = () => {
      if (settled || polling) return
      polling = true
      stream?.close()
      window.clearTimeout(timer)
      void poll()
    }

    const receive = (event: Event) => {
      const data = (event as MessageEvent<string>).data
      if (typeof data !== 'string') {
        fallback()
        return
      }
      try {
        const status = JSON.parse(data) as SessionStatus
        if (!['processing', 'ready', 'error'].includes(status?.status)) return
        update(status)
        if (!settled) {
          window.clearTimeout(timer)
          timer = window.setTimeout(fallback, 15_000)
        }
      } catch {
        fallback()
      }
    }

    signal.addEventListener('abort', abort, { once: true })
    if (typeof EventSource === 'undefined') {
      fallback()
      return
    }
    try {
      stream = new EventSource(`${path}/events`)
      for (const event of ['message', 'status', 'progress', 'ready', 'error']) {
        stream.addEventListener(event, receive)
      }
      timer = window.setTimeout(fallback, 15_000)
    } catch {
      fallback()
    }
  })
}

export const getThumbnails = (id: string, signal: AbortSignal) =>
  json<ThumbnailList>(`${sessionPath(id)}/thumbnails`, { signal })

export const getLuts = (id: string, signal: AbortSignal) =>
  json<{ luts: LutInfo[] }>(`/api/luts?session_id=${encodeURIComponent(id)}`, { signal })

export const getRawLut = (url: string, signal: AbortSignal) =>
  request(url, { signal }).then(response => response.text())

export function uploadLut(id: string, file: File, signal: AbortSignal) {
  const body = new FormData()
  body.append('file', file)
  return json<UploadedLut>(`${sessionPath(id)}/lut/upload`, { method: 'POST', body, signal })
}

export const previewFrame = (id: string, body: ColorPayload & { time: number }, signal?: AbortSignal) =>
  postBlob(`${sessionPath(id)}/preview-frame`, body, signal)

export const previewClip = (id: string, body: ClipPayload, signal?: AbortSignal) =>
  postBlob(`${sessionPath(id)}/preview-clip`, body, signal)

export const exportPhoto = (id: string, body: ExportPayload, signal: AbortSignal) =>
  postBlob(`${sessionPath(id)}/export`, body, signal)

export const deleteSession = (id: string) =>
  json<{ deleted: boolean }>(sessionPath(id), { method: 'DELETE' })

import { useCallback, useEffect, useRef, useState } from 'react'
import { previewClip, previewFrame } from '../api'
import type { ColorPayload } from '../api'
import { useBlobUrl } from './useBlobUrl'

interface FrameRange {
  in_point: number
  out_point: number
  cover_time: number
}

export function useExactPreview(sessionId: string, color: ColorPayload, range: FrameRange,
  notify: (message: string, isError?: boolean) => void) {
  const key = JSON.stringify({ color, range })
  const [result, setResult] = useState<{ key: string; clip: Blob; cover: Blob }>()
  const [enabledKey, setEnabledKey] = useState<string>()
  const [busyKey, setBusyKey] = useState<string>()
  const operation = useRef<AbortController | null>(null)

  useEffect(() => () => {
    operation.current?.abort()
    operation.current = null
  }, [key])

  const current = result?.key === key ? result : null
  const clipUrl = useBlobUrl(current?.clip ?? null)
  const coverUrl = useBlobUrl(current?.cover ?? null)
  const available = Boolean(clipUrl && coverUrl)
  const change = useCallback((enabled: boolean) => setEnabledKey(enabled ? key : undefined), [key])

  async function validate() {
    if (operation.current) return
    if (available) {
      change(true)
      return
    }

    const controller = new AbortController()
    const { signal } = controller
    operation.current = controller
    setBusyKey(key)
    try {
      const [clip, cover] = await Promise.all([
        previewClip(sessionId, { ...color, in_point: range.in_point, out_point: range.out_point }, signal),
        previewFrame(sessionId, { ...color, time: range.cover_time }, signal),
      ])
      if (!signal.aborted) {
        setResult({ key, clip, cover })
        setEnabledKey(key)
        notify('FFmpeg 校验预览已就绪')
      }
    } catch (error) {
      if (!signal.aborted) notify(error instanceof Error ? error.message : 'FFmpeg 精确校验失败', true)
    } finally {
      controller.abort()
      if (operation.current === controller) {
        operation.current = null
        setBusyKey(undefined)
      }
    }
  }

  return { validate, enabled: available && enabledKey === key, change, available, busy: busyKey === key, clipUrl, coverUrl }
}

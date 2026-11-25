import { useEffect, useRef, useState } from 'react'
import { deleteSession, getThumbnails, uploadVideo, waitForSession } from '../api'
import type { SessionInfo, SessionStatus, ThumbnailList } from '../api'

type SessionState =
  | { phase: 'empty' }
  | { phase: 'upload'; filename: string; progress: number }
  | { phase: 'prepare'; info: SessionInfo; progress: number; stage: SessionStatus['stage'] }
  | { phase: 'ready'; info: SessionInfo; thumbnails: ThumbnailList }
  | { phase: 'error'; message: string; retained?: SessionInfo }

export function useSession(notify: (message: string, isError?: boolean) => void) {
  const [state, setState] = useState<SessionState>({ phase: 'empty' })
  const [resetting, setResetting] = useState(false)
  const infoRef = useRef<SessionInfo | null>(null)
  const operation = useRef<AbortController | null>(null)
  const clearing = useRef(false)

  useEffect(() => () => operation.current?.abort(), [])

  async function start(file: File) {
    if (operation.current || clearing.current || infoRef.current) return
    if (!/\.(mov|mp4)$/i.test(file.name)) {
      notify('请选择 MOV 或 MP4 视频', true)
      return
    }

    const controller = new AbortController()
    const { signal } = controller
    operation.current = controller
    setState({ phase: 'upload', filename: file.name, progress: 0 })

    try {
      const uploaded = await uploadVideo(file, progress => {
        if (!signal.aborted) setState({ phase: 'upload', filename: file.name, progress })
      }, signal)
      if (signal.aborted) {
        void deleteSession(uploaded.session_id).catch(() => undefined)
        return
      }
      const info = { ...uploaded, filename: file.name }
      infoRef.current = info
      if (!(info.duration > 0 && info.width > 0 && info.height > 0)) {
        throw new Error('无法读取有效的视频时长或分辨率')
      }

      setState({ phase: 'prepare', info, progress: 0, stage: 'proxy' })
      if (info.status !== 'ready') {
        await waitForSession(info.session_id, update => {
          const stage = update.stage ?? (update.proxy_progress >= 70 ? 'thumbnails' : 'proxy')
          setState({ phase: 'prepare', info, progress: update.proxy_progress, stage })
        }, signal)
      }

      const thumbnails = await getThumbnails(info.session_id, signal)
      if (!signal.aborted) setState({ phase: 'ready', info, thumbnails })
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : '无法打开视频'
      setState({ phase: 'error', message, retained: infoRef.current ?? undefined })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }

  async function reset() {
    if (clearing.current) return
    clearing.current = true
    setResetting(true)
    operation.current?.abort()
    operation.current = null
    const info = infoRef.current
    try {
      if (info) await deleteSession(info.session_id)
      infoRef.current = null
      setState({ phase: 'empty' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法清理视频会话'
      notify(message, true)
      setState(current => current.phase === 'prepare' ? { phase: 'error', message, retained: info ?? undefined } : current)
    } finally {
      clearing.current = false
      setResetting(false)
    }
  }

  return { state, start, reset, resetting }
}

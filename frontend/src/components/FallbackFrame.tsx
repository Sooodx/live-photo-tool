import { useEffect, useState, useSyncExternalStore } from 'react'
import { previewFrame } from '../api'
import type { ColorPayload } from '../api'
import { useBlobUrl } from '../hooks/useBlobUrl'
import type { VideoClock } from '../hooks/useVideoScrubber'

export function FallbackFrame({ sessionId, clock, lockedTime, color }: {
  sessionId: string
  clock: VideoClock
  lockedTime?: number
  color: ColorPayload
}) {
  const playhead = useSyncExternalStore(clock.subscribe, clock.read)
  const time = lockedTime ?? playhead
  const [result, setResult] = useState<{ time: number; color: ColorPayload; frame: Blob }>()

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const timer = window.setTimeout(() => {
      void previewFrame(sessionId, { ...color, time }, signal).then(frame => {
        if (!signal.aborted) setResult({ time, color, frame })
      }).catch(error => {
        if (!signal.aborted) console.warn('FFmpeg frame preview failed', error)
      })
    }, 240)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, time, color])

  const url = useBlobUrl(result && result.time === time && result.color === color ? result.frame : null)
  return url ? <img className="fallback-frame" src={url} alt="" draggable={false} /> : null
}

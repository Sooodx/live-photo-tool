import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp } from '../model'
import type { Selection } from '../model'

interface SeekRequest {
  time: number
  onFrame?: () => void
}

interface PlaybackRange {
  start: number
  end: number
  onStart: () => void
  onEnd: () => void
  started: boolean
}

function createClock() {
  let time = 0
  const listeners = new Set<() => void>()
  return {
    read: () => time,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: number) {
      if (next === time) return
      time = next
      for (const listener of listeners) listener()
    },
  }
}

export type VideoClock = Omit<ReturnType<typeof createClock>, 'set'>

interface Options {
  duration: number
  loop: Selection | null
  onFrame: () => void
  onError: (message: string) => void
}

export function useVideoScrubber(options: Options) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [clock] = useState(createClock)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)

  const scheduled = useRef<SeekRequest | null>(null)
  const pending = useRef<SeekRequest | null>(null)
  const seeking = useRef<SeekRequest | null>(null)
  const seekRaf = useRef<number | undefined>(undefined)
  const range = useRef<PlaybackRange | null>(null)

  const applySeek = useCallback((request: SeekRequest) => {
    const video = videoRef.current
    if (!video) return
    if (video.seeking || video.readyState < video.HAVE_METADATA) {
      pending.current = request
      return
    }
    pending.current = null
    const max = Number.isFinite(video.duration) ? video.duration : optionsRef.current.duration
    const target = clamp(request.time, 0, max)
    if (Math.abs(video.currentTime - target) < 0.0001 && video.readyState >= video.HAVE_CURRENT_DATA) {
      seeking.current = null
      clock.set(video.currentTime)
      request.onFrame?.()
      return
    }
    seeking.current = request
    video.currentTime = target
  }, [clock])

  const clearQueuedSeeks = useCallback(() => {
    if (seekRaf.current !== undefined) cancelAnimationFrame(seekRaf.current)
    seekRaf.current = undefined
    scheduled.current = pending.current = seeking.current = null
  }, [])

  const seek = useCallback((time: number, onFrame?: () => void) => {
    const target = clamp(time, 0, optionsRef.current.duration)
    clock.set(target)
    scheduled.current = { time: target, onFrame }
    pending.current = null
    seeking.current = null
    if (seekRaf.current !== undefined) return
    seekRaf.current = requestAnimationFrame(() => {
      seekRaf.current = undefined
      const request = scheduled.current
      scheduled.current = null
      if (request) applySeek(request)
    })
  }, [applySeek, clock])

  const pause = useCallback(() => {
    range.current = null
    videoRef.current?.pause()
  }, [])

  const toggle = useCallback(() => {
    const video = videoRef.current
    if (!video || video.readyState < video.HAVE_METADATA) return
    if (!video.paused) {
      pause()
      return
    }
    const loop = optionsRef.current.loop
    if (loop && (clock.read() < loop.inPoint || clock.read() >= loop.outPoint)) {
      clearQueuedSeeks()
      clock.set(loop.inPoint)
      applySeek({ time: loop.inPoint })
    } else if (video.ended) {
      applySeek({ time: 0 })
    }
    void video.play().catch(error => {
      if (error.name !== 'AbortError') optionsRef.current.onError('无法播放代理视频')
    })
  }, [applySeek, clearQueuedSeeks, clock, pause])

  const playRange = useCallback((start: number, end: number, onStart: () => void, onEnd: () => void) => {
    const video = videoRef.current
    if (!video || video.readyState < video.HAVE_METADATA) {
      onEnd()
      return
    }
    clearQueuedSeeks()
    const playback = { start, end, onStart, onEnd, started: false }
    range.current = playback
    clock.set(start)
    applySeek({ time: start })
    // Call play within the pointer or click gesture so mobile audio can start.
    void video.play().catch(error => {
      if (range.current !== playback) return
      range.current = null
      onEnd()
      if (error.name !== 'AbortError') optionsRef.current.onError('无法播放动态照片')
    })
  }, [applySeek, clearQueuedSeeks, clock])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const { requestVideoFrameCallback, cancelVideoFrameCallback } = video
    let videoFrameId: number | undefined
    let rafId: number | undefined
    let lastFrameTime: number | undefined
    let lastPresented = -1

    const finishRange = () => {
      const playback = range.current
      range.current = null
      if (playback) {
        video.pause()
        playback.onEnd()
      }
    }

    const tick = (mediaTime: number, hasFrame: boolean) => {
      if (video.seeking || scheduled.current || pending.current) return
      const options = optionsRef.current
      const playback = range.current
      const time = video.currentTime
      if (!video.paused && playback && time >= playback.end) {
        finishRange()
        return
      }
      if (!video.paused && !playback && options.loop &&
          (time >= options.loop.outPoint || time < options.loop.inPoint - 0.001)) {
        seek(options.loop.inPoint)
        return
      }
      clock.set(clamp(time, 0, options.duration))
      if (hasFrame) {
        // A frame callback queued before a seek can still carry the old timestamp.
        if (playback && !playback.started && Math.abs(mediaTime - time) > 0.12) return
        options.onFrame()
        if (playback && !playback.started && !video.paused && time >= playback.start - 0.04) {
          playback.started = true
          playback.onStart()
        }
      }
    }

    const onVideoFrame: VideoFrameRequestCallback = (_, metadata) => {
      lastFrameTime = metadata.mediaTime
      tick(metadata.mediaTime, true)
      videoFrameId = requestVideoFrameCallback.call(video, onVideoFrame)
    }

    const onAnimationFrame = () => {
      rafId = undefined
      const time = video.currentTime
      const presented = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
      const newFrame = presented > 0 ? presented !== lastPresented : time !== lastFrameTime
      tick(time, newFrame)
      lastPresented = presented
      lastFrameTime = time
      if (!video.paused) rafId = requestAnimationFrame(onAnimationFrame)
    }

    const onPlay = () => {
      setPlaying(true)
      if (!requestVideoFrameCallback && rafId === undefined) rafId = requestAnimationFrame(onAnimationFrame)
    }
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      if (range.current) finishRange()
      else if (optionsRef.current.loop) {
        seek(optionsRef.current.loop.inPoint)
        void video.play().catch(() => optionsRef.current.onError('无法循环播放选区'))
      } else clock.set(optionsRef.current.duration)
    }
    const onMediaError = () => {
      setReady(false)
      setPlaying(false)
      finishRange()
      optionsRef.current.onError('无法加载代理视频，请重新导入')
    }
    const onTimeUpdate = () => {
      if (range.current && !video.seeking && video.currentTime >= range.current.end) finishRange()
    }
    const onMetadata = () => {
      if (pending.current && !scheduled.current) applySeek(pending.current)
    }
    const onAvailableFrame = () => {
      setReady(true)
      if (video.seeking || scheduled.current) return
      if (pending.current) {
        applySeek(pending.current)
        return
      }
      if (video.readyState < video.HAVE_CURRENT_DATA) return
      const completed = seeking.current
      seeking.current = null
      lastFrameTime = video.currentTime
      lastPresented = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
      tick(video.currentTime, true)
      completed?.onFrame?.()
    }
    const listeners = {
      play: onPlay,
      pause: onPause,
      ended: onEnded,
      timeupdate: onTimeUpdate,
      error: onMediaError,
      loadedmetadata: onMetadata,
      loadeddata: onAvailableFrame,
      seeked: onAvailableFrame,
    }
    for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener)
    if (requestVideoFrameCallback) videoFrameId = requestVideoFrameCallback.call(video, onVideoFrame)
    if (video.readyState >= video.HAVE_CURRENT_DATA) onAvailableFrame()

    return () => {
      for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener)
      if (videoFrameId !== undefined) cancelVideoFrameCallback.call(video, videoFrameId)
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      clearQueuedSeeks()
      pause()
    }
  }, [applySeek, clearQueuedSeeks, clock, pause, seek])

  return { videoRef, clock, seek, toggle, pause, playRange, playing, ready }
}

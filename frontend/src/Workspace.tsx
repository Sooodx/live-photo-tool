import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportPhoto, proxyUrl } from './api'
import type { ColorPayload, SessionInfo, ThumbnailList } from './api'
import { ExportBar } from './components/ExportBar'
import { FallbackFrame } from './components/FallbackFrame'
import { GradingPanel } from './components/GradingPanel'
import { LivePhotoControls, LivePhotoPreview } from './components/LivePhotoPreview'
import type { LivePhase } from './components/LivePhotoPreview'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { AudioControl, EditingControls, VideoViewport } from './components/VideoViewport'
import { buildToneCurve } from './engine/toneCurve'
import type { Grade } from './engine/webglLutRenderer'
import { useExactPreview } from './hooks/useExactPreview'
import { useHotkeys } from './hooks/useHotkeys'
import { useLuts } from './hooks/useLuts'
import { useVideoRenderer } from './hooks/useVideoRenderer'
import { useVideoScrubber } from './hooks/useVideoScrubber'
import { clamp, isValidSelection, neutralAdjustments } from './model'
import type { Adjustments, OutputFormat, Selection, WorkspaceMode } from './model'

interface WorkspaceProps {
  info: SessionInfo
  thumbnails: ThumbnailList
  resetting: boolean
  onReset: () => void
  notify: (message: string, isError?: boolean) => void
}

const INITIAL_SELECTION_SECONDS = 3

export function Workspace({ info, thumbnails, resetting, onReset, notify }: WorkspaceProps) {
  const { session_id: id, duration, fps, has_audio: hasAudio } = info
  const firstOut = Math.min(INITIAL_SELECTION_SECONDS, duration)
  const [selection, setSelection] = useState<Selection>({ inPoint: 0, outPoint: firstOut, coverTime: firstOut / 2 })
  const [mode, setMode] = useState<WorkspaceMode>('edit')
  const [adjustments, setAdjustments] = useState(neutralAdjustments)
  const [intensity, setIntensity] = useState(100)
  const [format, setFormat] = useState<OutputFormat>('apple')
  const [name, setName] = useState(() => info.filename.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120) || 'IMG_0001')
  const [ratio, setRatio] = useState(info.width / info.height)
  const [looping, setLooping] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(0.85)
  const [exporting, setExporting] = useState(false)
  const [phase, setPhase] = useState<LivePhase>('idle')
  const [playingExact, setPlayingExact] = useState(false)
  const [coverReady, setCoverReady] = useState(false)
  const [exactProgress, setExactProgress] = useState(0)

  const drawFrame = useRef<() => void>(() => undefined)
  const exactVideo = useRef<HTMLVideoElement>(null)
  const exportRequest = useRef<AbortController | null>(null)
  const coverCanvas = useRef<HTMLCanvasElement>(null)
  const livePhase = useRef<LivePhase>('idle')
  const editTime = useRef(0)
  const frameDuration = Math.min(duration, 1 / (fps > 0 ? fps : 30))

  const luts = useLuts(id, notify)
  const { exposure, contrast, highlights, shadows, whites, blacks } = adjustments
  const curve = useMemo(() => buildToneCurve({ highlights, shadows, whites, blacks }), [highlights, shadows, whites, blacks])
  const grade = useMemo<Grade>(() => ({
    lut: luts.active?.lut ?? null,
    intensity: intensity / 100,
    exposure,
    contrast,
    curve,
    bypass: mode === 'edit' && comparing,
  }), [luts.active, intensity, exposure, contrast, curve, mode, comparing])

  const color = useMemo<ColorPayload>(() => ({
    lut_id: luts.active?.id ?? '',
    lut_intensity: intensity / 100,
    adjustments,
  }), [luts.active, intensity, adjustments])

  const { inPoint, outPoint, coverTime } = selection
  const range = { in_point: inPoint, out_point: outPoint, cover_time: coverTime }
  const validSelection = isValidSelection(selection, duration)
  const exportDisabled = !validSelection || luts.loading || resetting
  const exact = useExactPreview(id, color, range, notify)
  const video = useVideoScrubber({
    duration,
    loop: looping && mode === 'edit' ? selection : null,
    onFrame: () => drawFrame.current(),
    onError: message => notify(message, true),
  })
  const { clock, ready, pause, seek, toggle, videoRef } = video
  const showingExact = phase === 'idle' ? exact.enabled : playingExact
  const playable = validSelection && !resetting && (showingExact || (ready && coverReady))
  const renderer = useVideoRenderer(videoRef, grade)
  drawFrame.current = () => renderer.draw(true)
  const { supported, capture } = renderer

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume
    if (exactVideo.current) exactVideo.current.volume = volume
  }, [showingExact, mode, videoRef, volume])

  useEffect(() => () => exportRequest.current?.abort(), [])

  useEffect(() => {
    if (mode !== 'live' || !ready || phase !== 'idle') return
    let active = true
    seek(coverTime, () => {
      if (active && livePhase.current === 'idle' && coverCanvas.current && capture(coverCanvas.current)) setCoverReady(true)
    })
    return () => { active = false }
  }, [mode, ready, phase, coverTime, grade, supported, seek, capture])

  const updateSelection = useCallback((next: Selection, time: number) => {
    setSelection(next)
    seek(time)
  }, [seek])

  function markIn() {
    const time = clamp(clock.read(), 0, duration - frameDuration)
    setSelection(previous => {
      const outPoint = Math.min(duration, Math.max(previous.outPoint, time + frameDuration))
      return { inPoint: time, outPoint, coverTime: clamp(previous.coverTime, time, outPoint) }
    })
  }

  function markOut() {
    const time = clamp(clock.read(), frameDuration, duration)
    setSelection(previous => {
      const inPoint = Math.max(0, Math.min(previous.inPoint, time - frameDuration))
      return { inPoint, outPoint: time, coverTime: clamp(previous.coverTime, inPoint, time) }
    })
  }

  function markCover() {
    const time = clock.read()
    setSelection(previous => ({ ...previous, coverTime: clamp(time, previous.inPoint, previous.outPoint) }))
  }

  const adjust = useCallback((key: keyof Adjustments, value: number) => {
    setAdjustments(previous => previous[key] === value ? previous : { ...previous, [key]: value })
  }, [])

  const resetGrade = useCallback(() => {
    setAdjustments(neutralAdjustments)
    setIntensity(100)
  }, [])

  function stopLive() {
    livePhase.current = 'idle'
    setPhase('idle')
    pause()
    exactVideo.current?.pause()
    setExactProgress(0)
    // A very short hold can start and stop in the same React render.
    seek(coverTime, () => {
      if (livePhase.current === 'idle' && coverCanvas.current && capture(coverCanvas.current)) setCoverReady(true)
    })
  }

  function beginAnimation() {
    if (livePhase.current !== 'starting') return
    livePhase.current = 'playing'
    setPhase('playing')
  }

  function playLive() {
    if (!playable || livePhase.current !== 'idle') return
    const player = showingExact ? exactVideo.current : null
    livePhase.current = 'starting'
    setPlayingExact(Boolean(player))
    setPhase('starting')
    if (player) {
      player.currentTime = 0
      player.volume = volume
      void player.play().catch(error => {
        if (livePhase.current !== 'starting' || error.name === 'AbortError') return
        stopLive()
        notify('无法播放 FFmpeg 校验片段', true)
      })
    } else {
      video.playRange(inPoint, outPoint, beginAnimation, stopLive)
    }
  }

  function changeMode(next: WorkspaceMode) {
    if (mode === next) return
    if (next === 'live') {
      editTime.current = clock.read()
      pause()
      setComparing(false)
      setCoverReady(false)
    } else {
      stopLive()
      seek(editTime.current)
    }
    setMode(next)
  }

  function changeExact(enabled: boolean) {
    if (livePhase.current !== 'idle') stopLive()
    exact.change(enabled)
  }

  useHotkeys(mode === 'edit' ? {
    toggle,
    step(direction, halfSecond) {
      pause()
      seek(clock.read() + direction * (halfSecond ? 0.5 : 1 / (fps > 0 ? fps : 30)))
    },
    markIn,
    markOut,
    markCover,
    compare: setComparing,
  } : null)

  async function download() {
    if (exportRequest.current || exportDisabled) return
    const controller = new AbortController()
    exportRequest.current = controller
    setExporting(true)
    const outputName = name.replace(/[^a-zA-Z0-9_-]/g, '') || 'IMG_0001'
    try {
      const blob = await exportPhoto(id, { ...range, ...color, format, output_name: outputName }, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = format === 'apple' ? `${outputName}.zip` : `${outputName.startsWith('MV') ? '' : 'MV'}${outputName}.jpg`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify('导出完成，下载已开始')
    } catch (error) {
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '导出失败', true)
    } finally {
      if (exportRequest.current === controller) exportRequest.current = null
      if (!controller.signal.aborted) setExporting(false)
    }
  }

  const audio = <AudioControl muted={muted} volume={volume} hasAudio={hasAudio}
    onMute={() => {
      if (!muted && volume === 0) {
        setVolume(0.85)
      } else {
        setMuted(!muted)
        if (muted && volume === 0) setVolume(0.85)
      }
    }}
    onVolume={next => { setVolume(next); setMuted(false) }} />
  const live = mode === 'live'
  const fallback = supported === false
  const fallbackFrame = fallback && ready && !comparing && (live ? !showingExact : !video.playing)
    ? <FallbackFrame sessionId={id} clock={clock} lockedTime={live ? coverTime : undefined} color={color} /> : null
  const exactMedia = live && showingExact && exact.clipUrl ? (
    <video ref={exactVideo} className={`exact-video ${phase === 'playing' ? 'is-animated' : ''}`}
      src={exact.clipUrl} playsInline preload="auto" muted={muted}
      onLoadedMetadata={event => { event.currentTarget.volume = volume }}
      onPlaying={beginAnimation} onEnded={stopLive}
      onError={() => {
        stopLive()
        exact.change(false)
        notify('无法加载 FFmpeg 校验片段', true)
      }}
      onTimeUpdate={event => {
        const player = event.currentTarget
        if (livePhase.current === 'playing' && player.duration > 0) setExactProgress(player.currentTime / player.duration)
      }} />
  ) : null

  return (
    <>
      <TopBar info={info} mode={mode} onMode={changeMode} onReset={onReset} resetting={resetting} />
      <main className={`workspace ${live ? 'workspace-live' : ''}`}>
        <div className="workspace-grid">
          <VideoViewport info={info} clock={clock} canvasRef={renderer.canvasRef}
            ratio={ratio} live={live} animated={phase === 'playing'} fallback={fallback} comparing={!live && comparing}
            ready={ready || (live && showingExact)}
            video={<video ref={videoRef} className="proxy-video" src={proxyUrl(id)}
              crossOrigin="anonymous" playsInline preload="auto" muted={muted}
              onLoadedMetadata={event => {
                const { videoWidth, videoHeight } = event.currentTarget
                if (videoHeight) setRatio(videoWidth / videoHeight)
              }} />}
            overlay={live ? (
              <LivePhotoPreview selection={selection} format={format} clock={clock} phase={phase}
                coverRef={coverCanvas} coverReady={coverReady} exactCover={showingExact ? exact.coverUrl : undefined}
                fallbackFrame={fallbackFrame} exactMedia={exactMedia} exactProgress={showingExact ? exactProgress : null}
                playable={playable} onPlay={playLive} onStop={stopLive} />
            ) : fallbackFrame}
            controls={live ? (
              <LivePhotoControls phase={phase} exact={showingExact} available={exact.available} busy={exact.busy}
                validationDisabled={exportDisabled || phase !== 'idle'}
                playable={playable} onPlay={playLive} onStop={stopLive}
                onValidate={() => { void exact.validate() }} onExact={changeExact} audio={audio} />
            ) : (
              <EditingControls playing={video.playing} ready={ready} looping={looping} comparing={comparing}
                onToggle={toggle} onLoop={() => setLooping(!looping)} onCompare={setComparing} onCover={markCover} audio={audio} />
            )} />
          <Timeline hidden={live} selection={selection} thumbnails={thumbnails} duration={duration} frameDuration={frameDuration}
            clock={clock} onChange={updateSelection} onScrub={seek} onDragStart={pause} />
          {!live && (
            <GradingPanel luts={luts.list} selectedId={luts.requestedId} intensity={intensity} adjustments={adjustments}
              curve={curve} lutLoading={luts.loading} lutUploading={luts.uploading}
              onSelect={id => { void luts.select(id) }} onUpload={file => { void luts.upload(file) }}
              onIntensity={setIntensity} onAdjust={adjust} onReset={resetGrade} />
          )}
        </div>
        <ExportBar selection={selection} format={format} name={name} exporting={exporting}
          disabled={exportDisabled} onFormat={setFormat} onName={setName} onExport={() => { void download() }} />
      </main>
    </>
  )
}

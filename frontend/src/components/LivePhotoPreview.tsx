import { useRef, useSyncExternalStore } from 'react'
import type { ReactNode, RefObject } from 'react'
import { CircleDot, Clapperboard, LoaderCircle, Play } from 'lucide-react'
import type { VideoClock } from '../hooks/useVideoScrubber'
import { clamp } from '../model'
import type { OutputFormat, Selection } from '../model'
import { ResetPlaybackButton } from './VideoViewport'

export type LivePhase = 'idle' | 'starting' | 'playing'

interface PreviewProps {
  selection: Selection
  format: OutputFormat
  clock: VideoClock
  phase: LivePhase
  coverRef: RefObject<HTMLCanvasElement | null>
  coverReady: boolean
  exactCover?: string
  fallbackFrame?: ReactNode
  exactMedia?: ReactNode
  exactProgress: number | null
  playable: boolean
  onPlay: () => void
  onStop: () => void
}

function LiveBadge({ phase, format, clock, selection, exactProgress }: Pick<PreviewProps,
  'format' | 'clock' | 'selection' | 'phase' | 'exactProgress'>) {
  const time = useSyncExternalStore(clock.subscribe, clock.read)
  const progress = phase === 'playing' ?
    clamp(exactProgress ?? (time - selection.inPoint) / (selection.outPoint - selection.inPoint), 0, 1) : 0
  return (
    <span className="live-badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.2" opacity=".4" />
        <circle cx="12" cy="12" r="6.6" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="12" r="10" pathLength="1" stroke="currentColor" strokeWidth="2"
          strokeDasharray={`${progress} 1`} transform="rotate(-90 12 12)" />
      </svg>
      {format === 'apple' ? 'LIVE' : 'MOTION'}
    </span>
  )
}

export function LivePhotoPreview(props: PreviewProps) {
  const pointer = useRef<number | null>(null)
  const { phase, coverRef, coverReady, exactCover, exactMedia, fallbackFrame, playable, onPlay, onStop } = props
  const moving = phase === 'playing'

  function release(pointerId: number) {
    if (pointer.current !== pointerId) return
    pointer.current = null
    onStop()
  }

  return (
    <>
      {exactMedia}
      <div className={`cover-layer ${moving ? 'is-receding' : ''}`} aria-hidden="true">
        <canvas ref={coverRef} className={coverReady ? '' : 'is-hidden'} />
        {fallbackFrame}
        {exactCover && <img src={exactCover} alt="" draggable={false} />}
      </div>
      <button
        className="live-interaction" type="button" aria-label={phase === 'idle' ? '按住播放动态照片' : '返回封面'}
        title="按住播放动态照片" disabled={!playable}
        onPointerDown={event => {
          if (event.button !== 0 || pointer.current !== null) return
          pointer.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
          if (phase === 'idle') onPlay()
        }}
        onPointerUp={event => release(event.pointerId)} onPointerCancel={event => release(event.pointerId)}
        onLostPointerCapture={event => release(event.pointerId)}
        onContextMenu={event => event.preventDefault()}
        onClick={event => {
          if (event.detail !== 0) return
          if (phase === 'idle') onPlay()
          else onStop()
        }}
      >
        <LiveBadge {...props} />
      </button>
    </>
  )
}

export function LivePhotoControls({ phase, exact, available, busy, validationDisabled, playable,
  onPlay, onStop, onValidate, onExact, audio }: {
  phase: LivePhase
  exact: boolean
  available: boolean
  busy: boolean
  validationDisabled: boolean
  playable: boolean
  onPlay: () => void
  onStop: () => void
  onValidate: () => void
  onExact: (exact: boolean) => void
  audio: ReactNode
}) {
  return (
    <>
      <div className="toolbar-group live-playback">
        {phase === 'idle' ?
          <button className="button primary" onClick={onPlay} disabled={!playable}><Play size={15} fill="currentColor" /> 播放动态效果</button> :
          <ResetPlaybackButton onClick={onStop} />}
        {audio}
      </div>
      <div className="toolbar-group live-validate">
        {available && <div className="segmented render-toggle" aria-label="预览来源">
          <button aria-pressed={!exact} onClick={() => onExact(false)}><CircleDot size={13} /> 实时 GPU 预览</button>
          <button aria-pressed={exact} onClick={() => onExact(true)}>FFmpeg 精确渲染</button>
        </div>}
        {!available && <button className="button secondary" disabled={validationDisabled || busy} onClick={onValidate}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Clapperboard size={15} />}
          {busy ? '正在渲染…' : 'FFmpeg 精确校验'}
        </button>}
      </div>
    </>
  )
}

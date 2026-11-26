import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { Aperture, Columns2, Film, Pause, Play, Repeat2, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import type { SessionInfo } from '../api'
import type { VideoClock } from '../hooks/useVideoScrubber'
import { timecode } from '../model'

interface ViewportProps {
  info: SessionInfo
  clock: VideoClock
  canvasRef: RefObject<HTMLCanvasElement | null>
  video: ReactNode
  overlay?: ReactNode
  controls: ReactNode
  ratio: number
  live: boolean
  animated: boolean
  fallback: boolean
  comparing: boolean
  ready: boolean
}

export function VideoViewport({
  info, clock, canvasRef, video, overlay, controls, ratio, live, animated, fallback, comparing, ready,
}: ViewportProps) {
  return (
    <section className={`video-panel panel ${live ? 'live-view' : ''}`} aria-label={live ? '动态照片预览' : '视频监看器'}>
      <header className="panel-heading monitor-heading">
        <h2>{live ? <Aperture size={16} /> : <Film size={16} />} {live ? '动态照片预览' : '视频监看器'}</h2>
        <div className="monitor-meta">
          <span className="dimensions">{info.width} × {info.height} {info.fps > 0 && <span>· {Number(info.fps.toFixed(2))} fps</span>}</span>
          <span className={`engine-tag ${fallback ? 'fallback' : ''}`}
            title={fallback ? '播放原片，暂停后由 FFmpeg 生成调色帧' : undefined}>
            <i /> {fallback ? '兼容预览' : '实时 GPU'}
          </span>
        </div>
      </header>
      <div className="stage" style={{ '--media-ratio': ratio } as CSSProperties}>
        <div className="media-plate">
          <div className={`media-stack ${animated ? 'is-animated' : ''}`}>
            {video}
            <canvas ref={canvasRef} className={`video-canvas ${fallback ? 'is-hidden' : ''}`} aria-hidden="true" />
          </div>
          {!ready && <div className="media-loading" role="status">正在载入视频…</div>}
          {overlay}
          {comparing && <span className="before-indicator">原片</span>}
        </div>
      </div>
      <div className="monitor-toolbar">
        {controls}
        {!live && <MediaTime clock={clock} duration={info.duration} />}
      </div>
    </section>
  )
}

function MediaTime({ clock, duration }: { clock: VideoClock; duration: number }) {
  const time = useSyncExternalStore(clock.subscribe, clock.read)
  return <span className="time-readout">{timecode(time)} <span>/ {timecode(duration)}</span></span>
}

export function AudioControl({ muted, volume, hasAudio, onMute, onVolume }: {
  muted: boolean
  volume: number
  hasAudio: boolean
  onMute: () => void
  onVolume: (value: number) => void
}) {
  const label = !hasAudio ? '视频无音轨' : muted || volume === 0 ? '开启声音' : '静音'
  return (
    <div className="audio-control">
      <button className="icon-button" aria-label={label} title={label} aria-pressed={muted} onClick={onMute} disabled={!hasAudio}>
        {muted || volume === 0 || !hasAudio ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="音量"
        disabled={!hasAudio} onChange={event => onVolume(event.currentTarget.valueAsNumber)} />
    </div>
  )
}

export function EditingControls({ playing, ready, looping, comparing, onToggle, onLoop, onCompare, onCover, audio }: {
  playing: boolean
  ready: boolean
  looping: boolean
  comparing: boolean
  onToggle: () => void
  onLoop: () => void
  onCompare: (compare: boolean) => void
  onCover: () => void
  audio: ReactNode
}) {
  return (
    <>
      <div className="toolbar-group">
        <button className="icon-button play-button" onClick={onToggle} disabled={!ready}
          title={playing ? '暂停 · Space' : '播放 · Space'} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
        </button>
        <button className="icon-button" title="循环选区" aria-label="循环选区" aria-pressed={looping} onClick={onLoop}>
          <Repeat2 size={18} />
        </button>
        {audio}
      </div>
      <div className="toolbar-group monitor-actions">
        <button className="small-button" title="按住对比原片 · B" aria-label="按住对比原片" aria-pressed={comparing}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            onCompare(true)
          }}
          onPointerUp={() => onCompare(false)} onPointerCancel={() => onCompare(false)}
          onLostPointerCapture={() => onCompare(false)} onBlur={() => onCompare(false)}
          onKeyDown={event => {
            if (event.key === ' ' || event.key === 'Enter') onCompare(true)
          }}
          onKeyUp={event => {
            if (event.key === ' ' || event.key === 'Enter') onCompare(false)
          }}>
          <Columns2 size={15} /> <span>按住对比原片</span>
        </button>
        <button className="small-button" title="设为封面 · C" aria-label="设为封面" onClick={onCover}>
          <Aperture size={15} /> <span>设为封面</span>
        </button>
      </div>
    </>
  )
}

export function ResetPlaybackButton({ onClick }: { onClick: () => void }) {
  return <button className="button secondary" onClick={onClick}><RotateCcw size={15} /> 返回封面</button>
}

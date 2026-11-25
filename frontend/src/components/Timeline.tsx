import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { AudioLines, Diamond, ZoomIn, ZoomOut } from 'lucide-react'
import type { Thumbnail, ThumbnailList } from '../api'
import type { VideoClock } from '../hooks/useVideoScrubber'
import { clamp, timecode } from '../model'
import type { Selection } from '../model'

type DragMode = 'in' | 'out' | 'window' | 'cover' | 'scrub'

interface TimelineProps {
  hidden: boolean
  selection: Selection
  thumbnails: ThumbnailList
  duration: number
  frameDuration: number
  clock: VideoClock
  onChange: (selection: Selection, seekTime: number) => void
  onScrub: (time: number) => void
  onDragStart: () => void
}

function dragSelection(mode: Exclude<DragMode, 'scrub'>, time: number, delta: number,
  selection: Selection, duration: number, minDuration: number) {
  const { inPoint, outPoint, coverTime } = selection
  switch (mode) {
    case 'in': {
      const next = clamp(time, 0, outPoint - minDuration)
      return { selection: { ...selection, inPoint: next, coverTime: Math.max(coverTime, next) }, seek: next }
    }
    case 'out': {
      const next = clamp(time, inPoint + minDuration, duration)
      return { selection: { ...selection, outPoint: next, coverTime: Math.min(coverTime, next) }, seek: next }
    }
    case 'cover': {
      const next = clamp(time, inPoint, outPoint)
      return { selection: { ...selection, coverTime: next }, seek: next }
    }
    case 'window': {
      const shift = clamp(delta, -inPoint, duration - outPoint)
      const end = Math.min(outPoint + shift, duration)
      const next = { inPoint: inPoint + shift, outPoint: end, coverTime: Math.min(coverTime + shift, end) }
      return { selection: next, seek: next.inPoint }
    }
  }
}

const percent = (time: number, duration: number) => `${(time / duration) * 100}%`

function nearest(items: Thumbnail[], time: number) {
  let low = 0
  let high = items.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (items[middle].time < time) low = middle + 1
    else high = middle
  }
  if (low > 0 && time - items[low - 1].time < items[low].time - time) return items[low - 1]
  return items[low]
}

const Filmstrip = memo(function Filmstrip({ items, duration, width, scroll, viewport }: {
  items: Thumbnail[]
  duration: number
  width: number
  scroll: number
  viewport: number
}) {
  const count = Math.max(1, Math.ceil(width / 102))
  const tileWidth = width / count
  const first = Math.max(0, Math.floor(scroll / tileWidth) - 2)
  const last = Math.min(count, Math.ceil((scroll + viewport) / tileWidth) + 2)
  return (
    <div className="filmstrip" aria-hidden="true">
      {items.length > 0 && Array.from({ length: Math.max(0, last - first) }, (_, index) => {
        const tile = first + index
        const thumb = nearest(items, (tile + 0.5) / count * duration)
        return (
          <img key={tile} src={thumb.url} alt="" decoding="async" draggable={false}
            style={{ left: `${tile / count * 100}%`, width: `${100 / count}%` }} />
        )
      })}
    </div>
  )
})

function Ruler({ duration, width, scroll, viewport }: { duration: number; width: number; scroll: number; viewport: number }) {
  const ideal = duration / width * 110
  const magnitude = 10 ** Math.floor(Math.log10(ideal))
  const step = Math.max(0.05, (ideal / magnitude > 5 ? 10 : ideal / magnitude > 2 ? 5 : ideal / magnitude > 1 ? 2 : 1) * magnitude)
  const minor = step / 5
  const first = Math.max(0, Math.floor(scroll / width * duration / minor) - 1)
  const last = Math.min(Math.floor(duration / minor), Math.ceil((scroll + viewport) / width * duration / minor) + 1)
  return (
    <div className="time-ruler" aria-hidden="true">
      {Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => {
        const tick = first + offset
        const major = tick % 5 === 0
        return (
          <div key={tick} className={major ? 'ruler-tick major' : 'ruler-tick'} style={{ left: percent(tick * minor, duration) }}>
            {major && <span>{timecode(tick * minor)}</span>}
          </div>
        )
      })}
    </div>
  )
}

function Playhead({ clock, duration }: { clock: VideoClock; duration: number }) {
  const time = useSyncExternalStore(clock.subscribe, clock.read)
  return <div className="playhead" style={{ left: percent(time, duration) }} aria-hidden="true" />
}

interface Drag {
  pointer: number
  mode: DragMode
  selection: Selection
  origin: number
  clientX: number
  startX: number
  offset: number
  moved: boolean
}

export const Timeline = memo(function Timeline({
  hidden, selection, thumbnails, duration, frameDuration, clock, onChange, onScrub, onDragStart,
}: TimelineProps) {
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const autoScroll = useRef<number | undefined>(undefined)
  const [zoom, setZoom] = useState(1)
  const [view, setView] = useState({ width: 1, viewport: 1, scroll: 0 })
  const { inPoint, outPoint, coverTime } = selection

  useEffect(() => {
    const element = scroller.current!
    const track = root.current!
    let frame: number | undefined

    const measure = () => {
      frame = undefined
      const width = track.clientWidth || 1
      const viewport = element.clientWidth || 1
      const scroll = element.scrollLeft
      setView(old => old.width === width && old.viewport === viewport && old.scroll === scroll ? old : { width, viewport, scroll })
    }
    const queue = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(queue)
    observer.observe(element)
    observer.observe(track)
    element.addEventListener('scroll', queue, { passive: true })
    const unsubscribe = clock.subscribe(() => {
      if (drag.current || element.clientWidth >= track.clientWidth) return
      const x = clock.read() / duration * track.clientWidth
      const { scrollLeft, clientWidth } = element
      if (x < scrollLeft || x > scrollLeft + clientWidth) element.scrollLeft = x - clientWidth * 0.35
    })
    queue()

    return () => {
      unsubscribe()
      observer.disconnect()
      element.removeEventListener('scroll', queue)
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (autoScroll.current !== undefined) cancelAnimationFrame(autoScroll.current)
    }
  }, [clock, duration])

  function timeAt(clientX: number) {
    const element = scroller.current!
    const paper = root.current!
    return (clientX - element.getBoundingClientRect().left + element.scrollLeft) / paper.clientWidth * duration
  }

  function applyDrag(state: Drag) {
    const current = timeAt(state.clientX)
    if (state.mode === 'scrub') {
      onScrub(clamp(current, 0, duration))
      return
    }
    if (!state.moved) return
    const next = dragSelection(state.mode, current - state.offset, current - state.origin, state.selection, duration, frameDuration)
    onChange(next.selection, next.seek)
  }

  function scrollWhileDragging() {
    const state = drag.current
    const element = scroller.current
    if (!element || !state) return
    const bounds = element.getBoundingClientRect()
    const edge = 32
    const left = Math.max(0, bounds.left + edge - state.clientX)
    const right = Math.max(0, state.clientX - (bounds.right - edge))
    const before = element.scrollLeft
    if (state.moved && (left || right)) element.scrollLeft += clamp((right - left) * 0.35, -25, 25)
    if (element.scrollLeft !== before) applyDrag(state)
    autoScroll.current = requestAnimationFrame(scrollWhileDragging)
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return
    const target = event.target as HTMLElement
    const mode = target.closest<HTMLElement>('[data-drag]')?.dataset.drag as DragMode | undefined
    const origin = timeAt(event.clientX)
    const marker = mode === 'in' ? inPoint : mode === 'out' ? outPoint : mode === 'cover' ? coverTime : origin
    const state: Drag = {
      pointer: event.pointerId, mode: mode ?? 'scrub', selection,
      clientX: event.clientX, startX: event.clientX, origin, offset: origin - marker, moved: false,
    }
    drag.current = state
    event.currentTarget.setPointerCapture(event.pointerId)
    onDragStart()
    applyDrag(state)
    autoScroll.current = requestAnimationFrame(scrollWhileDragging)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    state.clientX = event.clientX
    state.moved ||= Math.abs(state.clientX - state.startX) > 0.5
    applyDrag(state)
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer !== event.pointerId) return
    if (event.type === 'pointerup') move(event)
    drag.current = null
    if (autoScroll.current !== undefined) cancelAnimationFrame(autoScroll.current)
    autoScroll.current = undefined
  }

  function keyMarker(event: KeyboardEvent, mode: Exclude<DragMode, 'scrub' | 'window'>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const change = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.5 : frameDuration)
    const time = mode === 'in' ? inPoint : mode === 'out' ? outPoint : coverTime
    const next = dragSelection(mode, time + change, change, selection, duration, frameDuration)
    onDragStart()
    onChange(next.selection, next.seek)
  }

  function changeZoom(next: number) {
    const element = scroller.current!
    const width = root.current!.clientWidth
    const at = clock.read() / duration
    const anchor = clamp(at * width - element.scrollLeft, 0, element.clientWidth)
    setZoom(next)
    requestAnimationFrame(() => {
      element.scrollLeft = at * (root.current?.clientWidth ?? width) - anchor
    })
  }

  return (
    <section className="timeline panel" aria-label="视频时间轴" hidden={hidden}>
      <header className="panel-heading timeline-heading">
        <h2><AudioLines size={16} /> 时间轴</h2>
        <div className="timeline-tools">
          <label className="zoom-control">
            <ZoomOut size={15} aria-hidden="true" />
            <input aria-label="时间轴缩放" type="range" min={1} max={8} step={0.25} value={zoom}
              onChange={event => changeZoom(event.currentTarget.valueAsNumber)} />
            <ZoomIn size={15} aria-hidden="true" />
            <output>{zoom.toFixed(zoom % 1 === 0 ? 0 : 2).replace(/0$/, '')}×</output>
          </label>
        </div>
      </header>
      <div className="timeline-scroll" ref={scroller}>
        <div
          className="timeline-track" ref={root} style={{ width: `${zoom * 100}%` }}
          onPointerDown={start} onPointerMove={move} onPointerUp={end}
          onPointerCancel={end} onLostPointerCapture={end}
        >
          <Ruler duration={duration} {...view} />
          <Filmstrip items={thumbnails.items} duration={duration} {...view} />
          <div className="clip-selection" style={{ left: percent(inPoint, duration), width: percent(outPoint - inPoint, duration) }}>
            <div className="selection-outline" />
            <div className="selection-body" data-drag="window" title="拖动移动选区">
              <span className="selection-duration">
                {(outPoint - inPoint).toFixed(2)} s
              </span>
            </div>
            <button className="trim-handle trim-in" data-drag="in" aria-label="入点"
              title="拖动入点 · I" onKeyDown={event => keyMarker(event, 'in')} />
            <button className="trim-handle trim-out" data-drag="out" aria-label="出点"
              title="拖动出点 · O" onKeyDown={event => keyMarker(event, 'out')} />
          </div>
          <button className="cover-marker" data-drag="cover" aria-label="封面帧"
            title="拖动封面帧 · C" style={{ '--at': percent(coverTime, duration) } as CSSProperties}
            onKeyDown={event => keyMarker(event, 'cover')}><Diamond size={13} fill="currentColor" /></button>
          <Playhead clock={clock} duration={duration} />
        </div>
      </div>
      <div className="timeline-legend">
        <span><span className="legend-line selection-key" />选区</span>
        <span><Diamond size={10} fill="currentColor" className="cover-key" />封面帧</span>
        <span className="shortcut-hint"><kbd>I</kbd> 入点 <kbd>O</kbd> 出点 <kbd>C</kbd> 封面</span>
      </div>
    </section>
  )
})

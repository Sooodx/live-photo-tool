import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { clamp } from '../model'

const DIVIDER_SIZE = 16
const MIN_MAIN_WIDTH = 440
const MIN_GRADING_WIDTH = 245
const MIN_PREVIEW_HEIGHT = 270
const MIN_TIMELINE_HEIGHT = 160
const DEFAULT_TIMELINE_HEIGHT = 168

interface WorkspaceLayoutProps {
  preview: ReactNode
  timeline: ReactNode
  grading: ReactNode
  live: boolean
}

interface DividerProps {
  orientation: 'horizontal' | 'vertical'
  label: string
  panelId: string
  size: number
  min: number
  max: number
  onResize: (size: number) => void
}

interface DividerDrag {
  pointerId: number
  initialPosition: number
  initialSize: number
  lastSize: number
}

function WorkspaceDivider({ orientation, label, panelId, size, min, max, onResize }: DividerProps) {
  const drag = useRef<DividerDrag | null>(null)
  const [dragging, setDragging] = useState(false)
  const vertical = orientation === 'vertical'
  const coordinate = vertical ? 'clientX' : 'clientY'

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, initialPosition: event[coordinate], initialSize: size, lastSize: size }
    setDragging(true)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (active?.pointerId !== event.pointerId) return
    const next = clamp(Math.round(active.initialSize + active.initialPosition - event[coordinate]), min, max)
    if (next === active.lastSize) return
    active.lastSize = next
    onResize(next)
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    if (event.type === 'pointerup') move(event)
    drag.current = null
    setDragging(false)
  }

  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>) {
    // Keep workspace playback and trimming shortcuts from handling divider keystrokes.
    event.stopPropagation()
    if (event.altKey || event.ctrlKey || event.metaKey) return

    const step = event.shiftKey ? 48 : 16
    let next: number
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) next = size + step
    else if (event.key === (vertical ? 'ArrowRight' : 'ArrowDown')) next = size - step
    else return

    event.preventDefault()
    const resized = clamp(next, min, max)
    if (resized !== size) onResize(resized)
  }

  return (
    <div className="workspace-divider" role="separator" tabIndex={0} aria-orientation={orientation}
      aria-label={label} aria-controls={panelId} aria-valuemin={min} aria-valuemax={max}
      aria-valuenow={size} aria-valuetext={`${size} 像素`} title={label} data-dragging={dragging || undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={resizeWithKey} />
  )
}

export function WorkspaceLayout({ preview, timeline, grading, live }: WorkspaceLayoutProps) {
  const layout = useRef<HTMLDivElement>(null)
  const timelineId = useId()
  const gradingId = useId()
  const [{ width, height }, setBounds] = useState({ width: 0, height: 0 })
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT)
  const [gradingWidth, setGradingWidth] = useState<number>()

  useLayoutEffect(() => {
    const element = layout.current!
    function measure() {
      const { clientWidth: width, clientHeight: height } = element
      setBounds(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])

  const preferredGradingWidth = gradingWidth ?? clamp(Math.round(width * .22), MIN_GRADING_WIDTH, 300)
  const maxTimelineHeight = Math.max(MIN_TIMELINE_HEIGHT, height - DIVIDER_SIZE - MIN_PREVIEW_HEIGHT)
  const maxGradingWidth = Math.max(MIN_GRADING_WIDTH, width - DIVIDER_SIZE - MIN_MAIN_WIDTH)
  const style = {
    '--workspace-divider-size': `${DIVIDER_SIZE}px`,
    '--workspace-main-min': `${MIN_MAIN_WIDTH}px`,
    '--workspace-grading-min': `${MIN_GRADING_WIDTH}px`,
    '--workspace-preview-min': `${MIN_PREVIEW_HEIGHT}px`,
    '--workspace-timeline-min': `${MIN_TIMELINE_HEIGHT}px`,
    '--workspace-grading-width': `${preferredGradingWidth}px`,
    '--workspace-timeline-height': `${timelineHeight}px`,
  } as CSSProperties

  return (
    <div ref={layout} className="workspace-grid" data-live={live || undefined} style={style}>
      <div className="workspace-main">
        <div className="workspace-preview">{preview}</div>
        {!live && <WorkspaceDivider orientation="horizontal" label="调整时间轴高度" panelId={timelineId}
          size={clamp(timelineHeight, MIN_TIMELINE_HEIGHT, maxTimelineHeight)}
          min={MIN_TIMELINE_HEIGHT} max={maxTimelineHeight} onResize={setTimelineHeight} />}
        <div id={timelineId} className="workspace-timeline" hidden={live}>{timeline}</div>
      </div>
      {!live && (
        <>
          <WorkspaceDivider orientation="vertical" label="调整调色面板宽度" panelId={gradingId}
            size={clamp(preferredGradingWidth, MIN_GRADING_WIDTH, maxGradingWidth)}
            min={MIN_GRADING_WIDTH} max={maxGradingWidth} onResize={setGradingWidth} />
          <div id={gradingId} className="workspace-grading">{grading}</div>
        </>
      )}
    </div>
  )
}

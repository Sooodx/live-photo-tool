import { useCallback, useEffect, useRef, useState } from 'react'
import { WebGLLutRenderer } from '../engine/webglLutRenderer'
import type { Grade } from '../engine/webglLutRenderer'
import type { RefObject } from 'react'

export function useVideoRenderer(videoRef: RefObject<HTMLVideoElement | null>, grade: Grade) {
  const [supported, setSupported] = useState<boolean | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<WebGLLutRenderer | null>(null)
  const gradeRef = useRef(grade)
  gradeRef.current = grade
  const drawRaf = useRef<number | undefined>(undefined)

  const draw = useCallback((uploadFrame: boolean) => {
    const video = videoRef.current
    if (video) renderer.current?.render(video, gradeRef.current, uploadFrame)
  }, [videoRef])

  const capture = useCallback((snapshot: HTMLCanvasElement) => {
    const video = videoRef.current
    if (!video || video.seeking || video.readyState < video.HAVE_CURRENT_DATA) return false
    if (renderer.current?.render(video, gradeRef.current, true, snapshot)) return true
    snapshot.width = video.videoWidth
    snapshot.height = video.videoHeight
    snapshot.getContext('2d')?.drawImage(video, 0, 0)
    return true
  }, [videoRef])

  const requestDraw = useCallback(() => {
    if (drawRaf.current !== undefined) return
    drawRaf.current = requestAnimationFrame(() => {
      drawRaf.current = undefined
      draw(false)
    })
  }, [draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    renderer.current = new WebGLLutRenderer(canvas, available => {
      setSupported(available)
      if (available) {
        requestAnimationFrame(() => draw(true))
      }
    })

    const resize = new ResizeObserver(requestDraw)
    resize.observe(canvas)
    window.addEventListener('resize', requestDraw)
    return () => {
      resize.disconnect()
      window.removeEventListener('resize', requestDraw)
      if (drawRaf.current !== undefined) cancelAnimationFrame(drawRaf.current)
      drawRaf.current = undefined
      renderer.current?.destroy()
      renderer.current = null
    }
  }, [draw, requestDraw])

  useEffect(requestDraw, [grade, requestDraw])

  return { canvasRef, capture, draw, supported }
}

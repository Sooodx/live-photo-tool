import { useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, FileVideo, Film, LoaderCircle, UploadCloud } from 'lucide-react'
import { clamp } from '../model'

type Progress = {
  value: number
  label: string
  filename: string
}

export function UploadDropzone({ progress, error, disabled, onFile }: {
  progress?: Progress
  error?: string
  disabled: boolean
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const percent = clamp(Math.round(progress?.value ?? 0), 0, 100)
  return (
    <main className="import-page">
      <section className="import-card">
        <header className="import-heading">
          <h1>导入视频</h1>
          <p>选择一个视频，剪辑并调色后导出动态照片。</p>
        </header>
        <div
          className={`dropzone ${dragging ? 'drag-over' : ''}`}
          onDragEnter={event => {
            event.preventDefault()
            if (disabled) return
            depth.current++
            setDragging(true)
          }}
          onDragOver={event => {
            event.preventDefault()
            event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
          }}
          onDragLeave={event => {
            event.preventDefault()
            depth.current = Math.max(0, depth.current - 1)
            if (!depth.current) setDragging(false)
          }}
          onDrop={event => {
            event.preventDefault()
            depth.current = 0
            setDragging(false)
            const file = event.dataTransfer.files[0]
            if (file && !disabled) onFile(file)
          }}
        >
          <input ref={input} type="file" accept=".mov,.mp4,video/quicktime,video/mp4" hidden aria-label="导入视频文件"
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file && !disabled) onFile(file)
            }} />
          <div className="import-symbol" aria-hidden="true">
            {progress ? <FileVideo size={37} strokeWidth={1.45} /> : <UploadCloud size={40} strokeWidth={1.35} />}
          </div>
          {progress ? (
            <div className="import-progress" role="status" aria-live="polite">
              <div className="progress-title"><LoaderCircle size={16} className="spin" /> {progress.label}</div>
              <span className="import-filename">{progress.filename}</span>
              <div className="flex items-center gap-3">
                <progress max={100} value={percent} aria-label={progress.label} />
                <output>{percent}%</output>
              </div>
            </div>
          ) : (
            <>
              <h2>拖放视频到这里</h2>
              <p className="file-types"><Film size={14} /> MOV / MP4</p>
              <button className="button primary" disabled={disabled} onClick={() => input.current?.click()}>
                选择视频 <ArrowUpRight size={16} />
              </button>
            </>
          )}
        </div>
        {error && <p className="import-error" role="alert"><AlertCircle size={17} /> {error}</p>}
      </section>
    </main>
  )
}

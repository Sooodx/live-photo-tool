import { Apple, ArrowRight, Download, LoaderCircle, Smartphone } from 'lucide-react'
import type { OutputFormat, Selection } from '../model'
import { timecode } from '../model'

export function ExportBar({ selection, format, name, exporting, disabled, onFormat, onName, onExport }: {
  selection: Selection
  format: OutputFormat
  name: string
  exporting: boolean
  disabled: boolean
  onFormat: (format: OutputFormat) => void
  onName: (name: string) => void
  onExport: () => void
}) {
  return (
    <footer className="export-bar panel">
      <div className="selection-summary">
        <div className="summary-range">
          <span>{timecode(selection.inPoint)}</span><ArrowRight size={13} /><span>{timecode(selection.outPoint)}</span>
          <span className="duration-label">{(selection.outPoint - selection.inPoint).toFixed(2)} s</span>
        </div>
        <div className="summary-cover">封面 <span>{timecode(selection.coverTime)}</span></div>
      </div>
      <div className="export-format">
        <div className="segmented format-toggle" aria-label="导出格式">
          <button aria-pressed={format === 'apple'} onClick={() => onFormat('apple')}><Apple size={14} /> Apple Live Photo</button>
          <button aria-pressed={format === 'samsung'} onClick={() => onFormat('samsung')}><Smartphone size={14} /> 三星 / 谷歌 Motion Photo</button>
        </div>
        <p>{format === 'apple' ? 'HEIC + MOV · ZIP 压缩包' : 'MV*.jpg · 请以原文件传输，避免应用压缩'}</p>
      </div>
      <form className="export-form" onSubmit={event => {
        event.preventDefault()
        onExport()
      }}>
        <label className="filename-field">
          <span>文件名</span>
          <input type="text" value={name} onChange={event => onName(event.currentTarget.value)} maxLength={120} placeholder="IMG_0001" />
        </label>
        <button className="button primary" type="submit" disabled={disabled || exporting}>
          {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
          {exporting ? '导出中…' : '导出'}
        </button>
      </form>
    </footer>
  )
}

import { useId, useRef } from 'react'
import { Apple, Download, LoaderCircle, Smartphone, X } from 'lucide-react'
import type { OutputFormat } from '../model'

const options = [
  { value: 'apple', icon: Apple, label: 'Apple Live Photo', detail: 'HEIC + MOV · ZIP 压缩包' },
  { value: 'samsung', icon: Smartphone, label: '安卓 / 三星 Motion Photo', detail: '内嵌视频的 JPG · 请以原文件传输' },
] as const

export function ExportDialog({ format, name, exporting, disabled, onFormat, onName, onExport }: {
  format: OutputFormat
  name: string
  exporting: boolean
  disabled: boolean
  onFormat: (format: OutputFormat) => void
  onName: (name: string) => void
  onExport: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  return (
    <>
      <button className="button primary topbar-export" type="button" aria-haspopup="dialog"
        disabled={disabled || exporting} onClick={() => dialog.current?.showModal()}>
        {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
        {exporting ? '导出中…' : '导出'}
      </button>
      <dialog className="export-dialog" ref={dialog} aria-labelledby={titleId}
        onKeyDown={event => event.stopPropagation()}>
        <form className="export-form" onSubmit={event => {
          event.preventDefault()
          if (disabled || exporting) return
          dialog.current?.close()
          onExport()
        }}>
          <header className="export-dialog-heading">
            <h2 id={titleId}>导出动态照片</h2>
            <button className="icon-button" type="button" aria-label="关闭导出"
              onClick={() => dialog.current?.close()}><X size={17} /></button>
          </header>
          <fieldset className="export-options">
            <legend>导出格式</legend>
            {options.map(({ value, icon: Icon, label, detail }) => (
              <label className="export-option" key={value}>
                <Icon size={19} aria-hidden="true" />
                <span className="export-option-text">
                  <span>{label}</span>
                  <span className="export-option-detail">{detail}</span>
                </span>
                <input type="radio" name="format" value={value} checked={format === value}
                  onChange={() => onFormat(value)} />
              </label>
            ))}
          </fieldset>
          <label className="filename-field">
            <span>文件名</span>
            <input type="text" value={name} onChange={event => onName(event.currentTarget.value)}
              maxLength={120} placeholder="IMG_0001" />
          </label>
          <button className="button primary export-confirm" type="submit" disabled={disabled || exporting}>
            <Download size={16} /> 开始导出
          </button>
        </form>
      </dialog>
    </>
  )
}

import { Film, LoaderCircle, ScanLine, Upload } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SessionInfo } from '../api'
import type { WorkspaceMode } from '../model'

export function TopBar({ info, mode, onMode, onReset, resetting, actions }: {
  info?: SessionInfo
  mode?: WorkspaceMode
  onMode?: (mode: WorkspaceMode) => void
  onReset?: () => void
  resetting: boolean
  actions?: ReactNode
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-icon"><ScanLine size={21} strokeWidth={1.7} /></span>
        <span>动态照片工作室 <small>LIVE PHOTO TOOL</small></span>
      </div>
      {mode && (
        <nav className="segmented workspace-tabs" aria-label="工作区">
          <button aria-pressed={mode === 'edit'} onClick={() => onMode?.('edit')}><Film size={15} /> 剪辑调色</button>
          <button aria-pressed={mode === 'live'} onClick={() => onMode?.('live')}><ScanLine size={15} /> 动态照片预览</button>
        </nav>
      )}
      <div className="topbar-right">
        {info && <span className="source-filename" title={info.filename}><Film size={14} /> {info.filename}</span>}
        {onReset && <button className="button secondary topbar-reset" onClick={onReset}
          disabled={resetting} aria-label="更换视频" title="更换视频">
          {resetting ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
          <span>更换视频</span>
        </button>}
        {actions}
      </div>
    </header>
  )
}

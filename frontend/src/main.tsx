import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import { TopBar } from './components/TopBar'
import { UploadDropzone } from './components/UploadDropzone'
import { useSession } from './hooks/useSession'
import { Workspace } from './Workspace'
import './style.css'

interface Notice {
  message: string
  error: boolean
}

function App() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const notify = useCallback((message: string, error = false) => setNotice({ message, error }), [])
  const { state, start, reset, resetting } = useSession(notify)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 6500 : 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  let progress
  if (state.phase === 'upload') {
    progress = { value: state.progress, filename: state.filename, label: state.progress === 100 ? '正在读取视频信息…' : '正在上传视频…' }
  } else if (state.phase === 'prepare') {
    progress = {
      value: state.progress,
      filename: state.info.filename,
      label: state.stage === 'ready' ? '正在载入时间轴…' :
        state.stage === 'thumbnails' ? '提取时间轴缩略图…' : '生成流畅代理视频…',
    }
  }
  const retained = state.phase === 'error' ? state.retained : state.phase === 'prepare' ? state.info : undefined

  return (
    <>
      {state.phase === 'ready' ? (
        <Workspace key={state.info.session_id} info={state.info} thumbnails={state.thumbnails}
          resetting={resetting} onReset={() => { void reset() }} notify={notify} />
      ) : (
        <>
          <TopBar info={retained} onReset={retained ? () => { void reset() } : undefined} resetting={resetting} />
          <UploadDropzone progress={progress} error={state.phase === 'error' ? state.message : undefined}
            disabled={Boolean(progress || retained || resetting)} onFile={file => { void start(file) }} />
        </>
      )}
      {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
        {notice.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
        <span>{notice.message}</span>
        <button className="icon-button" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={16} /></button>
      </div>}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

import { memo, useId, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Activity, ChevronDown, Layers, LoaderCircle, RotateCcw, SlidersHorizontal, Upload } from 'lucide-react'
import type { LutInfo } from '../api'
import { curveXs, toneCurvePoints } from '../engine/toneCurve'
import type { Adjustments } from '../model'

interface GradingProps {
  luts: LutInfo[]
  selectedId: string
  intensity: number
  adjustments: Adjustments
  curve: Uint8Array
  lutLoading: boolean
  lutUploading: boolean
  onSelect: (id: string) => void
  onUpload: (file: File) => void
  onIntensity: (value: number) => void
  onAdjust: (key: keyof Adjustments, value: number) => void
  onReset: () => void
}

const zones = [
  { name: '高光', key: 'highlights' },
  { name: '阴影', key: 'shadows' },
  { name: '白色色阶', key: 'whites' },
  { name: '黑色色阶', key: 'blacks' },
] as const

const base = [
  { name: '曝光', key: 'exposure' },
  { name: '对比度', key: 'contrast' },
] as const

const AdjustmentSlider = memo(function AdjustmentSlider({ name, value, onChange, adjustment }: {
  name: string; value: number; onChange: GradingProps['onAdjust']; adjustment: keyof Adjustments
}) {
  const id = useId()
  const percent = (value + 100) / 2
  return (
    <div className="adjustment-row" onDoubleClick={() => onChange(adjustment, 0)}>
      <div className="slider-label">
        <label htmlFor={id}>{name}</label>
        <output htmlFor={id}>{value > 0 ? '+' : ''}{value}</output>
      </div>
      <input id={id} className="grade-slider centered" type="range" min={-100} max={100} value={value}
        title={`${name} · 双击归零`}
        style={{ '--from': `${Math.min(50, percent)}%`, '--to': `${Math.max(50, percent)}%` } as CSSProperties}
        onChange={event => onChange(adjustment, event.currentTarget.valueAsNumber)} />
    </div>
  )
})

const CurvePlot = memo(function CurvePlot({ curve, adjustments }: { curve: Uint8Array; adjustments: Adjustments }) {
  const ys = toneCurvePoints(adjustments)
  const path = Array.from({ length: 64 }, (_, index) => {
    const sample = Math.round(index / 63 * 255)
    return `${index === 0 ? 'M' : 'L'}${10 + 220 * sample / 255} ${88 - 78 * curve[sample] / 255}`
  }).join(' ')
  return (
    <svg className="curve-plot" viewBox="0 0 240 98" role="img" aria-label="五点色调曲线">
      <path d="M10 10H230 M10 29.5H230 M10 49H230 M10 68.5H230 M10 88H230 M10 10V88 M65 10V88 M120 10V88 M175 10V88 M230 10V88"
        stroke="var(--line)" fill="none" />
      <path d="M10 88L230 10" stroke="var(--dim)" strokeDasharray="3 4" fill="none" />
      <path d={path} stroke="var(--accent)" fill="none" strokeWidth="1.7" />
      {ys.map((value, index) => <circle key={index} cx={10 + 220 * curveXs[index]} cy={88 - 78 * value} r="3"
        fill="var(--surface)" stroke="var(--accent)" strokeWidth="1.5" />)}
    </svg>
  )
})

export const GradingPanel = memo(function GradingPanel(props: GradingProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const { adjustments, curve, onAdjust } = props
  const selected = props.luts.find(lut => lut.id === props.selectedId)
  const builtins = props.luts.filter(lut => lut.source === 'builtin')
  const userLuts = props.luts.filter(lut => lut.source !== 'builtin')
  const builtin = selected?.builtin
  return (
    <aside className="grading-panel panel" aria-label="调色面板">
      <header className="panel-heading">
        <h2><SlidersHorizontal size={16} /> 调色</h2>
        <button className="text-button" onClick={props.onReset} title="重置 LUT 强度和全部调整">
          <RotateCcw size={13} /> 全部重置
        </button>
      </header>

      <section className="grading-section">
        <div className="grading-section-title">
          <h3><Layers size={14} /> 3D LUT</h3>
          <button className="small-button" onClick={() => fileInput.current?.click()} disabled={props.lutUploading}>
            {props.lutUploading ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />} 导入 .cube
          </button>
          <input ref={fileInput} hidden type="file" accept=".cube" aria-label="上传 .cube LUT" onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) props.onUpload(file)
          }} />
        </div>
        <div className="select-wrap">
          <select aria-label="选择 LUT" value={props.selectedId} onChange={event => props.onSelect(event.currentTarget.value)}>
            <option value="">无 LUT（原片）</option>
            {builtins.length > 0 && <optgroup label="内置风格 LUT（Rec.709 SDR）">
              {builtins.map(lut => <option key={lut.id} value={lut.id}>{lut.name}</option>)}
            </optgroup>}
            {userLuts.length > 0 && <optgroup label="我的 LUT">
              {userLuts.map(lut => <option key={lut.id} value={lut.id}>{lut.name}</option>)}
            </optgroup>}
          </select>
          {props.lutLoading ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}
        </div>
        {selected && <p className="lut-details">{selected.size}³ · {selected.description}</p>}
        {builtin && <p className="lut-details">
          {builtin.input_color_space} ·{' '}
          <a className="underline" href={builtin.source_url} target="_blank" rel="noreferrer">{builtin.upstream} {builtin.version}</a>
          {' · '}
          <a className="underline" href={builtin.license_url} target="_blank" rel="noreferrer">{builtin.license}</a>
        </p>}
        <div className="adjustment-row strength-row">
          <div className="slider-label"><label htmlFor="lut-intensity">LUT 强度</label><output>{props.intensity}%</output></div>
          <input id="lut-intensity" className="grade-slider" type="range" min={0} max={100} value={props.intensity}
            disabled={!props.selectedId} style={{ '--from': '0%', '--to': `${props.intensity}%` } as CSSProperties}
            onChange={event => props.onIntensity(event.currentTarget.valueAsNumber)} />
        </div>
      </section>

      <section className="grading-section">
        <h3>基础</h3>
        {base.map(({ name, key }) => <AdjustmentSlider key={key} adjustment={key} name={name}
          value={adjustments[key]} onChange={onAdjust} />)}
      </section>

      <section className="grading-section">
        <h3>分区</h3>
        {zones.map(({ name, key }) => <AdjustmentSlider key={key} adjustment={key} name={name}
          value={adjustments[key]} onChange={onAdjust} />)}
      </section>

      <section className="grading-section curve-section">
        <h3><Activity size={15} /> 色调曲线</h3>
        <CurvePlot curve={curve} adjustments={adjustments} />
      </section>
    </aside>
  )
})

import { clamp } from '../model'
import type { CubeLut } from './cubeParser'

const vertexSource = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 2.0 : 0.0, gl_VertexID == 2 ? 2.0 : 0.0);
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_video;
uniform highp sampler3D u_lut3d;
uniform sampler2D u_curve1d;
uniform bool u_bypass;
uniform bool u_hasLut;
uniform float u_lutSize;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;
uniform float u_lutIntensity;
uniform float u_exposureEv;
uniform float u_contrast;
in vec2 v_uv;
out vec4 fragColor;
float tone(float c) {
  return texture(u_curve1d, vec2((c * 255.0 + 0.5) / 256.0, 0.5)).r;
}
void main() {
  vec3 color = texture(u_video, v_uv).rgb;
  if (!u_bypass) {
    if (u_hasLut && u_lutIntensity > 0.0001) {
      vec3 norm = clamp((color - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
      vec3 coord = (norm * (u_lutSize - 1.0) + 0.5) / u_lutSize;
      color = mix(color, texture(u_lut3d, coord).rgb, u_lutIntensity);
    }
    color = clamp(color * exp2(u_exposureEv), 0.0, 1.0);
    color = clamp((color - 0.5) * u_contrast + 0.5, 0.0, 1.0);
    color = vec3(tone(color.r), tone(color.g), tone(color.b));
  }
  fragColor = vec4(color, 1.0);
}`

export interface Grade {
  lut: CubeLut | null
  intensity: number
  exposure: number
  contrast: number
  curve: Uint8Array
  bypass: boolean
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('无法创建 WebGL 着色器')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(reason ?? '无法编译 WebGL 着色器')
  }
  return shader
}

function link(gl: WebGL2RenderingContext) {
  const program = gl.createProgram()
  if (!program) throw new Error('无法创建 WebGL 程序')
  let vertex: WebGLShader | undefined
  let fragment: WebGLShader | undefined
  try {
    vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? '无法链接 WebGL 程序')
    }
    return program
  } catch (error) {
    gl.deleteProgram(program)
    throw error
  } finally {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
  }
}

const uniformNames = [
  'video', 'lut3d', 'curve1d', 'bypass', 'hasLut', 'lutSize', 'domainMin', 'domainMax',
  'lutIntensity', 'exposureEv', 'contrast',
] as const

export class WebGLLutRenderer {
  isWebGL2Supported = false
  private readonly gl: WebGL2RenderingContext | null
  private readonly uniforms = {} as Record<typeof uniformNames[number], WebGLUniformLocation | null>
  private program: WebGLProgram | null = null
  private textures: WebGLTexture[] = []
  private floatFiltering = false
  private uploadedLut: CubeLut | null = null
  private uploadedCurve: Uint8Array | null = null
  private videoWidth = 0
  private videoHeight = 0
  private maxViewportWidth = 0
  private maxViewportHeight = 0
  private lutAvailable = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onAvailability: (supported: boolean) => void,
  ) {
    this.canvas.addEventListener('webglcontextlost', this.onLost)
    this.canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
    this.initialize()
  }

  private setAvailability(supported: boolean) {
    this.isWebGL2Supported = supported
    this.onAvailability(supported)
  }

  private onLost = (event: Event) => {
    event.preventDefault()
    this.setAvailability(false)
  }

  private onRestored = () => {
    this.program = null
    this.textures = []
    this.initialize()
  }

  private initialize() {
    const gl = this.gl
    if (!gl) {
      this.setAvailability(false)
      return
    }

    try {
      this.program = link(gl)
      gl.useProgram(this.program)
      for (const name of uniformNames) this.uniforms[name] = gl.getUniformLocation(this.program, `u_${name}`)
      this.floatFiltering = Boolean(gl.getExtension('OES_texture_float_linear'))
      const viewportLimits = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
      const renderLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
      this.maxViewportWidth = Math.min(viewportLimits[0], renderLimit)
      this.maxViewportHeight = Math.min(viewportLimits[1], renderLimit)
      this.videoWidth = this.videoHeight = 0
      this.uploadedLut = this.uploadedCurve = null
      this.lutAvailable = false

      this.createTexture(gl.TEXTURE_2D, 0)
      this.createTexture(gl.TEXTURE_3D, 1)
      // The sampler must stay complete when there is no selected LUT.
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
      this.createTexture(gl.TEXTURE_2D, 2)
      gl.uniform1i(this.uniforms.video, 0)
      gl.uniform1i(this.uniforms.lut3d, 1)
      gl.uniform1i(this.uniforms.curve1d, 2)
      this.setAvailability(true)
    } catch (error) {
      console.warn('WebGL2 initialization failed', error)
      this.releaseResources()
      this.setAvailability(false)
    }
  }

  private createTexture(target: number, unit: number) {
    const gl = this.gl!
    const texture = gl.createTexture()
    if (!texture) throw new Error('无法创建 WebGL 纹理')
    this.textures.push(texture)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(target, texture)
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  }

  private uploadLut(lut: CubeLut) {
    const gl = this.gl!
    const { size } = lut
    gl.activeTexture(gl.TEXTURE1)
    if (this.floatFiltering) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, size, size, size, 0, gl.RGBA, gl.FLOAT, lut.rgba32f)
      if (gl.getError() === gl.NO_ERROR) return true
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.rgba8)
    return gl.getError() === gl.NO_ERROR
  }

  render(video: HTMLVideoElement, grade: Grade, uploadFrame: boolean, snapshot?: HTMLCanvasElement) {
    const gl = this.gl
    if (!gl || !this.isWebGL2Supported) return false

    const width = video.videoWidth
    const height = video.videoHeight
    const sizeChanged = width !== this.videoWidth || height !== this.videoHeight
    if ((uploadFrame || sizeChanged || snapshot) && !video.seeking && video.readyState >= video.HAVE_CURRENT_DATA) {
      gl.activeTexture(gl.TEXTURE0)
      if (sizeChanged) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video)
        this.videoWidth = width
        this.videoHeight = height
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video)
      }
    }

    if (!this.videoWidth) return false

    if (grade.lut !== this.uploadedLut) {
      this.lutAvailable = grade.lut ? this.uploadLut(grade.lut) : false
      this.uploadedLut = grade.lut
      if (grade.lut && !this.lutAvailable) {
        this.setAvailability(false)
        return false
      }
    }
    if (grade.curve !== this.uploadedCurve) {
      gl.activeTexture(gl.TEXTURE2)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, grade.curve)
      this.uploadedCurve = grade.curve
    }

    gl.uniform1i(this.uniforms.bypass, Number(grade.bypass))
    gl.uniform1i(this.uniforms.hasLut, Number(this.lutAvailable))
    if (grade.lut) {
      gl.uniform1f(this.uniforms.lutSize, grade.lut.size)
      gl.uniform3fv(this.uniforms.domainMin, grade.lut.domainMin)
      gl.uniform3fv(this.uniforms.domainMax, grade.lut.domainMax)
    }
    gl.uniform1f(this.uniforms.lutIntensity, grade.intensity)
    gl.uniform1f(this.uniforms.exposureEv, clamp(grade.exposure / 50, -3, 3))
    gl.uniform1f(this.uniforms.contrast, clamp(1 + grade.contrast / 100, 0, 2))

    this.resize()
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    if (snapshot) {
      snapshot.width = this.canvas.width
      snapshot.height = this.canvas.height
      snapshot.getContext('2d')?.drawImage(this.canvas, 0, 0)
    }
    return true
  }

  private resize() {
    const gl = this.gl!
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.min(this.maxViewportWidth, Math.round(this.canvas.clientWidth * dpr)))
    const height = Math.max(1, Math.min(this.maxViewportHeight, Math.round(this.canvas.clientHeight * dpr)))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height

    const scale = Math.min(width / this.videoWidth, height / this.videoHeight)
    const fittedWidth = Math.max(1, Math.round(this.videoWidth * scale))
    const fittedHeight = Math.max(1, Math.round(this.videoHeight * scale))
    const x = Math.floor((width - fittedWidth) / 2)
    const y = Math.floor((height - fittedHeight) / 2)
    if (fittedWidth !== width || fittedHeight !== height) {
      gl.clearColor(0.035, 0.035, 0.047, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.viewport(x, y, fittedWidth, fittedHeight)
  }

  private releaseResources() {
    if (this.gl && this.program) this.gl.deleteProgram(this.program)
    for (const texture of this.textures) this.gl?.deleteTexture(texture)
    this.program = null
    this.textures = []
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.releaseResources()
    this.isWebGL2Supported = false
  }
}

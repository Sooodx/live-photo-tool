import { useEffect, useRef } from 'react'

interface Hotkeys {
  toggle: () => void
  step: (direction: number, halfSecond: boolean) => void
  markIn: () => void
  markOut: () => void
  markCover: () => void
  compare: (down: boolean) => void
}

export function useHotkeys(hotkeys: Hotkeys | null) {
  const current = useRef(hotkeys)
  current.current = hotkeys

  useEffect(() => {
    let comparing: Hotkeys | null = null
    const keydown = (event: KeyboardEvent) => {
      const target = event.target
      const keys = current.current
      if (!keys || event.altKey || event.ctrlKey || event.metaKey ||
          (target instanceof Element && target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])'))) return

      switch (event.code) {
        case 'Space':
          if (target instanceof Element && target.closest('button, a[href]')) return
          if (!event.repeat) keys.toggle()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
          keys.step(event.code === 'ArrowLeft' ? -1 : 1, event.shiftKey)
          break
        case 'KeyI':
          keys.markIn()
          break
        case 'KeyO':
          keys.markOut()
          break
        case 'KeyC':
          keys.markCover()
          break
        case 'KeyB':
          if (!event.repeat) {
            comparing = keys
            keys.compare(true)
          }
          break
        default:
          return
      }
      event.preventDefault()
    }
    const clear = () => {
      comparing?.compare(false)
      comparing = null
    }
    const keyup = (event: KeyboardEvent) => {
      if (event.code === 'KeyB') clear()
    }

    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
      window.removeEventListener('blur', clear)
    }
  }, [])
}

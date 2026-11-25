import { useEffect, useState } from 'react'

export function useBlobUrl(blob: Blob | null) {
  const [current, setCurrent] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setCurrent({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return current && current.blob === blob ? current.url : undefined
}

// lib/hooks/AutoSave.tsx

import React from 'react'

/**
 * Debounces a rapidly changing value by a specified delay.
 * @param value The input value to debounce.
 * @param delay The debounce interval in milliseconds.
 * @returns The debounced value.
 */
export function useDebounce<T>(value: T, delay = 500): T {
  const [debouncedValue, setDebouncedValue] = React.useState<T>(value)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined // Guard for SSR

    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [value, delay])

  return debouncedValue
}

/**
 * Custom hook to autosave a changing value after debouncing.
 * Handles async save functions properly and optionally tracks save status.
 *
 * @param liveData The data to autosave.
 * @param onSave The save function; may be async or sync.
 * @param interval Debounce interval in milliseconds.
 * @param options Additional options.
 * @param options.saveOnMount If true, triggers save immediately on mount.
 * @returns An object with a saving boolean indicating save in progress.
 */
export function useAutosave<T>(
  liveData: T,
  onSave: (data: T) => void | Promise<void>,
  interval = 500,
  options?: { saveOnMount?: boolean }
): { saving: boolean } {
  const debouncedValue = useDebounce(liveData, interval)
  const initialRender = React.useRef(true)
  const [saving, setSaving] = React.useState(false)

  // Keep latest onSave function reference stable
  const handleSave = React.useRef(onSave)
  React.useEffect(() => {
    handleSave.current = onSave
  }, [onSave])

  React.useEffect(() => {
    if (initialRender.current) {
      if (options?.saveOnMount) {
        setSaving(true)
        Promise.resolve(handleSave.current(liveData))
          .catch((error) => {
            console.error('Autosave onMount error:', error)
          })
          .finally(() => setSaving(false))
      }
      initialRender.current = false
      return
    }

    setSaving(true)
    Promise.resolve(handleSave.current(debouncedValue))
      .catch((error) => {
        // You may want to log or handle errors here
        console.error('Autosave error:', error)
      })
      .finally(() => setSaving(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue])

  return { saving }
}

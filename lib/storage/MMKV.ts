// lib/storage/MMKV.ts
import { useState, useEffect, useCallback } from 'react'
import { MMKV } from 'react-native-mmkv'
import type { StateStorage } from 'zustand/middleware'

// Uncomment and configure your Logger as needed
// import { Logger } from '../state/Logger'

/**
 * Singleton MMKV instance used for storage operations.
 * Configure with options if needed (e.g., encryption).
 */
export const mmkv = new MMKV()

/**
 * Zustand-compatible storage adapter backed by MMKV.
 * Supports strings only to comply with Zustand interface.
 * Wraps calls in try/catch to avoid crashes.
 */
export const mmkvStorage: StateStorage = {
  setItem: (key: string, value: string): void => {
    try {
      mmkv.set(key, value)
      // Logger?.debug(`MMKV set key: ${key}`)
    } catch (e) {
      // Logger?.error(`MMKV setItem error for key "${key}":`, e)
      console.error(`MMKV setItem error for key "${key}":`, e)
    }
  },

  getItem: (key: string): string | null => {
    try {
      const val = mmkv.getString(key)
      return val ?? null
    } catch (e) {
      // Logger?.error(`MMKV getItem error for key "${key}":`, e)
      console.error(`MMKV getItem error for key "${key}":`, e)
      return null
    }
  },

  removeItem: (key: string): void => {
    try {
      mmkv.delete(key)
      // Logger?.debug(`MMKV removed key: ${key}`)
    } catch (e) {
      // Logger?.error(`MMKV removeItem error for key "${key}":`, e)
      console.error(`MMKV removeItem error for key "${key}":`, e)
    }
  },
}

/**
 * Generic React hook for persisting any serializable data in MMKV.
 * 
 * @param key Storage key used in MMKV.
 * @param defaultValue Initial value used if no key is found.
 * @returns [value, setValue, removeValue] tuple.
 *          - value: current stored value or default.
 *          - setValue: updater function to persist new value.
 *          - removeValue: function to clear the stored value.
 */
export function useMMKVState<T>(
  key: string,
  defaultValue: T,
): [T, (val: T) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const json = mmkv.getString(key)
      if (json == null) return defaultValue
      return JSON.parse(json) as T
    } catch {
      // On JSON parse failure, fallback to default
      return defaultValue
    }
  })

  useEffect(() => {
    try {
      mmkv.set(key, JSON.stringify(value))
    } catch (e) {
      // Logger?.error(`Failed persisting key '${key}':`, e)
      console.error(`Failed persisting key '${key}':`, e)
    }
  }, [key, value])

  const removeValue = useCallback(() => {
    try {
      mmkv.delete(key)
      setValue(defaultValue)
    } catch (e) {
      // Logger?.error(`Failed removing key '${key}':`, e)
      console.error(`Failed removing key '${key}':`, e)
    }
  }, [key, defaultValue])

  return [value, setValue, removeValue]
}

/**
 * Convenience hook specialized for booleans persisted in MMKV.
 * Returns value, setter, and remover.
 * 
 * @param key MMKV key.
 * @param defaultValue Defaults to false if omitted.
 * @returns [booleanValue, setBooleanValue, removeBooleanValue]
 */
export function useMMKVBoolean(
  key: string,
  defaultValue = false,
): [boolean, (val: boolean) => void, () => void] {
  return useMMKVState<boolean>(key, defaultValue)
}

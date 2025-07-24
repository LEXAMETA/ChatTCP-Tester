// lib/state/Logger.ts
import { Storage } from '@lib/enums/Storage'
import Toast from 'react-native-simple-toast'
import { create } from 'zustand'
import { createJSONStorage, persist, PersistOptions } from 'zustand/middleware'

import { AppSettings } from '../constants/GlobalValues'
import { mmkv, mmkvStorage } from '../storage/MMKV'

// --- Constants ---
const TOAST_DURATION = Toast.SHORT
const MAX_LOG_ENTRIES = 2000

/**
 * Log levels for categorizing log entries.
 */
export enum LogLevel {
  INFO = 0,
  WARN = 1,
  ERROR = 2,
  DEBUG = 3,
}

/**
 * Represents a single log entry.
 */
type LogEntry = {
  timestamp: string // ISO8601 timestamp string for consistency
  message: string
  level: LogLevel
}

/**
 * State shape for the logger store.
 */
type LogStateProps = {
  logs: LogEntry[]
  addLog: (entry: LogEntry) => void
  flushLogs: () => void
}

/**
 * Persisted subset of logger state.
 */
type PersistedLogState = Pick<LogStateProps, 'logs'>

// Minimum log level to print/store (can be set at runtime)
let minLogLevel = LogLevel.INFO

/**
 * Modify the minimal log level for output and storage.
 * @param level LogLevel threshold: entries below this level are ignored.
 */
export const setMinLogLevel = (level: LogLevel): void => {
  minLogLevel = level
}

export namespace Logger {
  /**
   * Zustand store for logging state.
   */
  export const useLoggerState = create<LogStateProps>()(
    persist<LogStateProps, PersistedLogState>(
      (set, get) => ({
        logs: [],

        addLog: (entry) => {
          if (entry.level < minLogLevel) return // Filter out below threshold

          set((state) => {
            const newLogs =
              state.logs.length >= MAX_LOG_ENTRIES
                ? [...state.logs.slice(1), entry]
                : [...state.logs, entry]
            return { logs: newLogs }
          })
        },

        flushLogs: () => {
          // Log flush info before clearing logs to avoid losing it
          Logger.info('All in-app logs flushed.')
          set(() => ({ logs: [] }))
        },
      }),
      {
        name: Storage.Logs,
        storage: createJSONStorage(() => mmkvStorage),
        version: 1,
        partialize: (state: LogStateProps): PersistedLogState => ({
          logs: state.logs,
        }),
        migrate: async (persistedState: unknown, version: number): Promise<void> => {
          // Placeholder for future migrations
          // Example:
          // if (version === 0) { ... }
        },
      } as PersistOptions<LogStateProps, PersistedLogState>
    )
  )

  /**
   * Map log levels to string prefix.
   */
  export const LevelName: Record<LogLevel, string> = {
    [LogLevel.INFO]: '[INFO]',
    [LogLevel.WARN]: '[WARN]',
    [LogLevel.ERROR]: '[ERROR]',
    [LogLevel.DEBUG]: '[DEBUG]',
  }

  /**
   * Safely stringify objects including those with circular references.
   * @param obj The object to stringify.
   */
  const safeStringify = (obj: unknown): string => {
    const seen = new WeakSet()
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    })
  }

  /**
   * Format the main log message plus optional parameters into a single string.
   * Handles Error objects and safely stringifies others.
   * @param message Base message.
   * @param optionalParams Additional parameters.
   */
  const formatMessage = (message: string, optionalParams: unknown[]): string => {
    if (!optionalParams.length) return message

    const paramsStr = optionalParams
      .map((param) => {
        if (param instanceof Error) {
          return `Error: ${param.message}\nStack: ${param.stack ?? 'No stack trace'}`
        }
        try {
          return safeStringify(param)
        } catch {
          return String(param)
        }
      })
      .join(' ')

    return `${message} ${paramsStr}`
  }

  /**
   * Print log entry to console depending on level.
   * @param log Log entry to print.
   */
  const printLog = (log: LogEntry): void => {
    if (log.level < minLogLevel) return

    const prefix = `${LevelName[log.level]} ${log.timestamp}:`
    switch (log.level) {
      case LogLevel.ERROR:
        console.error(prefix, log.message)
        break
      case LogLevel.WARN:
        console.warn(prefix, log.message)
        break
      case LogLevel.DEBUG:
        if (console.debug) {
          console.debug(prefix, log.message)
        } else {
          console.log(prefix, log.message)
        }
        break
      default:
        console.log(prefix, log.message)
    }
  }

  /**
   * Insert a log entry into Zustand store.
   * @param entry LogEntry to insert.
   */
  const insertLogs = (entry: LogEntry): void => {
    Logger.useLoggerState.getState().addLog(entry)
  }

  // --- Public logging API ---

  /**
   * Log info message.
   */
  export const info = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      message: formatted,
      level: LogLevel.INFO,
    }
    printLog(entry)
    insertLogs(entry)
  }

  /**
   * Log info with toast.
   */
  export const infoToast = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    info(message, ...optionalParams)
    Toast.show(formatted, TOAST_DURATION)
  }

  /**
   * Log warn message.
   */
  export const warn = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      message: formatted,
      level: LogLevel.WARN,
    }
    printLog(entry)
    insertLogs(entry)
  }

  /**
   * Log warn with toast.
   */
  export const warnToast = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    warn(message, ...optionalParams)
    Toast.show(formatted, TOAST_DURATION, { textColor: 'yellow' })
  }

  /**
   * Log error message.
   */
  export const error = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      message: formatted,
      level: LogLevel.ERROR,
    }
    printLog(entry)
    insertLogs(entry)
  }

  /**
   * Log error with toast.
   */
  export const errorToast = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    error(message, ...optionalParams)
    Toast.show(formatted, TOAST_DURATION, { textColor: 'red' })
  }

  /**
   * Log debug message, only if `__DEV__` or explicit dev mode enabled.
   */
  export const debug = (message: string, ...optionalParams: unknown[]): void => {
    // Use MMKV boolean flag for dev mode as fallback
    if (!__DEV__ && !mmkv.getBoolean(AppSettings.DevMode)) return

    const formatted = formatMessage(message, optionalParams)
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      message: formatted,
      level: LogLevel.DEBUG,
    }
    printLog(entry)
    insertLogs(entry)
  }

  /**
   * Log debug with toast, restricted to dev mode.
   */
  export const debugToast = (message: string, ...optionalParams: unknown[]): void => {
    const formatted = formatMessage(message, optionalParams)
    debug(message, ...optionalParams)
    Toast.show(formatted, TOAST_DURATION, { textColor: 'blue' })
  }
}

// lib/state/TTS.ts
import { Storage } from '@lib/enums/Storage'
import { Logger } from '@lib/state/Logger'
import { mmkvStorage } from '@lib/storage/MMKV'
import * as Speech from 'expo-speech'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { Chats, useInference } from './Chat'

type TTSState = {
  activeChatIndex?: number
  voice?: Speech.Voice
  enabled: boolean
  auto: boolean
  rate: number
  liveTTS: boolean
  pauseLive?: boolean

  buffer: string

  startTTS: (text: string, index: number, exitCallback?: () => void) => Promise<void>
  stopTTS: () => Promise<void>
  setEnabled: (b: boolean) => void
  setAuto: (b: boolean) => void
  setVoice: (v: Speech.Voice) => void
  setRate: (r: number) => void
  setLiveTTS: (b: boolean) => void
  setPauseLive: (b: boolean) => void

  speak: (text: string, onDone?: () => void, onStop?: () => void) => void

  handleEndGeneration: (lastIndex: number, text: string) => Promise<void>
  handleStartGeneration: (lastIndex: number) => void

  clearAndRunBuffer: (lastIndex: number) => void
  clearBuffer: () => void
  insertBuffer: (text: string) => void
}

// Regex to detect sentence endings for splitting into speakable chunks.
// Positive lookbehind prevents splitting on decimal numbers.
// We'll reuse this regex instance for buffer insertions and reset lastIndex as needed.
const sentenceEndRegex = /(?<=[^\d])([.?!])(?:["'`*_)]*)\s+(?=[A-Z0-9])|([.?!])(?:["'`*_)]*)$/gm

/**
 * Debounce utility for delaying function calls to reduce frequency.
 */
function debounce<T extends (...args: any[]) => void>(fn: T, ms = 100) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fn(...args)
      timer = null
    }, ms)
  }
}

export const useTTSState = create<TTSState>()(
  persist(
    (set, get) => {
      // Helper to clear active chat index if matches current speaking index
      const clearActiveIndex = (index: number, exitCallback: () => void) => {
        if (get().activeChatIndex === index) {
          set({ activeChatIndex: undefined })
          exitCallback()
        }
      }

      // Helper to clean markdown for spoken text
      const cleanMarkdown = (text: string): string =>
        text.replace(/([*_]{1,2}|`|\[\^.*?\]\(.*?\)|<\/?[^>]+>)/g, '')

      return {
        voice: undefined,
        enabled: false,
        auto: false,
        liveTTS: false,
        rate: 1,
        activeChatIndex: undefined,
        pauseLive: false,
        buffer: '',

        startTTS: async (text, index, exitCallback = () => {}) => {
          const currentSpeaker = get().voice
          if (!currentSpeaker) {
            Logger.errorToast(`TTS Error: No speaker voice chosen.`)
            clearActiveIndex(index, exitCallback)
            return
          }

          if (await Speech.isSpeakingAsync()) {
            await Speech.stop()
          }

          // Split text into chunks preserving punctuation with regex
          // Keep split delimiters to append to chunks (e.g., end punctuation)
          const splitCharsRegex = /([.!?,"*])/g

          const rawChunks = text.split(splitCharsRegex)
          const processedChunks: string[] = []

          rawChunks.forEach((item) => {
            if (!item.trim()) return
            if (splitCharsRegex.test(item) && processedChunks.length > 0) {
              processedChunks[processedChunks.length - 1] += item
            } else {
              processedChunks.push(item)
            }
          })

          // Clean and filter empty chunks
          const cleanedChunks = processedChunks
            .map((chunk) => cleanMarkdown(chunk).trim())
            .filter(Boolean)

          if (!cleanedChunks.length) {
            Logger.warn('TTS: No speakable content after cleaning and chunking.')
            clearActiveIndex(index, exitCallback)
            return
          }

          Logger.debug(`TTS: Prepared ${cleanedChunks.length} chunks for speaking.`)
          set({ activeChatIndex: index })

          // Sequentially speak chunks, avoiding overlap and race conditions
          for (let i = 0; i < cleanedChunks.length; i++) {
            const chunk = cleanedChunks[i]
            await new Promise<void>((resolve) => {
              Speech.speak(chunk, {
                language: currentSpeaker.language,
                voice: currentSpeaker.identifier,
                rate: get().rate,
                onDone: () => {
                  if (i === cleanedChunks.length - 1) {
                    clearActiveIndex(index, exitCallback)
                  }
                  resolve()
                },
                onStopped: () => {
                  clearActiveIndex(index, exitCallback)
                  resolve()
                },
              })
            })
          }
        },

        stopTTS: async () => {
          Logger.info('TTS: Stopping playback.')
          set({ activeChatIndex: undefined })
          await Speech.stop()
        },

        setEnabled: (b) => set({ enabled: b }),
        setAuto: (b) => set({ auto: b }),
        setVoice: (v) => set({ voice: v }),
        setRate: (r) => set({ rate: r }),
        setLiveTTS: (b) => set({ liveTTS: b }),
        setPauseLive: (b) => set({ pauseLive: b }),

        speak: (text, onDone = () => {}, onStop = () => {}) => {
          const currentSpeaker = get().voice
          if (!currentSpeaker) {
            Logger.error(`TTS: Attempted to speak without a selected voice.`)
            return
          }
          Speech.speak(text, {
            language: currentSpeaker.language,
            voice: currentSpeaker.identifier,
            onDone,
            onStopped: onStop,
            rate: get().rate,
          })
        },

        handleEndGeneration: async (lastIndex, text) => {
          if (get().activeChatIndex !== undefined) return

          if (get().liveTTS) {
            get().clearAndRunBuffer(lastIndex)
          } else if (get().enabled && get().auto) {
            await get().stopTTS()
            get().startTTS(text, lastIndex)
          }
        },

        handleStartGeneration: (lastIndex) => {
          if (get().liveTTS) {
            Speech.stop()
            set({ activeChatIndex: lastIndex })
            get().clearBuffer()
          }
          set({ pauseLive: false })
        },

        clearAndRunBuffer: (lastIndex) => {
          const buffer = get().buffer.trim()

          if (!get().pauseLive && buffer.length) {
            const clean = cleanMarkdown(buffer)
            if (clean.length) {
              set({ activeChatIndex: lastIndex })
              get().speak(clean, () => set({ activeChatIndex: undefined }))
            } else {
              set({ activeChatIndex: undefined })
            }
          } else {
            set({ activeChatIndex: undefined })
          }

          set({ buffer: '' })
        },

        clearBuffer: () => set({ buffer: '' }),

        insertBuffer: debounce((text: string) => {
          if (!get().liveTTS || get().pauseLive) return

          const newBuffer = get().buffer + text

          sentenceEndRegex.lastIndex = 0 // Reset regex state
          let lastMatchIndex = -1
          let match: RegExpExecArray | null
          while ((match = sentenceEndRegex.exec(newBuffer)) !== null) {
            lastMatchIndex = sentenceEndRegex.lastIndex
          }

          if (lastMatchIndex !== -1) {
            const fullSentence = newBuffer.slice(0, lastMatchIndex).trim()
            const remainder = newBuffer.slice(lastMatchIndex)
            const clean = cleanMarkdown(fullSentence)

            if (clean.length) {
              get().speak(
                clean,
                () => {},
                () => set({ pauseLive: true, activeChatIndex: undefined, buffer: '' })
              )
            }
            set({ buffer: remainder })
          } else {
            set({ buffer: newBuffer })
          }
        }, 100),
      }
    },
    {
      name: Storage.TTS,
      storage: createJSONStorage(() => mmkvStorage),
      version: 1,
      partialize: (state) => ({
        enabled: state.enabled,
        auto: state.auto,
        voice: state.voice,
        rate: state.rate,
        liveTTS: state.liveTTS,
      }),
    }
  )
)

// Manage inference subscription safely (avoid multiple subscriptions on hot reload)
let subscriptionCleanup: (() => void) | null = null
export function subscribeInferenceToTTS() {
  if (subscriptionCleanup) return // already subscribed

  subscriptionCleanup = useInference.subscribe(({ nowGenerating }) => {
    const data = Chats.useChatState.getState().data
    if (!data?.messages?.length) return

    const lastIndex = data.messages.length - 1
    if (!nowGenerating) {
      const message = data.messages[lastIndex]
      if (!message?.swipes?.[message.swipe_id]) {
        Logger.warn('TTS: No message content found at end of generation.')
        return
      }
      useTTSState.getState().handleEndGeneration(
        lastIndex,
        message.swipes[message.swipe_id]!.swipe
      )
    } else {
      useTTSState.getState().handleStartGeneration(lastIndex)
    }
  })
}

// Call this on app/component unmount if needed
export function unsubscribeInferenceFromTTS() {
  if (subscriptionCleanup) {
    subscriptionCleanup()
    subscriptionCleanup = null
  }
}

/**
 * Hook for components to consume TTS store state/actions efficiently.
 */
export const useTTS = () => {
  return useTTSState((state) => ({
    startTTS: state.startTTS,
    stopTTS: state.stopTTS,
    activeChatIndex: state.activeChatIndex,
    setVoice: state.setVoice,
    setEnabled: state.setEnabled,
    setAuto: state.setAuto,
    setRate: state.setRate,
    auto: state.auto,
    enabled: state.enabled,
    voice: state.voice,
    rate: state.rate,
    live: state.liveTTS,
    setLive: state.setLiveTTS,
  }))
}

// lib/state/Chat.ts

// --- Imports ---
import { database } from '@db' // Adjust import if alias differs
import { Tokenizer } from '@lib/engine/Tokenizer'
import { replaceMacros } from '@lib/utils/Macros'
import { convertToFormatInstruct } from '@lib/utils/TextFormat'
import { chatEntries, chats, ChatSwipe, chatSwipes, CompletionTimings } from 'db/schema'
import { and, count, desc, eq, getTableColumns, like } from 'drizzle-orm'
import * as Notifications from 'expo-notifications'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer' // alternative for immutability
import { Logger } from './Logger'
import { AppSettings } from '../constants/GlobalValues'
import { mmkv } from '../storage/MMKV'

// --- Types ---

export interface ChatSwipeState extends ChatSwipe {
  token_count?: number
  regen_cache?: string
}

export type ChatEntry = {
  id: number
  chat_id: number
  name: string
  is_user: boolean
  order: number
  swipe_id: number
  swipes: ChatSwipeState[]
}

export type ChatData = {
  id: number
  create_date: Date
  character_id: number
  user_id: number | null
  name: string
  messages: ChatEntry[]
}

export interface ChatState {
  data?: ChatData
  buffer: OutputBuffer

  loadChat: (chatId: number) => Promise<void>
  deleteChat: (chatId: number) => Promise<void>
  addChatEntry: (name: string, isUser: boolean, message: string) => Promise<number | void>
  updateChatEntry: (
    index: number,
    message: string,
    options?: {
      updateFinished?: boolean
      updateStarted?: boolean
      verifySwipeId?: number
      timings?: CompletionTimings
      resetTimings?: boolean
    }
  ) => Promise<void>
  deleteChatEntry: (index: number) => Promise<void>
  resetChatState: () => void
  swipeChatEntry: (entryIndex: number, direction: number) => Promise<boolean>
  addChatSwipe: (entryIndex: number, message?: string) => Promise<number | void>
  getEntryTokenCount: (entryIndex: number) => number
  setBuffer: (newBuffer: OutputBuffer) => void
  insertBuffer: (data: string) => void
  saveBufferToLastEntry: (cachedSwipeId?: number) => Promise<void>
  loadLastEntryIntoBuffer: () => void
  setRegenerationCache: () => void
  getRegenerationCache: () => string
  resetRegenerationCache: () => void
}

export type OutputBuffer = {
  data: string
  timings?: CompletionTimings
  error?: string
}

type ChatSwipeUpdated = Pick<ChatSwipe, 'swipe' | 'id'> & Partial<Omit<ChatSwipe, 'swipe' | 'id'>>

// --- Notification helper ---

export const sendGenerateCompleteNotification = async (): Promise<void> => {
  const showMessage = mmkv.getBoolean(AppSettings.ShowNotificationText)
  const characterName = Characters.useCharacterCard.getState().card?.name ?? 'Unknown Character'
  const notificationTitle = showMessage ? characterName : 'Response Complete'
  const notificationBody = showMessage
    ? Chats.useChatState.getState().buffer?.data?.trim() || 'No response content.'
    : 'ChatterUI has finished a response.'

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  })

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notificationTitle,
        body: notificationBody,
        sound: !!mmkv.getBoolean(AppSettings.PlayNotificationSound),
        vibrate: mmkv.getBoolean(AppSettings.VibrateNotification) ? [250, 125, 250] : undefined,
        badge: 0,
      },
      trigger: null,
    })
    await Notifications.setBadgeCountAsync(0)
    Logger.info('Generation complete notification sent.')
  } catch (error) {
    Logger.error(`Failed to send notification: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- Zustand store with Immer for easier immutable updates ---

export const useInference = create<{
  abortFunction: () => void | Promise<void>
  nowGenerating: boolean
  currentSwipeId?: number
  startGenerating: (swipeId: number) => void
  stopGenerating: () => void
  setAbortFunction: (fn: () => void | Promise<void>) => void
}>((set, get) => ({
  abortFunction: () => {
    Logger.warn('Default abort function called. No specific abort logic set.')
    get().stopGenerating()
  },
  nowGenerating: false,
  currentSwipeId: undefined,
  startGenerating: (swipeId) => {
    Logger.info(`Inference started for swipe ID: ${swipeId}`)
    set({ currentSwipeId: swipeId, nowGenerating: true })
  },
  stopGenerating: () => {
    Logger.info('Inference stopped.')
    set({ nowGenerating: false, currentSwipeId: undefined })
    if (mmkv.getBoolean(AppSettings.NotifyOnComplete)) {
      sendGenerateCompleteNotification()
    }
  },
  setAbortFunction: (fn) => {
    Logger.debug('Set abort function.')
    set({
      abortFunction: async () => {
        try {
          await fn()
          Logger.info('Generation actively aborted.')
        } catch (error) {
          Logger.error(`Error during abort: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
  },
}))

export namespace Chats {
  export const useChatState = create<ChatState>()(
    immer((set, get) => ({
      data: undefined,
      buffer: { data: '' },

      async loadChat(chatId: number): Promise<void> {
        try {
          const loaded = await db.query.getChatById(chatId)

          if (!loaded) {
            Logger.warn(`Chat ID ${chatId} not found. Resetting chat state.`)
            set((state) => {
              state.data = undefined
            })
            return
          }

          // Auto-load user if configured
          if (loaded.user_id && mmkv.getBoolean(AppSettings.AutoLoadUser)) {
            const currentUserId = Characters.useUserCard.getState().id
            if (currentUserId !== loaded.user_id) {
              Logger.info(`Autoloading User ID: ${loaded.user_id}`)
              await Characters.useUserCard.getState().setCard(loaded.user_id)
              const userName = Characters.useUserCard.getState().card?.name
              if (userName) Logger.infoToast(`Loading User: ${userName}`)
            }
          }

          set((state) => {
            state.data = { ...loaded, messages: loaded.messages || [] }
          })

          Logger.info(`Chat ID ${chatId} loaded.`)
        } catch (error) {
          Logger.error(`Failed to load chat ID ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
          set((state) => {
            state.data = undefined
          })
        }
      },

      async deleteChat(chatId: number): Promise<void> {
        try {
          await db.mutate.deleteChat(chatId)
          const currentChatId = get().data?.id
          if (currentChatId === chatId)
            set((state) => {
              state.data = undefined
            })
          Logger.info(`Chat ID ${chatId} deleted.`)
        } catch (error) {
          Logger.error(`Failed to delete chat ID ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },

      resetChatState(): void {
        Logger.debug('Resetting chat state.')
        set((state) => {
          state.data = undefined
          state.buffer = { data: '' }
        })
      },

      async addChatEntry(name: string, isUser: boolean, message: string): Promise<number | void> {
        const currentChat = get().data
        if (!currentChat?.id) {
          Logger.error('No chat loaded or missing chat ID for adding entry.')
          return
        }

        const messages = currentChat.messages ?? []
        const order = messages.length > 0 ? messages[messages.length - 1].order + 1 : 0

        try {
          const newEntry = await db.mutate.createEntry(currentChat.id, name, isUser, order, message)
          if (newEntry) {
            set((state) => {
              state.data!.messages.push(newEntry)
            })
            Logger.info(`Added new chat entry for chat ID ${currentChat.id}.`)
            return newEntry.swipes?.[0]?.id
          } else {
            Logger.error('DB call to create entry returned undefined.')
          }
        } catch (error) {
          Logger.error(`Failed to add chat entry: ${error instanceof Error ? error.message : String(error)}`)
        }
      },

      async deleteChatEntry(index: number): Promise<void> {
        const messages = get().data?.messages
        if (!messages || index < 0 || index >= messages.length) {
          Logger.warn(`Delete chat entry failed: invalid index ${index}.`)
          return
        }

        try {
          const entry = messages[index]
          await db.mutate.deleteChatEntry(entry.id)

          set((state) => {
            state.data!.messages.splice(index, 1)
          })
          Logger.info(`Deleted chat entry ID ${entry.id}.`)
        } catch (error) {
          Logger.error(`Failed to delete chat entry at index ${index}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },

      async updateChatEntry(
        index: number,
        message: string,
        options = {}
      ): Promise<void> {
        const {
          verifySwipeId,
          updateFinished,
          updateStarted,
          timings,
          resetTimings,
        } = options

        const messages = get().data?.messages
        if (!messages || index < 0 || index >= messages.length) {
          Logger.warn(`Update chat entry failed: invalid index ${index}.`)
          return
        }

        const entry = messages[index]
        const activeSwipe = entry.swipes[entry.swipe_id]
        if (!activeSwipe) {
          Logger.error(`No active swipe for message at index ${index}.`)
          return
        }

        let swipeId = activeSwipe.id
        let updateState = true
        if (verifySwipeId !== undefined) {
          updateState = verifySwipeId === swipeId
          if (!updateState) {
            swipeId = verifySwipeId
            Logger.debug(`Override swipeId to ${swipeId} for update.`)
          }
        }

        const updatedSwipeData: ChatSwipeUpdated = {
          id: swipeId,
          swipe: message,
          gen_finished: updateFinished ? new Date() : undefined,
          gen_started: updateStarted ? new Date() : undefined,
          timings: resetTimings ? null : timings ?? undefined,
        }

        try {
          await db.mutate.updateChatSwipe(updatedSwipeData)
          Logger.info(`Chat swipe ID ${swipeId} updated.`)

          if (updateState) {
            set((state) => {
              if (!state.data) return
              const msg = state.data.messages
              const entryCopy = { ...msg[index], swipes: [...msg[index].swipes] }
              entryCopy.swipes[entryCopy.swipe_id] = { ...entryCopy.swipes[entryCopy.swipe_id], ...updatedSwipeData, token_count: undefined }
              msg[index] = entryCopy
            })
            Logger.debug(`Zustand state updated for chat entry ${index}.`)
          } else {
            Logger.debug('Zustand state not updated due to verifySwipeId mismatch.')
          }
        } catch (error) {
          Logger.error(`Failed to update chat swipe: ${error instanceof Error ? error.message : String(error)}`)
        }
      },

      async swipeChatEntry(entryIndex: number, direction: number): Promise<boolean> {
        const messages = get().data?.messages
        if (!messages || entryIndex < 0 || entryIndex >= messages.length) {
          Logger.warn(`Swipe chat entry failed: invalid index ${entryIndex}.`)
          return false
        }

        const entry = messages[entryIndex]
        const targetId = entry.swipe_id + direction
        if (targetId < 0) {
          Logger.debug('Cannot swipe left; at first swipe.')
          return false
        }
        if (targetId >= entry.swipes.length) {
          Logger.debug('Cannot swipe right; at last swipe.')
          return true // signal end reached, may trigger new generation
        }

        set((state) => {
          if (!state.data) return
          state.data.messages[entryIndex].swipe_id = targetId
        })

        try {
          await db.mutate.updateEntrySwipeId(entry.id, targetId)
          Logger.info(`Swiped chat entry ${entryIndex} to swipe ID ${targetId}.`)
        } catch (error) {
          Logger.error(`Failed to update swipe ID in DB for entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
        }

        return false
      },

      async addChatSwipe(entryIndex: number, message: string = ''): Promise<number | void> {
        const messages = get().data?.messages
        if (!messages || entryIndex < 0 || entryIndex >= messages.length) {
          Logger.warn(`Add swipe failed: invalid entry index ${entryIndex}`)
          return
        }

        const entry = messages[entryIndex]
        try {
          const newSwipe = await db.mutate.createSwipe(entry.id, message)
          if (newSwipe) {
            set((state) => {
              if (!state.data) return
              const entryCopy = { ...state.data.messages[entryIndex], swipes: [...state.data.messages[entryIndex].swipes, newSwipe] }
              entryCopy.swipe_id = entryCopy.swipes.length - 1
              state.data.messages[entryIndex] = entryCopy
            })
            await db.mutate.updateEntrySwipeId(entry.id, newSwipe.id)
            Logger.info(`Added new swipe to entry ID ${entry.id}. Swipe ID: ${newSwipe.id}`)
            return newSwipe.id
          }
          Logger.error('Database returned no new swipe on createSwipe.')
        } catch (error) {
          Logger.error(`Adding swipe failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },

      getEntryTokenCount(entryIndex: number): number {
        const messages = get().data?.messages
        if (!messages || entryIndex < 0 || entryIndex >= messages.length) {
          Logger.warn(`GetEntryTokenCount failed: invalid entry index ${entryIndex}`)
          return 0
        }

        const entry = messages[entryIndex]
        const swipe = entry.swipes[entry.swipe_id]
        if (!swipe) {
          Logger.warn(`No active swipe for entry ${entryIndex} token count.`)
          return 0
        }

        if (swipe.token_count !== undefined) {
          return swipe.token_count
        }

        const tokenizer = Tokenizer.getTokenizer()
        if (!tokenizer) {
          Logger.error('Tokenizer not initialized.')
          return 0
        }

        const tokenCount = tokenizer(swipe.swipe)

        set((state) => {
          if (!state.data) return
          const entryCopy = { ...state.data.messages[entryIndex], swipes: [...state.data.messages[entryIndex].swipes] }
          const swipeCopy = { ...entryCopy.swipes[entryCopy.swipe_id], token_count: tokenCount }
          entryCopy.swipes[entryCopy.swipe_id] = swipeCopy
          state.data.messages[entryIndex] = entryCopy
        })

        Logger.debug(`Token count cached for entry ${entryIndex}.`)
        return tokenCount
      },

      setBuffer(newBuffer: OutputBuffer): void {
        Logger.debug('Output buffer set.')
        set({ buffer: newBuffer })
      },

      insertBuffer(data: string): void {
        set((state) => {
          state.buffer.data += data
        })
        Logger.debug(`Inserted data to buffer. Length now: ${get().buffer.data.length}`)
      },

      async saveBufferToLastEntry(cachedSwipeId?: number): Promise<void> {
        const messages = get().data?.messages
        const buffer = get().buffer

        if (!messages || messages.length === 0) {
          if (cachedSwipeId) {
            try {
              await db.mutate.updateChatSwipe({ id: cachedSwipeId, swipe: buffer.data, gen_finished: new Date(), timings: buffer.timings })
              Logger.info(`Buffer saved to swipe ID ${cachedSwipeId} (no messages).`)
            } catch (error) {
              Logger.error(`Failed to save buffer to swipe ID ${cachedSwipeId}: ${error instanceof Error ? error.message : String(error)}`)
            }
          } else {
            Logger.error('No messages and no swipe ID provided for saveBufferToLastEntry.')
          }
          return
        }

        const lastIndex = messages.length - 1
        await get().updateChatEntry(lastIndex, buffer.data, { updateFinished: true, verifySwipeId: cachedSwipeId, timings: buffer.timings })
        Logger.info(`Buffer saved to last chat entry at index ${lastIndex}.`)
      },

      loadLastEntryIntoBuffer(): void {
        const messages = get().data?.messages
        if (!messages || messages.length === 0) {
          Logger.warn('No messages to load into buffer.')
          return
        }

        const lastMessage = messages[messages.length - 1]
        const activeSwipe = lastMessage.swipes[lastMessage.swipe_id]

        if (activeSwipe) {
          set((state) => {
            state.buffer.data = activeSwipe.swipe
          })
          Logger.info('Loaded last chat entry content into buffer.')
        } else {
          Logger.warn('No active swipe found for last message; clearing buffer.')
          set((state) => {
            state.buffer.data = ''
          })
        }
      },

      setRegenerationCache(): void {
        const messages = get().data?.messages
        if (!messages || messages.length === 0) {
          Logger.warn('No messages to set regeneration cache for.')
          return
        }

        const lastMessageIndex = messages.length - 1
        const lastMessage = messages[lastMessageIndex]
        const swipe = lastMessage.swipes[lastMessage.swipe_id]
        if (!swipe) {
          Logger.warn('No active swipe to set regen cache.')
          return
        }

        set((state) => {
          if (!state.data) return
          const messagesCopy = [...state.data.messages]
          const editedEntry = { ...messagesCopy[lastMessageIndex], swipes: [...messagesCopy[lastMessageIndex].swipes] }
          const editedSwipe = { ...editedEntry.swipes[editedEntry.swipe_id], regen_cache: swipe.swipe }
          editedEntry.swipes[editedEntry.swipe_id] = editedSwipe
          messagesCopy[lastMessageIndex] = editedEntry
          state.data.messages = messagesCopy
        })
        Logger.info('Regeneration cache set for last entry.')
      },

      getRegenerationCache(): string {
        const messages = get().data?.messages
        if (!messages || messages.length === 0) {
          Logger.warn('No messages for regeneration cache. Returning empty string.')
          return ''
        }
        const lastMessage = messages[messages.length - 1]
        const swipe = lastMessage.swipes[lastMessage.swipe_id]
        if (!swipe) {
          Logger.warn('No active swipe for regen cache. Returning empty string.')
          return ''
        }
        return swipe.regen_cache ?? ''
      },

      resetRegenerationCache(): void {
        const messages = get().data?.messages
        if (!messages || messages.length === 0) {
          Logger.warn('No messages to reset regen cache.')
          return
        }

        const lastMessageIndex = messages.length - 1

        set((state) => {
          if (!state.data) return
          const messagesCopy = [...state.data.messages]
          const editedEntry = { ...messagesCopy[lastMessageIndex], swipes: [...messagesCopy[lastMessageIndex].swipes] }
          const editedSwipe = { ...editedEntry.swipes[editedEntry.swipe_id], regen_cache: '' }
          editedEntry.swipes[editedEntry.swipe_id] = editedSwipe
          messagesCopy[lastMessageIndex] = editedEntry
          state.data.messages = messagesCopy
        })

        Logger.info('Regeneration cache reset for last entry.')
      },
    }))
    
  // --- Database Namespace ---

  export namespace db {
    export namespace query {
      export async function getChatById(chatId: number): Promise<ChatData | undefined> {
        try {
          const chat = await database.query.chats.findFirst({
            where: eq(chats.id, chatId),
            with: {
              messages: {
                orderBy: chatEntries.order,
                with: {
                  swipes: true,
                },
              },
            },
          })
          return chat ? { ...chat, messages: chat.messages ?? [] } : undefined
        } catch (error) {
          Logger.error(`DB Query Error: getChatById(${chatId}): ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      }
      // Other queries like getNewestChatIdForCharacter, getNewestChat, getChatListForCharacter, etc...
    }

    export namespace mutate {
      export async function createEntry(
        chatId: number,
        name: string,
        isUser: boolean,
        order: number,
        message: string
      ): Promise<ChatEntry | undefined> {
        try {
          const inserted = await database.transaction(async (tx) => {
            const newEntry = await tx.insert(chatEntries).values({ chat_id: chatId, name, is_user: isUser, order }).returning()
            if (newEntry.length === 0)
              throw new Error('Failed to insert chat entry.')

            const entry = newEntry[0]

            const newSwipe = await tx.insert(chatSwipes).values({ entry_id: entry.id, swipe: message }).returning()
            if (newSwipe.length === 0)
              throw new Error('Failed to insert chat swipe.')

            return {
              ...entry,
              swipes: [newSwipe[0]],
              swipe_id: 0,
            }
          })

          return inserted
        } catch (e) {
          Logger.error(`DB Mutation Error in createEntry: ${e instanceof Error ? e.message : String(e)}`)
          return undefined
        }
      }
      // Implement other mutation functions following similar patterns: updateChatSwipe, deleteChat, etc...
    }
  }
}

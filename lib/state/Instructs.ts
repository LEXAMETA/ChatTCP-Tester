// lib/state/Instructs.ts

import cloneDeep from 'lodash/cloneDeep'
import { database } from '@db' // Adjust import path as needed
import { Tokenizer } from '@lib/engine/Tokenizer'
import { Storage } from '@lib/enums/Storage'
import { instructs } from 'db/schema'
import { eq } from 'drizzle-orm'
import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  PersistOptions,
} from 'zustand/middleware'

import { Logger } from './Logger'
import { mmkvStorage } from '../storage/MMKV'
import { replaceMacros } from '../utils/Macros'

// --- Types ---

export type InstructType = Omit<typeof instructs.$inferSelect, 'id'> & { id?: number }
export type InstructListItem = { id: number; name: string }
type PersistedInstructState = Pick<InstructState, 'data'>

// Cache for token lengths to avoid repeat tokenization
export type InstructTokenCache = {
  charName: string
  userName: string
  system_prompt_length: number
  system_prefix_length: number
  system_suffix_length: number
  input_prefix_length: number
  input_suffix_length: number
  output_prefix_length: number
  last_output_prefix_length: number
  output_suffix_length: number
  user_alignment_message_length: number
}

export type InstructState = {
  data: InstructType | undefined
  tokenCache: InstructTokenCache | undefined
  loading: boolean // Loading flag for async actions

  loadInstruct: (id: number) => Promise<void>
  setInstructData: (instruct: InstructType) => void
  getTokenCache: (charName: string, userName: string) => InstructTokenCache
  getInstructWithMacrosReplaced: (charName: string, userName: string) => InstructType
}

// --- Defaults & Constants ---

const defaultBooleanFlags = {
  wrap: false,
  macro: false,
  names: false,
  names_force_groups: false,
  timestamp: false,
  examples: true,
  format_type: 0,
  scenario: true,
  personality: true,
}

const predefinedInstructs: InstructType[] = [
  /* your existing predefined instructs as in original file... */
]

// Default instruct fallback
export const defaultInstruct: InstructType = {
  ...predefinedInstructs[0],
  ...defaultBooleanFlags,
}

// --- Internal helpers ---

/**
 * Deep clones an InstructType replacing macros {{char}} and {{user}}.
 * @param rawInstruct The instruct to clone and replace macros in.
 * @param charName Character name string.
 * @param userName User name string.
 * @returns A new InstructType with macros replaced.
 */
function getInstructWithMacrosReplacedInternal(
  rawInstruct: InstructType,
  charName: string,
  userName: string
): InstructType {
  const instruct = cloneDeep(rawInstruct)
  const replacements: Record<string, string> = {
    '{{char}}': charName,
    '{{user}}': userName,
  }

  for (const key of Object.keys(instruct)) {
    const v = (instruct as Record<string, unknown>)[key]
    if (
      typeof v === 'string' &&
      (key.endsWith('_prompt') ||
        key.endsWith('_prefix') ||
        key.endsWith('_suffix') ||
        key === 'stop_sequence' ||
        key === 'user_alignment_message')
    ) {
      let val = v
      for (const macro in replacements) {
        val = val.replaceAll(macro, replacements[macro])
      }
      (instruct as Record<string, unknown>)[key] = val
    }
  }

  return instruct
}

// --- Zustand Store & Persistence ---

export const useInstruct = create<InstructState>()(
  persist<InstructState, PersistedInstructState>(
    (set, get) => ({
      data: predefinedInstructs[0],
      tokenCache: undefined,
      loading: false,

      loadInstruct: async (id: number): Promise<void> => {
        if (get().loading) {
          Logger.warn('Instruct already loading—request ignored.')
          return
        }
        set({ loading: true })
        try {
          const instructData = await db.query.getInstructById(id)
          if (!instructData) {
            Logger.errorToast(`Instruct with ID ${id} not found. Loading default.`)
            set({ data: defaultInstruct, tokenCache: undefined })
          } else {
            set({ data: instructData, tokenCache: undefined })
            Logger.info(`Instruct ID ${id} loaded.`)
          }
        } catch (e) {
          Logger.errorToast(
            `Failed to load instruct ID ${id}: ${e instanceof Error ? e.message : String(e)}`
          )
          set({ data: defaultInstruct, tokenCache: undefined })
        } finally {
          set({ loading: false })
        }
      },

      setInstructData: (instruct: InstructType): void => {
        set({ data: cloneDeep(instruct), tokenCache: undefined })
        Logger.debug('Instruct data updated.')
      },

      getTokenCache: (charName: string, userName: string): InstructTokenCache => {
        const state = get()
        const cache = state.tokenCache
        if (cache && cache.charName === charName && cache.userName === userName) return cache

        if (!state.data) {
          Logger.warn('No instruct data available. Returning empty token cache.')
          return createEmptyTokenCache(charName, userName)
        }

        const instructWithMacros = getInstructWithMacrosReplacedInternal(state.data, charName, userName)
        const tokenizer = Tokenizer.getTokenizer()
        if (!tokenizer) {
          Logger.errorToast('Tokenizer not initialized. Token cache cannot be computed.')
          return createEmptyTokenCache(charName, userName)
        }

        const newCache: InstructTokenCache = {
          charName,
          userName,
          system_prompt_length: tokenizer(instructWithMacros.system_prompt),
          system_prefix_length: tokenizer(instructWithMacros.system_prefix),
          system_suffix_length: tokenizer(instructWithMacros.system_suffix),
          input_prefix_length: tokenizer(instructWithMacros.input_prefix),
          input_suffix_length: tokenizer(instructWithMacros.input_suffix),
          output_prefix_length: tokenizer(instructWithMacros.output_prefix),
          last_output_prefix_length: tokenizer(instructWithMacros.last_output_prefix),
          output_suffix_length: tokenizer(instructWithMacros.output_suffix),
          user_alignment_message_length: tokenizer(instructWithMacros.user_alignment_message),
        }

        set({ tokenCache: newCache })
        Logger.debug(`Token cache recalculated for ${charName} / ${userName}.`)
        return newCache
      },

      getInstructWithMacrosReplaced: (charName: string, userName: string): InstructType => {
        const state = get()
        if (!state.data) {
          Logger.errorToast('No instruct available. Returning default instruct.')
          return defaultInstruct
        }
        return getInstructWithMacrosReplacedInternal(state.data, charName, userName)
      },
    }),
    {
      name: Storage.Instruct,
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ data: state.data }),
      version: 3,
      migrate: async (persistedState: any, version: number): Promise<InstructState> => {
        let state = persistedState ?? { data: defaultInstruct, tokenCache: undefined }
        if (version < 1) {
          state.data.timestamp = state.data.timestamp ?? defaultBooleanFlags.timestamp
          state.data.examples = state.data.examples ?? defaultBooleanFlags.examples
          state.data.format_type = state.data.format_type ?? defaultBooleanFlags.format_type
          Logger.info('Migrated instruct to v1 - added timestamp, examples, format_type defaults.')
        }
        if (version < 2) {
          state.data.last_output_prefix = state.data.output_prefix
          try {
            const allInstructs = await database.query.instructs.findMany({ columns: { id: true, output_prefix: true } })
            for (const inst of allInstructs) {
              await database.update(instructs).set({ last_output_prefix: inst.output_prefix }).where(eq(instructs.id, inst.id))
            }
            Logger.info('Migrated instruct to v2 - last_output_prefix set for all database instructs.')
          } catch (e) {
            Logger.error(`DB migration v2 failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (version < 3) {
          state.data.scenario = state.data.scenario ?? defaultBooleanFlags.scenario
          state.data.personality = state.data.personality ?? defaultBooleanFlags.personality
          Logger.info('Migrated instruct to v3 - added scenario and personality defaults.')
        }
        return state
      },
    } as PersistOptions<InstructState, PersistedInstructState>
  )
)

// --- DB Operations ---

export namespace db {
  export namespace query {
    export async function getInstructById(id: number): Promise<InstructType | undefined> {
      try {
        const instruct = await database.query.instructs.findFirst({ where: eq(instructs.id, id) })
        return instruct || undefined
      } catch (error) {
        Logger.error(`Error fetching instruct by ID ${id}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    export async function getInstructList(): Promise<InstructListItem[] | undefined> {
      try {
        return await database.query.instructs.findMany({ columns: { id: true, name: true } })
      } catch (error) {
        Logger.error(`Error fetching instruct list: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
  }

  export namespace mutate {
    export async function createInstruct(instruct: InstructType): Promise<number | undefined> {
      try {
        const { id, ...insertData } = instruct
        const result = await database.insert(instructs).values(insertData).returning({ newId: instructs.id })
        const newId = result[0]?.newId
        if (!newId) {
          Logger.error('Failed to retrieve new instruct ID on creation.')
          return undefined
        }
        Logger.info(`Created instruct '${instruct.name}' with ID ${newId}.`)
        return newId
      } catch (error) {
        Logger.error(`Error creating instruct '${instruct.name}': ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    export async function updateInstruct(id: number, instruct: Partial<InstructType>): Promise<void> {
      try {
        await database.update(instructs).set(instruct).where(eq(instructs.id, id))
        Logger.info(`Updated instruct ID ${id}.`)
      } catch (error) {
        Logger.error(`Error updating instruct ID ${id}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }

    export async function deleteInstruct(id: number): Promise<void> {
      try {
        await database.delete(instructs).where(eq(instructs.id, id))
        Logger.info(`Deleted instruct ID ${id}.`)
      } catch (error) {
        Logger.error(`Error deleting instruct ID ${id}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
  }
}

// --- Default Data Initialization ---

export async function generateInitialDefaults(): Promise<number> {
  try {
    const existing = await db.query.getInstructList()
    if (!existing) {
      Logger.error('Failed to fetch instruct list for default generation.')
      return 1
    }

    let firstNewId: number | undefined = undefined
    await Promise.all(
      predefinedInstructs.map(async (item) => {
        if (!existing.some((e) => e.name === item.name)) {
          const id = await db.mutate.createInstruct(item)
          if (id !== undefined && firstNewId === undefined) firstNewId = id
        }
      })
    )

    Logger.info('Default instruct generation completed.')
    return firstNewId ?? 1
  } catch (error) {
    Logger.error(`Error generating default instructs: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

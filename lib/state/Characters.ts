// lib/state/Characters.ts

import { db as database } from '@db'
import { Tokenizer } from '@lib/engine/Tokenizer'
import { Storage } from '@lib/enums/Storage'
import { replaceMacros as replaceMacrosUtil } from '@lib/utils/Macros'
import { convertToFormatInstruct } from '@lib/utils/TextFormat'
import {
  characterGreetings,
  characterTags,
  characters,
  chatEntries,
  chatSwipes,
  chats,
  tags,
} from 'db/schema'
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { useLiveQuery } from 'drizzle-orm/expo-sqlite'
import { Asset } from 'expo-asset'
import { randomUUID } from 'expo-crypto'
import * as DocumentPicker from 'expo-document-picker'
import * as FS from 'expo-file-system'
import { useEffect } from 'react'
import { z } from 'zod'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { Logger } from './Logger'
import { AppSettings } from '../constants/GlobalValues'
import { mmkv, mmkvStorage } from '../storage/MMKV'
import { getPngChunkText } from '../utils/PNG'

// --- Types ---

export type CharInfo = {
  name: string
  id: number
  image_id: number
  last_modified: number
  tags: string[]
  latestSwipe?: string
  latestName?: string
  latestChat?: number
}

type CharacterTokenCache = {
  otherName: string
  description_length: number
  examples_length: number
  personality_length: number
  scenario_length: number
}

type CharacterCardState = {
  card?: CharacterCardData
  tokenCache: CharacterTokenCache | undefined
  id: number | undefined
  updateCard: (card: CharacterCardData) => void
  setCard: (id: number) => Promise<string | undefined>
  unloadCard: () => void
  getImage: () => string
  updateImage: (sourceURI: string) => void
  getCache: (otherName: string) => CharacterTokenCache
}

export type CharacterCardData = Awaited<ReturnType<typeof Characters.db.query.cardQuery>>

// --- Zustand Stores ---

export namespace Characters {
  export const useUserCard = create<CharacterCardState>()(
    persist(
      (set, get) => ({
        id: undefined,
        card: undefined,
        tokenCache: undefined,
        setCard: async (id: number) => {
          const card = await database.query.card(id)
          if (card) set((state) => ({ ...state, card, id, tokenCache: undefined }))
          return card?.name
        },
        unloadCard: () =>
          set(() => ({
            id: undefined,
            card: undefined,
            tokenCache: undefined,
          })),
        updateCard: (card: CharacterCardData) => set((state) => ({ ...state, card })),
        getImage: () => getImageDir(get().card?.image_id ?? 0),
        updateImage: async (sourceURI: string) => {
          const id = get().id
          const oldImageID = get().card?.image_id
          const card = get().card
          if (!id || oldImageID === undefined || !card) {
            Logger.errorToast('Could not get data, something very wrong has happened!')
            return
          }
          const imageID = Date.now()
          await database.mutate.updateCardField('image_id', imageID, id)
          await deleteImage(oldImageID)
          await copyImage(sourceURI, imageID)
          card.image_id = imageID
          set((state) => ({ ...state, card }))
        },
        getCache: (otherName: string) => {
          const cache = get().tokenCache
          if (cache && cache.otherName === otherName) return cache

          const card = get().card
          if (!card)
            return {
              otherName,
              description_length: 0,
              examples_length: 0,
              personality_length: 0,
              scenario_length: 0,
            }

          const description = replaceMacrosUtil(card.description ?? '')
          const examples = replaceMacrosUtil(card.mes_example ?? '')
          const personality = replaceMacrosUtil(card.personality ?? '')
          const scenario = replaceMacrosUtil(card.scenario ?? '')

          const getTokenCount = Tokenizer.getTokenizer()

          const newCache: CharacterTokenCache = {
            otherName,
            description_length: getTokenCount(description),
            examples_length: getTokenCount(examples),
            personality_length: getTokenCount(personality),
            scenario_length: getTokenCount(scenario),
          }

          set((state) => ({ ...state, tokenCache: newCache }))
          return newCache
        },
      }),
      {
        name: Storage.UserCard,
        storage: createJSONStorage(() => mmkvStorage),
        version: 2,
        migrate: async (persistedState: any, version) => {
          if (version === 1) {
            Logger.info('Migrating User Store to v2')
            persistedState.id = undefined
            persistedState.card = undefined
          }
          return persistedState
        },
      }
    )
  )

  export const useCharacterCard = create<CharacterCardState>()((set, get) => ({
    id: undefined,
    card: undefined,
    tokenCache: undefined,
    setCard: async (id: number) => {
      const card = await database.query.card(id)
      set((state) => ({ ...state, card, id, tokenCache: undefined }))
      return card?.name
    },
    updateCard: (card: CharacterCardData) => set((state) => ({ ...state, card })),
    unloadCard: () =>
      set(() => ({
        id: undefined,
        card: undefined,
        tokenCache: undefined,
      })),
    getImage: () => getImageDir(get().card?.image_id ?? 0),
    updateImage: async (sourceURI: string) => {
      const id = get().id
      const oldImageID = get().card?.image_id
      const card = get().card
      if (!id || oldImageID === undefined || !card) {
        Logger.errorToast('Could not get data, something very wrong has happened!')
        return
      }
      const imageID = Date.now()
      await database.mutate.updateCardField('image_id', imageID, id)
      await deleteImage(oldImageID)
      await copyImage(sourceURI, imageID)
      card.image_id = imageID
      set((state) => ({ ...state, card }))
    },
    getCache: (charName: string) => {
      const cache = get().tokenCache
      const card = get().card
      if (cache?.otherName && cache.otherName === charName) return cache

      if (!card)
        return {
          otherName: charName,
          description_length: 0,
          examples_length: 0,
          personality_length: 0,
          scenario_length: 0,
        }
      const description = replaceMacrosUtil(card.description ?? '')
      const examples = replaceMacrosUtil(card.mes_example ?? '')
      const personality = replaceMacrosUtil(card.personality ?? '')
      const scenario = replaceMacrosUtil(card.scenario ?? '')

      const getTokenCount = Tokenizer.getTokenizer()

      const newCache = {
        otherName: charName,
        description_length: getTokenCount(description),
        examples_length: getTokenCount(examples),
        personality_length: getTokenCount(personality),
        scenario_length: getTokenCount(scenario),
      }
      set((state) => ({ ...state, tokenCache: newCache }))
      return newCache
    },
  }))

  // --- DB Namespaces ---

  export namespace db {
    export namespace query {
      export const cardQuery = (charId: number) =>
        database.query.characters.findFirst({
          where: eq(characters.id, charId),
          with: {
            tags: { columns: { character_id: false }, with: { tag: true } },
            alternate_greetings: true,
          },
        })

      export const card = async (charId: number): Promise<CharacterCardData | undefined> => {
        return await cardQuery(charId)
      }

      // Additional queries, cardList, cardExists, etc. can be added here as needed
    }

    export namespace mutate {
      export const createChat = async (charId: number) => {
        const card = await query.card(charId)
        if (!card) {
          Logger.error('Character does not exist!')
          return
        }
        const userId = Characters.useUserCard.getState().id
        const charName = card.name
        return await database.transaction(async (tx) => {
          if (!card || !charName) return
          const [{ chatId }] = await tx
            .insert(chats)
            .values({
              character_id: charId,
              user_id: userId ?? null,
            })
            .returning({ chatId: chats.id })

          if (!mmkv.getBoolean(AppSettings.CreateFirstMes)) return chatId

          const [{ entryId }] = await tx
            .insert(chatEntries)
            .values({
              chat_id: chatId,
              is_user: false,
              name: card.name ?? '',
              order: 0,
            })
            .returning({ entryId: chatEntries.id })

          await tx.insert(chatSwipes).values({
            entry_id: entryId,
            swipe: convertToFormatInstruct(replaceMacrosUtil(card.first_mes ?? '')) || '',
          })

          if (Array.isArray(card?.alternate_greetings)) {
            for (const data of card.alternate_greetings) {
              await tx.insert(chatSwipes).values({
                entry_id: entryId,
                swipe: convertToFormatInstruct(replaceMacrosUtil(data.greeting ?? '')) || '',
              })
            }
          }
          await updateModified(charId)
          return chatId
        })
      }

      export const updateCard = async (card: CharacterCardData, cardID: number) => {
        if (!card) return
        try {
          await database
            .update(characters)
            .set({
              description: card.description,
              first_mes: card.first_mes,
              name: card.name,
              personality: card.personality,
              scenario: card.scenario,
              mes_example: card.mes_example,
            })
            .where(eq(characters.id, cardID))
          await Promise.all(
            card.alternate_greetings.map(async (item) => {
              await database
                .update(characterGreetings)
                .set({ greeting: item.greeting })
                .where(eq(characterGreetings.id, item.id))
            })
          )
          if (card.tags) {
            const newTags = card.tags
              .filter((item) => item.tag_id === -1)
              .map((tag) => ({ tag: tag.tag.tag }))

            const currentTagIDs = card.tags
              .filter((item) => item.tag_id !== -1)
              .map((item) => ({
                character_id: card.id,
                tag_id: item.tag.id,
              }))
            const newTagIDs: (typeof characterTags.$inferSelect)[] = []

            if (newTags.length !== 0) {
              await database
                .insert(tags)
                .values(newTags)
                .onConflictDoNothing()
                .returning({ id: tags.id })
                .then((result) => {
                  newTagIDs.push(
                    ...result.map((item) => ({
                      character_id: card.id,
                      tag_id: item.id,
                    }))
                  )
                })
            }

            const mergedTags = [...currentTagIDs, ...newTagIDs]
            if (mergedTags.length !== 0)
              await database
                .insert(characterTags)
                .values(mergedTags)
                .onConflictDoNothing()

            const ids = mergedTags.map((item) => item.tag_id)
            await database
              .delete(characterTags)
              .where(and(notInArray(characterTags.tag_id, ids), eq(characterTags.character_id, card.id)))
            await database.delete(tags).where(notInArray(tags.id, database.select({ tag_id: characterTags.tag_id }).from(characterTags)))
          }
        } catch (e) {
          Logger.warn(`${e}`)
        }
      }

      // Other mutation methods like addAltGreeting, deleteAltGreeting, deleteCard, etc. can be added here following your original structure
    }
  }

  // --- Utility functions ---

  export const getImageDir = (imageId: number) => `${FS.documentDirectory}characters/${imageId}.png`

  export const copyImage = async (uri: string, imageID: number) => {
    await FS.copyAsync({
      from: uri,
      to: getImageDir(imageID),
    })
  }

  export const deleteImage = async (imageID: number) => {
    await FS.deleteAsync(getImageDir(imageID), { idempotent: true })
  }

  // ... Additional utils / import functions like createCharacterFromImage, importCharacter, etc. go here

  // --- Macro Replacement ---

  export const replaceMacros = (text: string) => {
    if (text === undefined) return ''
    let newtext = text
    const charName = Characters.useCharacterCard.getState().card?.name ?? ''
    const userName = Characters.useUserCard.getState().card?.name ?? ''
    const time = new Date()
    const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    const rules = [
      { macro: '{{user}}', value: userName },
      { macro: '{{char}}', value: charName },
      { macro: '{{time}}', value: time.toLocaleTimeString() },
      { macro: '{{date}}', value: time.toLocaleDateString() },
      { macro: '{{day}}', value: weekday[time.getDay()] },
    ]
    for (const rule of rules) newtext = newtext.replaceAll(rule.macro, rule.value)
    return newtext
  }

  // --- Zod schemas / type guards for input validation ---

  const characterCardV1Schema = z.object({
    name: z.string(),
    description: z.string(),
    personality: z.string().catch(''),
    scenario: z.string().catch(''),
    first_mes: z.string().catch(''),
    mes_example: z.string().catch(''),
  })

  const characterCardV2DataSchema = z.object({
    name: z.string(),
    description: z.string().catch(''),
    personality: z.string().catch(''),
    scenario: z.string().catch(''),
    first_mes: z.string().catch(''),
    mes_example: z.string().catch(''),
    creator_notes: z.string().catch(''),
    system_prompt: z.string().catch(''),
    post_history_instructions: z.string().catch(''),
    creator: z.string().catch(''),
    character_version: z.string().catch(''),
    alternate_greetings: z.string().array().catch([]),
    tags: z.string().array().catch([]),
  })

  const characterCardV2Schema = z.object({
    spec: z.literal('chara_card_v2'),
    spec_version: z.literal('2.0'),
    data: characterCardV2DataSchema,
  })

  type CharacterCardV1 = z.infer<typeof characterCardV1Schema>
  type CharacterCardV2Data = z.infer<typeof characterCardV2DataSchema>
  type CharacterCardV2 = z.infer<typeof characterCardV2Schema>

  const createBlankV2Card = (
    name: string,
    options: {
      description: string
      personality: string
      scenario: string
      first_mes: string
      mes_example: string
    } = { description: '', personality: '', scenario: '', first_mes: '', mes_example: '' }
  ): CharacterCardV2 => {
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name,
        description: options.description,
        personality: options.personality,
        scenario: options.scenario,
        first_mes: options.first_mes,
        mes_example: options.mes_example,
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
      },
    }
  }
}

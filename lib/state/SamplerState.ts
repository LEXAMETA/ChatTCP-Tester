// lib/state/SamplerState.ts
import {
  defaultSamplerConfig,
  SamplerConfigData,
  SamplerID,
  Samplers,
} from '@lib/constants/SamplerData'
import { Storage } from '@lib/enums/Storage'
import { Logger } from '@lib/state/Logger'
import { mmkvStorage } from '@lib/storage/MMKV'
import { getDocumentAsync } from 'expo-document-picker'
import { EncodingType, readAsStringAsync } from 'expo-file-system'
import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  PersistOptions,
} from 'zustand/middleware'

/**
 * Represents a single sampler configuration with a name and its associated data.
 */
export type SamplerConfig = {
  name: string
  data: SamplerConfigData
}

/**
 * Defines the entire state structure for the SamplerState Zustand store.
 */
export type SamplerStateProps = {
  currentConfigIndex: number
  configList: SamplerConfig[]

  /**
   * Updates the currently active sampler configuration.
   * @param config The new sampler config to set as current
   */
  updateCurrentConfig: (config: SamplerConfig) => void

  /**
   * Adds a new sampler configuration to the list.
   * Ignores addition if name already exists.
   * @param config The sampler config to add
   */
  addSamplerConfig: (config: SamplerConfig) => void

  /**
   * Deletes a sampler config by index, and updates currentConfigIndex accordingly.
   * @param index The index of the config to delete.
   */
  deleteSamplerConfig: (index: number) => void

  /**
   * Sets the active config by index, with bounds safety.
   * @param index The index to set as current
   */
  setConfig: (index: number) => void

  /**
   * Runs fixSamplerConfig on all configs to ensure defaults and type safety.
   */
  fixConfigs: () => void
}

type PersistedSamplerState = Pick<
  SamplerStateProps,
  'configList' | 'currentConfigIndex'
>

/**
 * Helper function to validate a config index against current store.
 * @param index Index to check
 * @param maxLength Max valid length (length of config list)
 * @returns True if valid index, otherwise false
 */
function isValidIndex(index: number, maxLength: number): boolean {
  return index >= 0 && index < maxLength
}

/**
 * Main Zustand store for managing sampler configs with persistence.
 */
export const useSamplerState = create<SamplerStateProps>()(
  persist<SamplerStateProps, PersistedSamplerState>(
    (set, get) => ({
      currentConfigIndex: 0,
      configList: [{ name: 'Default', data: defaultSamplerConfig }],

      addSamplerConfig: (config: SamplerConfig): void => {
        const { configList } = get()
        if (configList.some((c) => c.name === config.name)) {
          Logger.errorToast(
            `Sampler Config "${config.name}" already exists! Please choose a unique name.`
          )
          return
        }

        const fixedData = fixSamplerConfig(config.data)
        const newConfig: SamplerConfig = { ...config, data: fixedData }

        set({
          configList: [...configList, newConfig],
          currentConfigIndex: configList.length,
        })

        Logger.info(`Sampler Config "${config.name}" added successfully.`)
      },

      deleteSamplerConfig: (index: number): void => {
        const { configList, currentConfigIndex } = get()
        if (!isValidIndex(index, configList.length)) {
          Logger.warn(`Attempt to delete config at invalid index: ${index}.`)
          return
        }

        const newList = configList.filter((_, i) => i !== index)
        let newIndex = currentConfigIndex

        if (newList.length === 0) {
          Logger.warn('All sampler configs deleted. Resetting to default config.')
          set({
            configList: [{ name: 'Default', data: defaultSamplerConfig }],
            currentConfigIndex: 0,
          })
          return
        }

        if (index === currentConfigIndex) {
          newIndex = 0
        } else if (index < currentConfigIndex) {
          newIndex = Math.max(0, currentConfigIndex - 1)
        }

        set({
          configList: newList,
          currentConfigIndex: newIndex,
        })

        Logger.info(`Sampler Config at index ${index} deleted.`)
      },

      setConfig: (index: number): void => {
        const { configList } = get()
        if (!isValidIndex(index, configList.length)) {
          Logger.warn(
            `Attempted to set config index out of bounds: ${index}. Config count: ${configList.length}.`
          )
          return
        }
        set({ currentConfigIndex: index })
        Logger.debug(`Current sampler config set to index: ${index}.`)
      },

      updateCurrentConfig: (config: SamplerConfig): void => {
        const { configList, currentConfigIndex } = get()
        if (!isValidIndex(currentConfigIndex, configList.length)) {
          Logger.errorToast(
            `Cannot update current config: Invalid currentConfigIndex (${currentConfigIndex}).`
          )
          return
        }
        const fixedData = fixSamplerConfig(config.data)
        const newConfigs = [...configList]
        newConfigs[currentConfigIndex] = { ...config, data: fixedData }

        set({ configList: newConfigs })
        Logger.info(`Current sampler config (index ${currentConfigIndex}) updated.`)
      },

      fixConfigs: (): void => {
        const { configList } = get()
        const fixedList = configList.map((item) => ({
          name: item.name,
          data: fixSamplerConfig(item.data),
        }))
        set({ configList: fixedList })
        Logger.info('All sampler configs checked and fixed for missing fields.')
      },
    }),
    {
      name: Storage.Samplers,
      storage: createJSONStorage(() => mmkvStorage),
      version: 1,
      partialize: (state: SamplerStateProps): PersistedSamplerState => ({
        configList: state.configList,
        currentConfigIndex: state.currentConfigIndex,
      }),
      migrate: async (persistedState: unknown, version: number): Promise<void> => {
        // Placeholder for migrations when needed
        // e.g., adjust persistedState shape on version update
      },
    } as PersistOptions<SamplerStateProps, PersistedSamplerState>
  )
)

/**
 * Selectors and helpers for components.
 */
export const useSamplers = () => {
  const { configList, currentConfigIndex } = useSamplerState((state) => ({
    configList: state.configList,
    currentConfigIndex: state.currentConfigIndex,
  }))

  const {
    addSamplerConfig,
    deleteSamplerConfig,
    setConfig,
    updateCurrentConfig,
  } = useSamplerState((state) => ({
    addSamplerConfig: state.addSamplerConfig,
    deleteSamplerConfig: state.deleteSamplerConfig,
    setConfig: state.setConfig,
    updateCurrentConfig: state.updateCurrentConfig,
  }))

  // Defensive currentConfig calculation fallback
  const currentConfig =
    configList[currentConfigIndex] || configList[0] || { name: 'Default', data: defaultSamplerConfig }

  if (!currentConfig) {
    Logger.error('useSamplers: currentConfig is undefined, fallback to default.')
  }

  return {
    currentConfigIndex,
    currentConfig,
    configList,
    addSamplerConfig,
    deleteSamplerConfig,
    setConfig,
    updateCurrentConfig,
  }
}

/**
 * Return current sampler config data directly (non-hook usage).
 */
export const getCurrentSampler = (): SamplerConfigData => {
  const state = useSamplerState.getState()
  return state.configList[state.currentConfigIndex]?.data || defaultSamplerConfig
}

/**
 * Import a sampler config JSON or .settings file using the document picker.
 * Parses and fixes the config before returning.
 * @returns The parsed and fixed SamplerConfig or undefined on failure or cancel.
 */
export const importConfigFile = async (): Promise<SamplerConfig | undefined> => {
  try {
    const result = await getDocumentAsync({
      type: ['application/json', 'application/octet-stream'],
      copyToCacheDirectory: true,
    })

    if (result.canceled || !result.assets?.[0]) {
      Logger.info('File import cancelled or no file selected.')
      return undefined
    }

    const asset = result.assets[0]

    if (!asset.name.endsWith('.json') && !asset.name.endsWith('.settings')) {
      Logger.errorToast('Invalid File Type! Please select a .json or .settings file.')
      return undefined
    }

    const name = asset.name
      .replace('.json', '')
      .replace('.settings', '')
      .replace(/ /g, '_')

    let dataStr: string
    try {
      dataStr = await readAsStringAsync(asset.uri, { encoding: EncodingType.UTF8 })
    } catch (fileReadError) {
      Logger.errorToast(`Failed to read file content: ${fileReadError instanceof Error ? fileReadError.message : String(fileReadError)}`)
      return undefined
    }

    let parsed: SamplerConfigData
    try {
      parsed = JSON.parse(dataStr) as SamplerConfigData
    } catch (jsonError) {
      Logger.errorToast(`Failed to parse JSON: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`)
      return undefined
    }

    const fixedData = fixSamplerConfig(parsed)

    Logger.info(`Configuration file "${asset.name}" imported successfully.`)
    return { name, data: fixedData }
  } catch (e) {
    Logger.errorToast(`Failed to import configuration: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/**
 * Ensures a SamplerConfigData object includes all keys defined in SamplerID,
 * fills missing keys with defaults and coerces SEED string to number if needed.
 * @param config The input config
 * @returns The fixed config without mutation of original
 */
export const fixSamplerConfig = (config: SamplerConfigData): SamplerConfigData => {
  // Shallow clone to avoid mutation
  const fixedConfig: SamplerConfigData = { ...config }
  const keys = Object.values(SamplerID) as SamplerID[]
  let fixedAny = false

  for (const key of keys) {
    if (fixedConfig[key] === undefined) {
      fixedConfig[key] = Samplers[key].values.default
      fixedAny = true
      Logger.debug(`Sampler Config: Added missing key "${key}" with default`)
    } else if (key === SamplerID.SEED && typeof fixedConfig[key] === 'string') {
      // Attempt to coerce SEED from string to number
      const parsed = parseInt(fixedConfig[key] as string, 10)
      if (!Number.isNaN(parsed)) {
        fixedConfig[key] = parsed
      } else {
        fixedConfig[key] = Samplers[key].values.default
        Logger.warn(`Sampler Config: SEED string "${fixedConfig[key]}" invalid, reset to default`)
      }
    }
  }

  if (fixedAny) {
    Logger.warn('Sampler Config had missing fields fixed with defaults')
  }

  return fixedConfig
}

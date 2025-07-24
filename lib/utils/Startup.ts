// lib/utils/Startup.ts
import { Model } from '@lib/engine/Local/Model'
import { useAppModeState } from '@lib/state/AppMode'
import { Instructs } from '@lib/state/Instructs'
import { SamplersManager } from '@lib/state/SamplerState'
import { useTTSState } from '@lib/state/TTS'
import { getCpuFeatures } from 'cui-llama.rn'
import { DeviceType, getDeviceTypeAsync } from 'expo-device'
import {
    deleteAsync,
    documentDirectory,
    makeDirectoryAsync,
    readAsStringAsync,
    readDirectoryAsync,
} from 'expo-file-system'
import { router } from 'expo-router'
import { setBackgroundColorAsync } from 'expo-system-ui'
import { z } from 'zod'

import { AppDirectory } from './File'
import { lockScreenOrientation } from './Screen'
import { AppSettings, AppSettingsDefault, Global } from '../constants/GlobalValues'
import { useLlama } from '../engine/Local/LlamaLocal' // useLlama for state management
import { Characters } from '../state/Characters'
import { Chats } from '../state/Chat'
import { useEngineData } from '../state/EngineData'
import { Logger } from '../state/Logger'
import { mmkv } from '../storage/MMKV'
import { Theme } from '../theme/ThemeManager'

/**
 * Attempts to load the newest chat on application initialization if enabled in settings.
 * Navigates to the ChatMenu screen if a chat is successfully loaded.
 */
export const loadChatOnInit = async (): Promise<void> => {
    try {
        if (!mmkv.getBoolean(AppSettings.ChatOnStartup)) {
            Logger?.info('Chat on startup is disabled.')
            return
        }

        const newestChat = await Chats.db.query.chatNewest()
        if (!newestChat) {
            Logger?.info('No newest chat found to load on startup.')
            return
        }

        await Characters.useCharacterCard.getState().setCard(newestChat.character_id)
        await Chats.useChatState.getState().load(newestChat.id)
        router.push('/screens/ChatMenu')
        Logger?.info(`Loaded chat ID ${newestChat.id} on startup and navigated to ChatMenu.`)
    } catch (error) {
        // Explicitly cast error to Error type for message property
        Logger.error('Failed to load chat on init: ' + (error as Error).message)
        console.error('Failed to load chat on init:', error) // Keep console.error for immediate visibility
    }
}

/**
 * Sets default application settings in MMKV storage if they are not already defined.
 * Special handling for 'UnlockOrientation' based on device type.
 */
const setAppDefaultSettings = (): void => {
    Object.keys(AppSettingsDefault).forEach((item) => {
        try {
            // Check if the setting already exists in MMKV
            // mmkv.getBoolean returns undefined if key does not exist
            if (mmkv.getBoolean(item) !== undefined) {
                Logger?.info(`Setting '${item}' already exists, skipping default.`)
                return // Setting already exists, do not overwrite
            }

            // Special handling for 'UnlockOrientation'
            if (item === AppSettings.UnlockOrientation) {
                getDeviceTypeAsync()
                    .then((result) => {
                        mmkv.set(item, result === DeviceType.TABLET)
                        Logger?.info(`Set default UnlockOrientation to ${result === DeviceType.TABLET} for device type ${DeviceType[result]}.`)
                    })
                    .catch((err) => {
                        Logger.error('Failed to get device type for UnlockOrientation setting: ' + (err as Error).message)
                        console.error('Failed to get device type:', err)
                    })
            } else {
                // Set default value for other settings
                mmkv.set(item, AppSettingsDefault[item as AppSettings])
                Logger?.info(`Set default setting for '${item}': ${AppSettingsDefault[item as AppSettings]}.`)
            }
        } catch (error) {
            Logger.error(`Error setting default app setting for '${item}': ` + (error as Error).message)
            console.error(`Error setting default app setting for '${item}':`, error)
        }
    })
}

/**
 * Creates a default character card if no character cards exist and the setting allows it.
 */
const createDefaultCard = async (): Promise<void> => {
    try {
        if (!mmkv.getBoolean(AppSettings.CreateDefaultCard)) {
            Logger?.info('Creation of default card is disabled by settings.')
            return
        }

        const existingCards = await Characters.db.query.cardList('character')
        if (existingCards.length === 0) {
            Logger?.warn('No existing character cards found, creating default card.')
            await Characters.createDefaultCard()
            Logger?.info('Default character card created.')
        } else {
            Logger?.info('Existing character cards found, skipping default card creation.')
        }
        // Disable this setting after checking/creating to prevent re-creation on subsequent startups
        mmkv.set(AppSettings.CreateDefaultCard, false)
        Logger?.info('AppSettings.CreateDefaultCard set to false.')
    } catch (error) {
        Logger.error('Failed to create default card: ' + (error as Error).message)
        console.error('Failed to create default card:', error)
    }
}

/**
 * Retrieves and stores CPU features (e.g., fp16, i8mm, dotprod support) in MMKV.
 */
const setCPUFeatures = async (): Promise<void> => {
    try {
        if (mmkv.getString(Global.CpuFeatures)) {
            Logger?.info('CPU features already set in storage.')
            return
        }
        const features = getCpuFeatures()
        mmkv.set(Global.CpuFeatures, JSON.stringify(features))
        Logger?.info('CPU features detected and stored.')
    } catch (error) {
        Logger.error('Failed to set CPU features: ' + (error as Error).message)
        console.error('Failed to set CPU features:', error)
    }
}

/**
 * Migration logic for model data from version 0.7.10 to 0.8.0.
 * Attempts to parse old model data; if parsing fails, the old key is deleted.
 */
const migrateModelData_0_7_10_to_0_8_0 = (): void => {
    const oldDef = `localmodel`
    try {
        const modelRaw = mmkv.getString(oldDef)
        if (modelRaw) {
            JSON.parse(modelRaw) // Attempt to parse
            Logger?.info('Old model data (0.7.10) parsed successfully, no reset needed.')
        } else {
            Logger?.info('No old model data (0.7.10) found for parsing check.')
        }
    } catch {
        Logger.warn('Old model data (0.7.10) could not be parsed, resetting by deleting key.')
        mmkv.delete(oldDef) // Delete the invalid data
    }
}

/**
 * Migration logic for model data from version 0.8.4 to 0.8.5.
 * Moves 'localmodel' data to the new 'useEngineData' state.
 */
const migrateModelData_0_8_4_to_0_8_5 = (): void => {
    const oldDef = `localmodel`
    try {
        const modelData = mmkv.getString(oldDef)
        if (!modelData) {
            Logger?.info('No old model data (0.8.4) found for migration.')
            return
        }
        const data = JSON.parse(modelData)
        if (!data) {
            Logger.warn('Parsed model data (0.8.4) was null or undefined, skipping migration.')
            return
        }
        mmkv.delete(oldDef)
        useEngineData.getState().setLastModelLoaded(data)
        Logger?.info('Migrated model data from 0.8.4 to 0.8.5 successfully.')
    } catch (error) {
        Logger.error('Failed migrating model data from 0.8.4 to 0.8.5: ' + (error as Error).message)
        console.error('Failed migrating model data:', error)
    }
}

/**
 * Migration logic for TTS (Text-to-Speech) data from version 0.8.5 to 0.8.6.
 * Migrates old boolean flags and speaker data to the new TTS state.
 */
const migrateTTSData_0_8_5_to_0_8_6 = (): void => {
    try {
        // Migrate 'ttsauto' setting
        if (mmkv.getBoolean('ttsauto')) {
            mmkv.delete('ttsauto')
            useTTSState.getState().setAuto(true)
            Logger?.info('Migrated ttsauto setting.')
        } else {
            Logger?.info('No old ttsauto setting found or already migrated.')
        }
        // Migrate 'ttsenable' setting
        if (mmkv.getBoolean('ttsenable')) {
            mmkv.delete('ttsenable')
            useTTSState.getState().setEnabled(true)
            Logger?.info('Migrated ttsenable setting.')
        } else {
            Logger?.info('No old ttsenable setting found or already migrated.')
        }

        // Migrate 'ttsspeaker' data
        const speakerData = mmkv.getString('ttsspeaker')
        if (!speakerData) {
            Logger?.info('No old TTS speaker data found for migration.')
            return
        }

        mmkv.delete('ttsspeaker')
        try {
            const voiceData = JSON.parse(speakerData)
            const voiceSchema = z.object({
                identifier: z.string(),
                name: z.string(),
                quality: z.enum(['Default', 'Enhanced']),
                language: z.string(),
            })
            const result = voiceSchema.safeParse(voiceData)
            if (result.success) {
                useTTSState.getState().setVoice(voiceData)
                Logger?.info('Migrated TTS speaker data successfully.')
            } else {
                throw new Error('Schema validation failed for TTS speaker data.')
            }
        } catch (innerError) {
            Logger.error('Failed to parse or validate TTS speaker data from 0.8.5 to 0.8.6: ' + (innerError as Error).message)
            console.error('Failed to parse or validate TTS speaker data:', innerError)
        }
    } catch (error) {
        Logger.error('Failed migrating TTS data from 0.8.5 to 0.8.6: ' + (error as Error).message)
        console.error('Failed migrating TTS data:', error)
    }
}

/**
 * Generates default application directories if they don't already exist.
 * Uses `Promise.all` for efficient concurrent directory creation.
 */
export const generateDefaultDirectories = async (): Promise<void> => {
    // Ensure documentDirectory is not null before proceeding, crucial for file operations.
    if (!documentDirectory) {
        Logger.error('FileSystem.documentDirectory is null or undefined. Cannot generate directories.');
        console.error('FileSystem.documentDirectory is null or undefined.');
        return;
    }

    await Promise.all(
        Object.values(AppDirectory).map(async (dir) => {
            try {
                await makeDirectoryAsync(dir)
                Logger.info(
                    `Successfully made directory: ${dir.replace(documentDirectory!, '')}` // Use non-null assertion here, as checked above
                )
            } catch (error) {
                // Check if the error is specifically due to the directory already existing
                const errorMessage = (error as Error).message;
                if (!errorMessage.includes('directory already exists')) {
                    Logger.warn(`Failed to make directory ${dir.replace(documentDirectory!, '')}: ${errorMessage}`);
                    console.warn(`Failed to make directory ${dir}:`, error);
                } else {
                    Logger?.info(`Directory '${dir.replace(documentDirectory!, '')}' already exists, skipping creation.`)
                }
            }
        })
    )
    Logger?.info('Default directories generation complete.')
}

/**
 * Migration logic for sampler presets from version 0.8.3 to 0.8.4.
 * Reads old preset files, adds them to the new SamplersManager state, and deletes the old directory.
 */
const migratePresets_0_8_3_to_0_8_4 = async (): Promise<void> => {
    // Ensure documentDirectory is not null
    if (!documentDirectory) {
        Logger.error('FileSystem.documentDirectory is null or undefined. Cannot migrate presets.');
        console.error('FileSystem.documentDirectory is null or undefined.');
        return;
    }
    const presetDir = `${documentDirectory}presets`
    try {
        // Check if the directory exists before attempting to read it
        const dirInfo = await FileSystem.getInfoAsync(presetDir);
        if (!dirInfo.exists || !dirInfo.isDirectory) {
            Logger?.info(`Old preset directory '${presetDir.replace(documentDirectory, '')}' does not exist, skipping migration.`)
            return;
        }

        const files = await readDirectoryAsync(presetDir)
        if (files.length === 0) {
            Logger?.info('No old preset files found for migration.')
            await deleteAsync(presetDir, { idempotent: true }); // Delete empty directory if it exists
            return
        }

        await Promise.all(
            files.map(async (item) => {
                try {
                    const dataStr = await readAsStringAsync(`${presetDir}/${item}`)
                    SamplersManager.useSamplerState.getState().addSamplerConfig({
                        data: JSON.parse(dataStr),
                        name: item.replace('.json', ''),
                    })
                    Logger?.info(`Migrated preset: ${item}`)
                } catch (innerError) {
                    Logger.error(
                        `Failed to migrate preset ${item}: ${(innerError as Error).message}`
                    )
                    console.error(`Failed to migrate preset ${item}:`, innerError)
                }
            })
        )
        // Use idempotent: true to prevent errors if the directory is already deleted by other means
        await deleteAsync(presetDir, { idempotent: true })
        Logger?.info('Migrated presets from 0.8.3 to 0.8.4 and deleted old directory.')
    } catch (error) {
        // Catch block for readDirectoryAsync or deleteAsync errors
        Logger.error('Failed to migrate presets from 0.8.3 to 0.8.4: ' + (error as Error).message)
        console.error('Failed to migrate presets:', error)
    }
}

/**
 * Migration logic for application mode from version 0.8.5 to 0.8.6.
 * Moves old 'appmode' string to the new `useAppModeState`.
 */
const migrateAppMode_0_8_5_to_0_8_6 = (): void => {
    try {
        const oldKey = 'appmode'
        const oldAppMode = mmkv.getString(oldKey)
        if (!oldAppMode) {
            Logger?.info('No old app mode data found for migration.')
            return
        }

        if (oldAppMode === 'local' || oldAppMode === 'remote') {
            useAppModeState.getState().setAppMode(oldAppMode)
            Logger.warn(`Migrated app mode from 0.8.5 to 0.8.6: Set to '${oldAppMode}'.`)
        } else {
            Logger.warn(`Old app mode value "${oldAppMode}" was unrecognized; skipping migration.`)
        }
        mmkv.delete(oldKey) // Always delete the old key after attempt
        Logger?.info(`Old app mode key '${oldKey}' deleted from MMKV.`)
    } catch (error) {
        Logger.error('Failed migrating app mode from 0.8.5 to 0.8.6: ' + (error as Error).message)
        console.error('Failed migrating app mode:', error)
    }
}

/**
 * Creates a default user character card if none exist.
 */
const createDefaultUserData = async (): Promise<void> => {
    try {
        const id = await Characters.db.mutate.createCard('User', 'user')
        Characters.useUserCard.getState().setCard(id)
        Logger?.info('Default user card created with ID: ' + id)
    } catch (error) {
        Logger.error('Failed creating default user data: ' + (error as Error).message)
        console.error('Failed creating default user data:', error)
    }
}

/**
 * Sets the default character (user) for the application. Creates one if no users exist.
 */
const setDefaultCharacter = async (): Promise<void> => {
    try {
        const userList = await Characters.db.query.cardList('user')
        if (!userList) {
            Logger.error('User database query returned invalid list (null/undefined). This should not happen! Please report this occurrence.')
            console.error('User database query returned invalid list:', userList)
            return
        }

        if (userList.length === 0) {
            Logger.warn('No Users exist, creating default User character.')
            await createDefaultUserData()
        } else if (userList.length > 0 && !Characters.useUserCard.getState().card) {
            // Ensure we only set if there's no current user card loaded
            // Using userList[0]! is safe here because userList.length > 0
            Characters.useUserCard.getState().setCard(userList[0].id)
            Logger?.info(`Set default user character to ID: ${userList[0].id}.`)
        } else {
            Logger?.info('Default user character already exists or is set.')
        }
    } catch (error) {
        Logger.error('Failed to set default character: ' + (error as Error).message)
        console.error('Failed to set default character:', error)
    }
}

/**
 * Sets the default instruct (prompt) for the application. Creates one if no instructs exist.
 */
const setDefaultInstruct = (): void => {
    Instructs.db.query
        .instructList()
        .then(async (list) => {
            if (!list) {
                Logger.error('Instruct database query returned invalid list (null/undefined). This should not happen! Please report this!')
                console.error('Instruct database query returned invalid list:', list)
                return
            }
            if (list.length === 0) {
                Logger.warn('No Instructs exist, creating default Instruct.')
                const id = await Instructs.generateInitialDefaults()
                Instructs.useInstruct.getState().load(id)
                Logger?.info(`Created and loaded default instruct with ID: ${id}.`)
            } else {
                Logger?.info('Default instructs already exist.')
            }
        })
        .catch((error) => {
            Logger.error('Failed loading default instructs: ' + (error as Error).message)
            console.error('Failed loading default instructs:', error)
        })
}

/**
 * Main application startup function. Orchestrates all initialization tasks.
 * Should be called once when the application starts.
 */
export const startupApp = (): void => {
    console.log('[APP STARTED]: T1APT') // Initial log for app start

    // --- Core Initialization & Settings ---
    setAppDefaultSettings()

    // Directories are crucial, run this early and ensure completion
    // Using .then().catch() to log completion/failure of this async step
    generateDefaultDirectories().then(() => {
        Logger?.info('Application directories ensured.')
    }).catch(err => {
        Logger.error('Failed to generate default directories during startup: ' + (err as Error).message);
        console.error('Failed to generate default directories:', err);
    });

    setDefaultCharacter() // Ensure a user character exists
    setDefaultInstruct()   // Ensure default instructs are available

    // Initialize the default card (if setting enabled)
    createDefaultCard()

    // Get CPU features for optimization
    setCPUFeatures()

    // Verify local model list
    Model.verifyModelList()

    // --- Data Migrations (Order is important if dependencies exist) ---
    Logger?.info('Initiating data migrations...')
    migrateModelData_0_7_10_to_0_8_0()
    migrateModelData_0_8_4_to_0_8_5()
    migratePresets_0_8_3_to_0_8_4()
    migrateTTSData_0_8_5_to_0_8_6()
    migrateAppMode_0_8_5_to_0_8_6()
    Logger?.info('Data migrations routine complete.')


    // --- UI/System Settings ---
    lockScreenOrientation()
    setBackgroundColorAsync(Theme.useColorState.getState().color.neutral._100).catch((error) => {
        Logger.warn('Failed to set background color on startup: ' + (error as Error).message)
        console.warn('Failed to set background color:', error)
    })

    Logger.info('Application startup routine complete.')
}


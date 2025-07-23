// lib/utils/File.ts
import { localDownload } from '@vali98/react-native-fs' // For platform-specific downloads
import * as DocumentPicker from 'expo-document-picker' // Document picker
import * as FileSystem from 'expo-file-system' // File system access
import { Platform } from 'react-native'

import { Logger } from '../state/Logger'

/**
 * App-specific directories inside documentDirectory to organize files.
 */
export const AppDirectory = {
  ModelPath: `${FileSystem.documentDirectory}models/`,
  SessionPath: `${FileSystem.documentDirectory}session/`,
  CharacterPath: `${FileSystem.documentDirectory}characters/`,
  Assets: `${FileSystem.documentDirectory}appAssets/`,
}

/**
 * Represents a picked file's basic info.
 */
export interface PickedFileInfo {
  uri: string
  name: string
  mimeType: string | null
  size: number | null
}

/**
 * Opens document picker for single file.
 * @param type MIME types or wildcards (e.g. 'image/*', ['application/json'])
 * @param copyToCacheDirectory Copy picked file into Expo cache (default: true)
 * @returns Picked file info or null if cancelled/error
 */
export async function pickFile(
  type: string | string[] = '*/*',
  copyToCacheDirectory = true
): Promise<PickedFileInfo | null> {
  try {
    const result = await DocumentPicker.getDocumentAsync({ type, copyToCacheDirectory })

    if (result.canceled) {
      Logger?.info('File picking cancelled by user.')
      console.log('File picking cancelled by user.')
      return null
    }

    if (Array.isArray(result.assets) && result.assets.length > 0) {
      const asset = result.assets[0]
      if (!asset) {
        Logger?.warn('No asset found in document picker result array (unexpected).')
        console.warn('No asset found in document picker result array (unexpected).')
        return null
      }
      return {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? null,
        size: asset.size ?? null,
      }
    } else {
      Logger?.info('File picking completed, but no file selected (empty assets array).')
      console.log('File picking completed, but no file selected (empty assets array).')
      return null
    }
  } catch (error) {
    Logger?.error('Error picking file:', error)
    console.error('Error picking file:', error)
    return null
  }
}

/**
 * Reads text file content as a string.
 * Returns null on error.
 */
export async function readFileContent(
  uri: string,
  encoding: FileSystem.EncodingType = FileSystem.EncodingType.UTF8
): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(uri, { encoding })
  } catch (error) {
    Logger?.error(`Error reading file content from URI: ${uri}`, error)
    console.error(`Error reading file content from URI: ${uri}`, error)
    return null
  }
}

/**
 * Reads a binary file and returns its Base64 string content.
 * Returns null on error.
 */
export async function readBinaryFile(uri: string): Promise<string | null> {
  try {
    const base64Data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    return base64Data
  } catch (error) {
    Logger?.error('Error reading binary file:', error)
    console.error('Error reading binary file:', error)
    return null
  }
}

/**
 * Returns the lowercase file extension or null if none.
 */
export function getFileExtension(filename: string): string | null {
  const parts = filename.split('.')
  if (parts.length > 1) return parts.pop()?.toLowerCase() ?? null
  return null
}

/**
 * Copies file from source URI to app documentDirectory with destination name.
 * Creates intermediate directories as needed.
 * Returns full destination path on success or null on error.
 */
export async function copyFileToAppDirectory(
  sourceUri: string,
  destinationFileName: string
): Promise<string | null> {
  try {
    const appDir = FileSystem.documentDirectory
    if (!appDir) {
      throw new Error('Document directory not available on this device.')
    }

    const destinationPath = `${appDir}${destinationFileName}`
    const destinationDir = destinationPath.substring(0, destinationPath.lastIndexOf('/'))

    const dirInfo = await FileSystem.getInfoAsync(destinationDir)
    if (!dirInfo.exists || !dirInfo.isDirectory) {
      await FileSystem.makeDirectoryAsync(destinationDir, { intermediates: true })
      Logger?.info(`Created intermediate directory: ${destinationDir}`)
      console.log(`Created intermediate directory: ${destinationDir}`)
    }

    await FileSystem.copyAsync({ from: sourceUri, to: destinationPath })

    Logger?.info(`File copied from ${sourceUri} to ${destinationPath}`)
    console.log(`File copied from ${sourceUri} to ${destinationPath}`)

    return destinationPath
  } catch (error) {
    Logger?.error(`Error copying file from ${sourceUri} to ${destinationFileName}:`, error)
    console.error(`Error copying file from ${sourceUri} to ${destinationFileName}:`, error)
    return null
  }
}

/**
 * Checks if a file exists in app directory, including subdirs.
 */
export async function fileExistsInAppDirectory(fileName: string): Promise<boolean> {
  try {
    const appDir = FileSystem.documentDirectory
    if (!appDir) return false
    const fileInfo = await FileSystem.getInfoAsync(`${appDir}${fileName}`)
    return !!fileInfo.exists
  } catch (error) {
    Logger?.error(`Error checking if file exists: ${fileName}`, error)
    console.error(`Error checking if file exists: ${fileName}`, error)
    return false
  }
}

/**
 * Writes a string to cache directory and tries to download it to public storage.
 */
export async function saveStringToDownload(
  data: string,
  filename: string,
  encoding: 'base64' | 'utf8'
) {
  try {
    const cacheFilePath = FileSystem.cacheDirectory + filename
    await FileSystem.writeAsStringAsync(cacheFilePath, data, { encoding })
    Logger?.info(`File written to cache: ${cacheFilePath}`)
    console.log(`File written to cache: ${cacheFilePath}`)

    // localDownload expects path without "file://" prefix
    await localDownload(cacheFilePath.replace(/^file:\/\//, ''))
    Logger?.info(`File successfully downloaded to public storage: ${filename}`)
    console.log(`File successfully downloaded to public storage: ${filename}`)
  } catch (e: any) {
    Logger?.error('Failed to download file:', e.message || e)
    console.error('Failed to download file:', e.message || e)
  }
}

type PickerResult = { success: false } | { success: true; data: string }
type JSONPickerResult = { success: false } | { success: true; data: any }

/**
 * Picks a JSON document and parses its content.
 */
export async function pickJSONDocument(multiple = false): Promise<JSONPickerResult> {
  const result = await pickStringDocument({ type: 'application/json', multiple })
  if (!result.success) return result

  try {
    const jsonData = JSON.parse(result.data)
    return { success: true, data: jsonData }
  } catch (error) {
    Logger?.error('Failed to parse JSON data:', error)
    console.error('Failed to parse JSON data:', error)
    return { success: false }
  }
}

export async function pickStringDocument({
  multiple = false,
  encoding = 'utf8',
  type = '*/*',
}: {
  multiple?: boolean
  encoding?: 'utf8' | 'base64'
  type?: string
} = {}): Promise<PickerResult> {
  try {
    const result = await DocumentPicker.getDocumentAsync({ type, multiple })

    if (result.canceled) {
      Logger?.info('String document picking cancelled.')
      console.log('String document picking cancelled.')
      return { success: false }
    }

    if (!Array.isArray(result.assets) || result.assets.length === 0) {
      Logger?.info('No string document selected (empty assets array).')
      console.log('No string document selected (empty assets array).')
      return { success: false }
    }

    const asset = result.assets[0]!
    if (!asset.uri) {
      Logger?.warn('Selected asset has no URI.')
      console.warn('Selected asset has no URI.')
      return { success: false }
    }

    const data = await FileSystem.readAsStringAsync(asset.uri, { encoding }).catch(e => {
      Logger?.error(`Failed to read file content from ${asset.uri}:`, e)
      console.error(`Failed to read file content from ${asset.uri}:`, e)
      return null
    })

    if (data === null) return { success: false }
    return { success: true, data }
  } catch (error) {
    Logger?.error('Error picking string document:', error)
    console.error('Error picking string document:', error)
    return { success: false }
  }
}

const GB = 1000 ** 3
const MB = 1000 ** 2

/**
 * Converts bytes count into a human-readable string.
 * Examples: 
 *   123 bytes -> "123 bytes"
 *   1,234,567 bytes -> "1.23 MB"
 *   5,678,901,234 bytes -> "5.68 GB"
 * 
 * Uses base 10 units.
 */
export const readableFileSize = (size: number): string => {
  if (size < 1000) {
    return `${size} bytes`
  } else if (size < MB) {
    return `${(size / 1000).toFixed(2)} KB`
  } else if (size < GB) {
    return `${(size / MB).toFixed(2)} MB`
  } else {
    return `${(size / GB).toFixed(2)} GB`
  }
}

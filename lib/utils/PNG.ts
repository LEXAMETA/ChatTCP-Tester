// lib/utils/PNG.ts
import { atob } from 'react-native-quick-base64'

/**
 * Extracts and decodes the JSON object embedded in the PNG's tEXt chunk.
 * Assumes the text chunk payload is base64-encoded JSON UTF-8 string.
 * 
 * @param filedata Base64 encoded PNG file data
 * @returns Parsed JSON object from the tEXt chunk
 * @throws {Error} On invalid PNG structure, missing tEXt chunk, CRC error, or malformed JSON
 */
export function getPngChunkText(filedata: string): any {
  // Decode base64 to Uint8Array
  const binaryString = atob(filedata)
  const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0))

  // Extract tEXt chunk data (keyword + text)
  const tEXtData = extractTextChunk(bytes)

  // Decode keyword and text parts of the tEXt chunk
  const { keyword, text } = decodeTextChunk(tEXtData)

  // According to your convention, "text" holds base64-encoded JSON UTF-8 string
  // Decode base64 string to UTF-8 byte array
  const base64Decoded = base64ToUint8Array(utf8Decode(text))

  // Decode UTF-8 to string
  const jsonString = utf8Decode(base64Decoded)

  try {
    return JSON.parse(jsonString)
  } catch (e) {
    throw new Error(`Malformed JSON in tEXt chunk: ${(e as Error).message}`)
  }
}

/**
 * Valid PNG signature bytes (8 bytes)
 */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Extracts the tEXt chunk data from the PNG byte array.
 * Performs signature check, chunk iteration, CRC validation.
 * 
 * @param data Complete PNG file bytes
 * @returns Uint8Array of the tEXt chunk payload (keyword + null + text)
 * @throws {Error} On invalid PNG signature, missing IHDR, no tEXt chunk, or CRC errors
 */
function extractTextChunk(data: Uint8Array): Uint8Array {
  // Validate PNG signature
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) throw new Error('Invalid PNG signature')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = PNG_SIGNATURE.length
  let seenIHDR = false

  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset, false) // Big-endian length
    offset += 4

    if (offset + 4 + length + 4 > data.length) { 
      throw new Error('Unexpected end of PNG data')
    }

    // Read chunk type bytes and convert to string
    const chunkType = String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3]
    )
    offset += 4

    if (!seenIHDR) {
      if (chunkType !== 'IHDR') throw new Error('First chunk must be IHDR')
      seenIHDR = true
    }

    // Extract chunk data bytes
    const chunkData = data.slice(offset, offset + length)
    offset += length

    // Read CRC from file
    const crcRead = view.getUint32(offset, false)
    offset += 4

    // Calculate CRC over chunk type + chunk data
    const chunkTypeBytes = Uint8Array.from(chunkType.split('').map(c => c.charCodeAt(0)))
    const calcBuffer = new Uint8Array(chunkTypeBytes.length + chunkData.length)
    calcBuffer.set(chunkTypeBytes, 0)
    calcBuffer.set(chunkData, chunkTypeBytes.length)
    const crcCalc = crc32_buf(calcBuffer)

    if (crcCalc !== crcRead) {
      throw new Error(`CRC mismatch for chunk '${chunkType}'`)
    }

    if (chunkType === 'tEXt') {
      return chunkData
    }
  }

  throw new Error('No tEXt chunk found in PNG file')
}

/**
 * Decodes the tEXt chunk payload structure:
 * [keyword (ASCII, null-terminated)]+[text (latin1 or utf8 bytes)]
 * 
 * @param data Uint8Array payload of tEXt chunk
 * @returns Object with `keyword` and `text` Uint8Arrays
 * @throws {Error} If null terminator not found
 */
function decodeTextChunk(data: Uint8Array): { keyword: Uint8Array; text: Uint8Array } {
  const nullIndex = data.indexOf(0)
  if (nullIndex === -1) {
    throw new Error('Malformed tEXt chunk: missing null separator')
  }
  const keyword = data.slice(0, nullIndex)
  const text = data.slice(nullIndex + 1)

  return { keyword, text }
}

/**
 * Decodes a Uint8Array with UTF-8 bytes into a JS string.
 */
function utf8Decode(bytes: Uint8Array): string {
  // Use TextDecoder if available (React Native 0.65+ or polyfill)
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes)
  }

  // Fallback UTF-8 decoder, same logic as your original
  let str = ''
  let i = 0

  while (i < bytes.length) {
    const byte1 = bytes[i++]
    if (byte1 < 0x80) {
      str += String.fromCharCode(byte1)
    } else if (byte1 < 0xe0) {
      const byte2 = bytes[i++]
      str += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f))
    } else if (byte1 < 0xf0) {
      const byte2 = bytes[i++]
      const byte3 = bytes[i++]
      str += String.fromCharCode(
        ((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f)
      )
    } else {
      const byte2 = bytes[i++]
      const byte3 = bytes[i++]
      const byte4 = bytes[i++]
      const codepoint =
        (((byte1 & 0x07) << 18) |
          ((byte2 & 0x3f) << 12) |
          ((byte3 & 0x3f) << 6) |
          (byte4 & 0x3f)) -
        0x10000
      str += String.fromCharCode(
        ((codepoint >> 10) & 0x3ff) | 0xd800,
        (codepoint & 0x3ff) | 0xdc00
      )
    }
  }

  return str
}

/**
 * Converts base64 string to Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

/**
 * CRC32 Calculation: precomputed table for speed (standard IEEE 802.3 polynomial).
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

/**
 * Calculates the CRC32 checksum of a Uint8Array.
 * @param buf The input buffer
 * @returns CRC32 checksum as unsigned number
 */
function crc32_buf(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

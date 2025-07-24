// lib/utils/TextFormat.ts
// import { Logger } from '../state/Logger'; // Consider importing Logger if detailed logging is desired here
import { Instructs } from '@lib/state/Instructs'
import * as FileSystem from 'expo-file-system' // Required for getInfoAsync in migrations

export enum Formats {
    None,
    PlainActionQuoteSpeech,    // Example: Action text. "Speech text."
    AsteriskActionPlainSpeech, // Example: *Action text* Speech text.
    AsteriskActionQuoteSpeech, // Example: *Action text* "Speech text."
}

type TextTypes = 'action' | 'speech' | 'none'

type TextData = {
    type: TextTypes
    content: string
}

/**
 * Detects the formatting style of an input string based on the presence and context of asterisks and quotes.
 * This function uses heuristics and might require fine-tuning based on specific content patterns.
 * @param input The string to analyze.
 * @returns The detected Formats enum value.
 */
const detectFormat = (input: string): Formats => {
    const hasAsterisk = input.includes('*')
    const hasQuote = input.includes('"')

    // Scenario 1: Only quotes, no asterisks
    if (hasQuote && !hasAsterisk) {
        return Formats.PlainActionQuoteSpeech
    }
    // Scenario 2: Only asterisks, no quotes
    else if (!hasQuote && hasAsterisk) {
        return Formats.AsteriskActionPlainSpeech
    }
    // Scenario 3: Both quotes and asterisks
    else if (hasQuote && hasAsterisk) {
        // Check if quotes are *within* asterisks (strong indicator of AsteriskActionQuoteSpeech)
        // This regex captures the content inside the first asterisk pair.
        const asteriskMatches = input.match(/\*([^*]*)\*/)
        if (asteriskMatches && asteriskMatches[1]) { // Ensure asterisk content exists
            const asteriskContent = asteriskMatches[1]
            const quoteMatchesInAsterisk = asteriskContent.match(/"([^"]*)"/)
            // If there's a non-empty quoted phrase within the asterisk, it's likely AsteriskActionQuoteSpeech
            if (quoteMatchesInAsterisk?.[1] !== undefined && quoteMatchesInAsterisk[1].trim().length > 0) {
                return Formats.AsteriskActionQuoteSpeech
            }
        }

        // If no quotes are found within the first asterisk pair,
        // check for quotes that exist *outside* any asterisked blocks.
        // This is a heuristic: if quotes appear independently, it suggests a mixed format.
        const quoteMatchesOutsideAsterisk = input.match(/"([^"]*)"/g)
        if (quoteMatchesOutsideAsterisk) {
            for (const quoteMatch of quoteMatchesOutsideAsterisk) {
                // If there are no asterisk matches at all, or if the current quote is not contained
                // within the first detected asterisk block, consider it an "outside" quote.
                if (
                    !asteriskMatches ||
                    (asteriskMatches && !asteriskMatches[0].includes(quoteMatch))
                ) {
                    const cleanQuoteContent = quoteMatch.replace(/"/g, '').trim()
                    // If the cleaned quote content looks like speech (multiple words or ends with punctuation),
                    // it further strengthens the case for AsteriskActionQuoteSpeech.
                    if (cleanQuoteContent.split(' ').length > 1 || /[.!?]$/.test(cleanQuoteContent)) {
                        return Formats.AsteriskActionQuoteSpeech
                    }
                }
            }
        }
    }

    // If none of the specific formats are clearly detected, default to None.
    return Formats.None
}

/**
 * Deconstructs an input string into an array of TextData objects based on the specified format.
 * This separates the string into 'action', 'speech', or 'none' (for whitespace/newlines) segments.
 * @param input The string to deconstruct.
 * @param format The format to use for deconstruction.
 * @returns An array of TextData objects.
 */
const destructString = (input: string, format: Formats): TextData[] => {
    const textData: TextData[] = []

    switch (format) {
        case Formats.PlainActionQuoteSpeech: {
            // Splits by quoted phrases (keeping quotes) or newlines, and filters out empty strings from split.
            const parts = input.split(/(".*?"|\n+)/g).filter(Boolean)
            for (const part of parts) {
                if (!part.trim()) {
                    // Handles purely whitespace/newline parts as 'none' type.
                    textData.push({ type: 'none', content: part })
                } else if (part.startsWith('"') && part.endsWith('"')) {
                    // Identifies quoted parts as 'speech'. Removes quotes for content.
                    textData.push({ type: 'speech', content: part.slice(1, -1).trim() })
                } else {
                    // Any other non-empty parts are treated as 'action'.
                    textData.push({ type: 'action', content: part.trim() })
                }
            }
            break
        }
        case Formats.AsteriskActionPlainSpeech: {
            // Splits by asterisked phrases (keeping asterisks) or newlines, filters out empty strings.
            const parts = input.split(/(\*[^*]*\*|\n+)/g).filter(Boolean)
            for (const part of parts) {
                if (part.startsWith('*') && part.endsWith('*')) {
                    // Identifies asterisked parts as 'action'. Removes asterisks for content.
                    textData.push({ type: 'action', content: part.slice(1, -1).trim() })
                } else if (part.includes('\n')) {
                    // Handles newlines as 'none'.
                    textData.push({ type: 'none', content: part })
                } else if (part.trim().length > 0) {
                    // Any other non-empty parts are treated as 'speech'.
                    textData.push({ type: 'speech', content: part.trim() })
                }
                // Implicitly ignores parts that become empty after trimming and are not newlines.
            }
            break
        }
        case Formats.AsteriskActionQuoteSpeech: {
            // Splits by either asterisked or quoted phrases (keeping delimiters), filters empty strings.
            // The regex `(\*.*?\*|"[^"]*")` is designed to be non-greedy (`*?`) for asterisks to match the shortest possible pair,
            // and `[^"]*` for quotes to match content without inner quotes.
            const parts = input.split(/(\*.*?\*|"[^"]*")/g).filter(Boolean)

            for (const part of parts) {
                if (part.startsWith('*') && part.endsWith('*')) {
                    // Asterisked parts are 'action'.
                    textData.push({ type: 'action', content: part.slice(1, -1).trim() })
                } else if (part.startsWith('"') && part.endsWith('"')) {
                    // Quoted parts are 'speech'.
                    textData.push({ type: 'speech', content: part.slice(1, -1).trim() })
                } else if (part.includes('\n')) {
                    // Newlines are 'none'.
                    textData.push({ type: 'none', content: part })
                } else if (part.trim().length > 0) {
                    // Any remaining non-empty plain text segments are typically action preamble or interjections.
                    textData.push({ type: 'action', content: part.trim() });
                }
            }
            break
        }
        case Formats.None:
            // If the format is explicitly 'None', the entire non-empty input is treated as 'none' type.
            if (input.trim().length > 0) {
                textData.push({ type: 'none', content: input.trim() });
            } else {
                // Preserve original content including whitespace for empty/all-whitespace strings.
                textData.push({ type: 'none', content: input });
            }
            break;
    }

    return textData
}

/**
 * Constructs a string from an array of TextData objects based on the target format.
 * Applies the specified formatting (e.g., adding quotes or asterisks) to each segment.
 * @param input An array of TextData objects.
 * @param format The target format for construction.
 * @returns The formatted string.
 */
const constructString = (input: TextData[], format: Formats): string => {
    let result = ''

    // Define default formatters that return content as-is, to be overridden by specific formats.
    const formatters: Record<TextTypes, (text: TextData) => string> = {
        action: (text: TextData) => text.content,
        speech: (text: TextData) => text.content,
        none: (text: TextData) => text.content, // 'none' content (like newlines) is usually passed through
    }

    switch (format) {
        case Formats.PlainActionQuoteSpeech:
            // Actions are plain, speech is enclosed in quotes. A space is added after each segment.
            formatters.action = (data) => `${data.content} `
            formatters.speech = (data) => `"${data.content}" `
            break

        case Formats.AsteriskActionPlainSpeech:
            // Actions are enclosed in asterisks, speech is plain. A space is added after each segment.
            formatters.action = (data) => `*${data.content}* `
            formatters.speech = (data) => `${data.content} `
            // The `formatters.none` for this case now consistently passes through content.
            // The old `endsWith('"')` logic was removed as it was inconsistent with "PlainSpeech".
            break

        case Formats.AsteriskActionQuoteSpeech:
            // Actions are enclosed in asterisks, speech is enclosed in quotes. A space is added after each segment.
            formatters.action = (data) => `*${data.content}* `
            formatters.speech = (data) => `"${data.content}" `
            break
        case Formats.None:
            // When target format is 'None', action and speech content are treated as plain text
            // with a space for separation, while 'none' content is passed as-is.
            formatters.action = (data) => `${data.content} `
            formatters.speech = (data) => `${data.content} `
            break;
    }

    // Iterate through the deconstructed data and apply the appropriate formatting.
    input.forEach((data) => {
        result += formatters[data.type](data)
    })

    // Trim any leading or trailing whitespace from the final result.
    return result.trim()
}

/**
 * Converts an input string from its detected format to a specified target format.
 * This involves deconstructing the string into semantic parts and then reconstructing it.
 * If the target format is `Formats.None`, or if the source format is already the target
 * (or cannot be detected), the input string is returned without modification.
 * @param input The string to convert.
 * @param targetFormat The desired output format.
 * @returns The converted string, or the original string if no conversion is needed/possible.
 */
export const convertToFormat = (input: string, targetFormat: Formats): string => {
    // If target is None, no special formatting should be applied, return input as is.
    if (targetFormat === Formats.None) {
        // Logger?.info('Target format is None, returning input as-is.');
        return input;
    }

    const sourceFormat = detectFormat(input)

    // If the source format is already the target format, or if no specific source format
    // could be detected, then no conversion is necessary.
    if (sourceFormat === targetFormat || sourceFormat === Formats.None) {
        // Logger?.info(`No conversion needed. Source: ${Formats[sourceFormat]}, Target: ${Formats[targetFormat]}.`);
        return input
    }

    // Perform the conversion: deconstruct from source format, then construct to target format.
    // Logger?.info(`Converting from ${Formats[sourceFormat]} to ${Formats[targetFormat]}.`);
    const textdata = destructString(input, sourceFormat)
    return constructString(textdata, targetFormat)
}

/**
 * Converts an input string to the format specified by the current application's Instructs state.
 * This is a convenience function that wraps `convertToFormat` using a dynamically determined target format.
 * If no format is specified in `Instructs`, or if it's explicitly `Formats.None`, the input is returned as is.
 * @param input The string to convert.
 * @returns The converted string, or the original string if no Instructs format is set or it's None.
 */
export const convertToFormatInstruct = (input: string): string => {
    // Retrieve the preferred format type from the Instructs state.
    const formatType = Instructs.useInstruct.getState().data?.format_type

    // If formatType is undefined, null, or explicitly Formats.None (which is 0),
    // then no specific instruction format is set, so return the input as is.
    if (formatType === undefined || formatType === null || formatType === Formats.None) {
        // Logger?.info('Instruct format is undefined, null, or None. Returning input as-is.');
        return input
    }

    // Otherwise, convert the input string to the format specified by Instructs.
    return convertToFormat(input, formatType)
}

// lib/tcp-client.ts
import { Buffer } from 'buffer' // Polyfill for Buffer in React Native
import { inflate, deflate } from 'pako' // For ZLIB compression/decompression (specific imports from ChatterUI-Latest)
import { createConnection, Socket } from 'react-native-tcp-socket'

// Polyfill for Buffer if not globally available (kept from ChatTCP-Tester for robustness)
if (typeof global.Buffer === 'undefined') {
    global.Buffer = Buffer
}

export interface Request {
    type: 'prompt' | 'status' | 'config' // Extended types from ChatterUI-Latest
    model: string
    prompt?: string
    lora?: string
    // Additional fields as needed
}

export interface Response {
    status: 'success' | 'error'
    output?: string
    error?: string
    // Additional fields as needed
}

export class TcpClient {
    public socket: Socket | null = null
    private receivedDataBuffer: Uint8Array = new Uint8Array(0)
    private isConnecting: boolean = false
    private currentHost: string = ''
    private currentPort: number = 0
    private connectionStatusCallback:
        | ((status: 'Connected' | 'Connecting...' | 'Disconnected' | 'Error') => void)
        | null = null

    // Current in-flight request's Promise handlers (simpler than a queue for single-request model)
    private currentRequestResolve: ((response: Response) => void) | null = null
    private currentRequestReject: ((error: Error) => void) | null = null

    /**
     * Sets a callback function to receive connection status updates.
     * @param callback The function to call with status updates.
     */
    public setStatusCallback(
        callback: (status: 'Connected' | 'Connecting...' | 'Disconnected' | 'Error') => void
    ) {
        this.connectionStatusCallback = callback
    }

    /**
     * Updates and logs the connection status.
     * @param status The current connection status.
     */
    private updateStatus(status: 'Connected' | 'Connecting...' | 'Disconnected' | 'Error') {
        this.connectionStatusCallback?.(status)
        console.log(`[TcpClient] Status: ${status}`)
    }

    /**
     * Establishes a TCP connection with retry logic.
     * @param host The hostname or IP address to connect to.
     * @param port The port to connect to.
     * @param retries The number of retry attempts.
     * @param delay The delay in milliseconds between retries.
     */
    async connect(host: string, port: number, retries = 3, delay = 1000): Promise<void> {
        if (this.socket && !this.isConnecting) {
            console.log(`[TcpClient] Already connected to ${this.currentHost}:${this.currentPort}`)
            this.updateStatus('Connected')
            return // Already connected
        }
        if (this.isConnecting) {
            console.log(`[TcpClient] Already attempting to connect to ${host}:${port}.`)
            return // Connection already in progress
        }

        this.currentHost = host
        this.currentPort = port
        this.isConnecting = true
        this.updateStatus('Connecting...')
        console.log(`[TcpClient] Attempting to connect to ${host}:${port}...`)

        for (let attempt = 1; attempt <= retries; attempt++) {
            console.log(`[TcpClient] Connection attempt ${attempt} of ${retries}...`)
            try {
                await new Promise<void>((resolve, reject) => {
                    this.socket = createConnection({ host, port, tls: false }, () => {
                        console.log(`[TcpClient] Successfully connected to ${host}:${port}`)
                        this.updateStatus('Connected')
                        this.isConnecting = false
                        this.setupListeners(this.socket!) // Setup listeners after successful connection
                        resolve()
                    })
                    this.socket.on('error', (error: any) => {
                        console.error(
                            `[TcpClient] Connection error on attempt ${attempt} for ${host}:${port}:`,
                            error.message
                        )
                        this.updateStatus('Error')
                        this.socket?.destroy() // Ensure socket is destroyed on connection error
                        reject(error)
                    })
                })
                return // Connection successful, exit loop
            } catch (error: any) {
                if (attempt === retries) {
                    // Last attempt failed, throw error
                    console.error(
                        `[TcpClient] Failed to connect after ${retries} attempts to ${host}:${port}. Last error:`,
                        error.message
                    )
                    this.updateStatus('Error')
                    throw new Error(`Failed to connect after ${retries} attempts: ${error.message}`)
                }
                // Retry after delay
                console.log(`[TcpClient] Retrying connection in ${delay}ms...`)
                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }

    /**
     * Disconnects the TCP socket and cleans up resources.
     */
    public disconnect(): void {
        if (this.socket) {
            console.log(`[TcpClient] Disconnecting from ${this.currentHost}:${this.currentPort}.`)
            this.socket.removeAllListeners() // Remove all listeners to prevent memory leaks
            this.socket.destroy() // Destroy the socket
            this.socket = null
            this.updateStatus('Disconnected')
            this.isConnecting = false
            // Reject any pending request
            this.currentRequestReject?.(new Error('Disconnected while request was pending.'))
            this.currentRequestResolve = null
            this.currentRequestReject = null
            this.receivedDataBuffer = new Uint8Array(0); // Clear buffer on disconnect
        } else {
            console.log('[TcpClient] No active socket to disconnect.')
        }
    }

    /**
     * Sends a request payload over the TCP connection.
     * Only one request can be in flight at a time.
     * @param payload The request object to send.
     * @returns A Promise that resolves with the response or rejects with an error.
     */
    async send(payload: Request): Promise<Response> {
        if (!this.socket) {
            this.updateStatus('Disconnected')
            throw new Error('TCP Client not connected. Cannot send data.')
        }

        // Prevent multiple concurrent requests
        if (this.currentRequestResolve || this.currentRequestReject) {
            console.warn('[TcpClient] A previous request is still pending. Rejecting new request.')
            throw new Error('Another request is already in progress. Please wait.')
        }

        return new Promise((resolve, reject) => {
            // Store the resolve/reject for the current request
            this.currentRequestResolve = resolve
            this.currentRequestReject = reject

            // Set a timeout for the response
            const responseTimeout = setTimeout(() => {
                console.warn('[TcpClient] Response timeout occurred for request.')
                this.currentRequestReject?.(new Error('Response timed out from peer.'))
                this.currentRequestResolve = null
                this.currentRequestReject = null
            }, 30000) // 30-second timeout

            const jsonString = JSON.stringify(payload)
            console.log(`[TcpClient] Original payload size: ${jsonString.length} bytes`)

            try {
                // Compress the JSON string
                const compressedData = deflate(jsonString)
                console.log(
                    `[TcpClient] Compressed payload size: ${compressedData.length} bytes. Ratio: ${(
                        (compressedData.length / jsonString.length) *
                        100
                    ).toFixed(2)}%`
                )

                // Create a 4-byte buffer for the message length (Little-Endian)
                const lengthBuffer = Buffer.alloc(4)
                lengthBuffer.writeUInt32LE(compressedData.length, 0) // IMPORTANT: Using LE as in ChatterUI-Latest

                // Concatenate length buffer and compressed data
                const messageBuffer = Buffer.concat([lengthBuffer, Buffer.from(compressedData)])

                console.log(`[TcpClient] Sending total message size: ${messageBuffer.length} bytes`)
                // Write the message to the socket
                this.socket?.write(messageBuffer, undefined, (error: any) => {
                    clearTimeout(responseTimeout) // Clear timeout once write callback fires
                    if (error) {
                        console.error('[TcpClient] Error writing to socket:', error.message)
                        this.updateStatus('Error')
                        this.currentRequestReject?.(
                            new Error(`Failed to send data: ${error.message}`)
                        )
                        this.currentRequestResolve = null
                        this.currentRequestReject = null
                    } else {
                        console.log('[TcpClient] Data sent successfully.')
                    }
                })
            } catch (e: any) {
                clearTimeout(responseTimeout) // Clear timeout on error
                console.error('[TcpClient] Compression or serialization error:', e.message)
                this.currentRequestReject?.(new Error(`Data processing error: ${e.message}`))
                this.currentRequestResolve = null
                this.currentRequestReject = null
            }
        })
    }

    /**
     * Sets up event listeners for the socket (data, close, error).
     * @param s The TCP socket instance.
     */
    private setupListeners(s: Socket): void {
        s.removeAllListeners() // Clear any existing listeners to prevent duplicates

        s.on('data', this.handleIncomingData.bind(this)) // Bind context for 'this'

        s.on('close', () => {
            console.log(`[TcpClient] Socket closed.`)
            this.updateStatus('Disconnected')
            this.socket = null
            this.receivedDataBuffer = new Uint8Array(0) // Clear buffer
            this.currentRequestReject?.(new Error('Socket closed unexpectedly.')) // Reject pending request
            this.currentRequestResolve = null
            this.currentRequestReject = null
        })

        s.on('error', (error: any) => {
            console.error('[TcpClient] Socket error:', error.message)
            this.updateStatus('Error')
            this.currentRequestReject?.(
                new Error(`Socket error during communication: ${error.message}`)
            )
            this.currentRequestResolve = null
            this.currentRequestReject = null
            this.disconnect() // Attempt to gracefully disconnect on error
        })
    }

    /**
     * Handles incoming data chunks from the TCP socket.
     * Buffers data and processes complete messages.
     * @param data The incoming data Buffer.
     */
    private handleIncomingData(data: Buffer): void {
        console.log(`[TcpClient] Raw incoming data chunk size: ${data.length} bytes`)

        // Efficiently concatenate new data to the buffer
        const newBuffer = new Uint8Array(this.receivedDataBuffer.length + data.length)
        newBuffer.set(this.receivedDataBuffer, 0)
        newBuffer.set(new Uint8Array(data), this.receivedDataBuffer.length) // Convert Buffer to Uint8Array for set
        this.receivedDataBuffer = newBuffer

        console.log(`[TcpClient] Current buffer size: ${this.receivedDataBuffer.length} bytes`)

        // Process messages from the buffer as long as complete messages are available
        while (this.receivedDataBuffer.length >= 4) {
            // Read message length (Little-Endian)
            const messageLength = Buffer.from(this.receivedDataBuffer.slice(0, 4)).readUInt32LE(0) // IMPORTANT: Using LE as in ChatterUI-Latest

            if (this.receivedDataBuffer.length >= 4 + messageLength) {
                const compressedMessage = this.receivedDataBuffer.slice(4, 4 + messageLength)
                console.log(
                    `[TcpClient] Extracted compressed message size: ${compressedMessage.length} bytes`
                )

                try {
                    // Decompress and parse the message
                    const decompressedData = inflate(compressedMessage, { to: 'string' })
                    console.log(
                        `[TcpClient] Decompressed message size: ${decompressedData.length} bytes`
                    )

                    const response: Response = JSON.parse(decompressedData)
                    console.log('[TcpClient] Received and parsed response:', response)

                    // Resolve the pending request
                    this.currentRequestResolve?.(response)
                    // Clear the pending request handlers
                    this.currentRequestResolve = null
                    this.currentRequestReject = null
                } catch (e: any) {
                    console.error(
                        '[TcpClient] Error processing incoming data (decompression or JSON parse):',
                        e.message
                    )
                    // Reject the pending request on error
                    this.currentRequestReject?.(new Error(`Failed to parse response: ${e.message}`))
                    // Clear the pending request handlers
                    this.currentRequestResolve = null
                    this.currentRequestReject = null
                }

                // Remove the processed message from the buffer
                this.receivedDataBuffer = this.receivedDataBuffer.slice(4 + messageLength)
                console.log(
                    `[TcpClient] Remaining buffer size after processing: ${this.receivedDataBuffer.length} bytes`
                )
            } else {
                // Not enough data for the full message, wait for more
                break
            }
        }
    }
}


// Replace the actual instance with a dummy object for the build test.
// This is crucial because other files might try to import tcpClientInstance.
// If you need a live instance, you'll manage it externally.
export const tcpClientInstance: any = {}

// This mock function can remain, as it doesn't rely on react-native-tcp-socket directly.
export const sendMockPrompt = async (payload: Request): Promise<Response> => {
    console.log('[Mock TCP Client] Received mock prompt:', payload.prompt)
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve({
                status: 'success',
                output: `Mock AI response to "${payload.prompt}" from model ${payload.model}. (Via Mock)`,
            })
        }, 1000)
    })
}

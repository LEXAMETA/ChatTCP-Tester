// lib/tcp-client.ts
import { Buffer } from 'buffer' // Polyfill for Buffer in React Native
import { inflate, deflate } from 'pako' // Zlib compression/decompression
import { createConnection, Socket } from 'react-native-tcp-socket'

// Polyfill for Buffer if not globally available (common in React Native environments)
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer
}

// Defines the structure for requests sent to the TCP server
export interface Request {
  type: 'prompt' | 'status' | 'config' // Extensible types for different request functionalities
  model: string // AI model identifier
  prompt?: string // User prompt for 'prompt' type requests
  lora?: string // Optional LoRA adapter for AI models
  // Add more fields as your protocol evolves
}

// Defines the expected structure for responses received from the TCP server
export interface Response {
  status: 'success' | 'error' // Indicates the outcome of the request
  output?: string // AI generated output on success
  error?: string // Error message on failure
  // Add more fields as your protocol evolves
}

// Defines possible connection states for robust state management and UI feedback
type ConnectionStatus = 'Connected' | 'Connecting...' | 'Disconnected' | 'Error'

// Internal interface to manage pending requests in the queue
interface PendingRequest {
  payload: Request // The original request payload
  resolve: (res: Response) => void // Promise resolve function
  reject: (error: Error) => void // Promise reject function
  timeoutId: ReturnType<typeof setTimeout> // Identifier for the request's timeout
}

/**
 * Robust TCP Client for React Native with improved reliability,
 * concurrency control, exponential backoff for retries, and optimized buffer handling.
 */
export class TcpClient {
  private socket: Socket | null = null // The active TCP socket instance

  // Buffer to accumulate incoming data chunks until complete messages are formed
  private receivedDataBuffer = Buffer.alloc(0)

  // Callback to notify external components (e.g., UI) about connection status changes
  private connectionStatusCallback: ((status: ConnectionStatus) => void) | null = null

  private currentHost = '' // Stores the last connected host
  private currentPort = 0 // Stores the last connected port

  private connectionState: ConnectionStatus = 'Disconnected' // Current connection state

  private isConnecting = false // Flag to prevent multiple concurrent connection attempts

  // Queue to serialize 'send' requests, ensuring only one request is processed at a time
  private requestQueue: PendingRequest[] = []
  private processingRequest = false // Flag to indicate if a request is currently being processed

  // Flag to prevent recursive disconnect calls during error handling/cleanup
  private isDisconnecting = false

  // Promise handlers for the *currently processing* request, for async response matching
  private currentRequestResolve: ((response: Response) => void) | null = null
  private currentRequestReject: ((error: Error) => void) | null = null

  /**
   * Sets a callback function to receive real-time connection status updates.
   * @param callback The function to be called with the current connection status.
   */
  public setStatusCallback(callback: (status: ConnectionStatus) => void) {
    this.connectionStatusCallback = callback
  }

  /**
   * Updates the internal connection state, triggers the status callback, and logs the change.
   * Prevents redundant updates if the status hasn't actually changed.
   * @param status The new connection status.
   */
  private updateStatus(status: ConnectionStatus) {
    if (this.connectionState !== status) {
      this.connectionState = status
      this.connectionStatusCallback?.(status)
      console.log(`[TcpClient] Status: ${status}`)
    }
  }

  /**
   * Establishes a TCP connection to the specified host and port with retry logic
   * and exponential backoff. Prevents concurrent connection attempts.
   * @param host The target host (IP address or hostname).
   * @param port The target port.
   * @param retries The maximum number of connection retry attempts (default: 5).
   * @param baseDelay The base delay in milliseconds for exponential backoff (default: 500ms).
   * @returns A Promise that resolves if connection is successful, rejects otherwise.
   */
  public async connect(host: string, port: number, retries = 5, baseDelay = 500): Promise<void> {
    // If already connected, do nothing
    if (this.socket && this.connectionState === 'Connected') {
      console.log(`[TcpClient] Already connected to ${this.currentHost}:${this.currentPort}`)
      this.updateStatus('Connected')
      return
    }
    // If connection is already in progress, do nothing
    if (this.isConnecting) {
      console.log(`[TcpClient] Connection already in progress to ${host}:${port}`)
      return
    }

    this.currentHost = host
    this.currentPort = port
    this.isConnecting = true
    this.updateStatus('Connecting...')
    let attempt = 0

    while (attempt < retries) {
      attempt++
      try {
        await this.attemptConnection(host, port) // Attempt a single connection
        this.isConnecting = false
        return // Connection successful, exit loop
      } catch (error) {
        if (attempt >= retries) {
          // All retries exhausted, throw final error
          console.error(`[TcpClient] Failed to connect after ${attempt} attempts: ${(error as Error).message}`)
          this.isConnecting = false
          this.updateStatus('Error')
          throw new Error(`Failed to connect after ${attempt} attempts: ${(error as Error).message}`)
        }
        // Calculate exponential backoff delay with random jitter
        const jitter = baseDelay * (0.5 + Math.random()) // Random factor between 0.5 and 1.5
        const delayMs = baseDelay * 2 ** (attempt - 1) + jitter
        console.log(`[TcpClient] Connection attempt ${attempt} failed. Retrying in ${Math.round(delayMs)}ms...`)
        await new Promise(resolve => setTimeout(resolve, delayMs)) // Wait before retrying
      }
    }
    this.isConnecting = false // Should not be reached if an error is thrown on last attempt
  }

  /**
   * Attempts a single connection to the specified host and port.
   * Internal helper for the `connect` method's retry loop.
   * @param host The target host.
   * @param port The target port.
   * @returns A Promise that resolves on successful connection, rejects on error.
   */
  private attemptConnection(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port, tls: false }, () => {
        // Connection established successfully
        console.log(`[TcpClient] Connected to ${host}:${port}`)
        this.socket = socket // Store the active socket
        this.updateStatus('Connected')
        this.setupListeners(socket) // Set up data, close, and error listeners
        resolve()
      })

      // Handle connection errors (e.g., host unreachable, port closed)
      socket.on('error', (error: any) => {
        console.error(`[TcpClient] Connection error: ${error.message}`)
        this.updateStatus('Error')
        socket.destroy() // Ensure socket is closed/cleaned up
        reject(error)
      })
    })
  }

  /**
   * Disconnects the TCP client, cleans up the socket, and rejects any pending or queued requests.
   * Uses `isDisconnecting` flag to prevent re-entrant calls.
   */
  public disconnect() {
    if (this.isDisconnecting) {
      return // Already in the process of disconnecting
    }
    this.isDisconnecting = true

    if (this.socket) {
      console.log(`[TcpClient] Disconnecting from ${this.currentHost}:${this.currentPort}`)
      this.socket.removeAllListeners() // Remove all listeners to prevent memory leaks
      this.socket.destroy() // Forcefully close the socket
      this.socket = null
    }

    this.updateStatus('Disconnected') // Update and log status

    // Reject all requests currently in the queue
    while (this.requestQueue.length) {
      const req = this.requestQueue.shift()!
      clearTimeout(req.timeoutId) // Clear any associated timeout
      req.reject(new Error('Disconnected before request could be processed.'))
    }

    this.processingRequest = false // Reset processing flag
    this.receivedDataBuffer = Buffer.alloc(0) // Clear any buffered data

    this.isDisconnecting = false // Reset disconnecting flag
  }

  /**
   * Sends a request object over the TCP connection.
   * Requests are automatically queued to ensure only one is in-flight at a time.
   * Each request has its own timeout.
   * @param payload The request object to send.
   * @returns A Promise that resolves with the server's response or rejects on error/timeout.
   */
  public async send(payload: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
      // Setup a timeout for this specific request
      const timeoutMs = 30000 // 30 seconds for response timeout
      const timeoutId = setTimeout(() => {
        console.warn('[TcpClient] Request timed out:', JSON.stringify(payload))
        reject(new Error('Response timed out.'))
        // If this request is still in the queue, remove it
        this.requestQueue = this.requestQueue.filter(r => r.reject !== reject)
        // If this was the request being processed, signal completion and process next
        if (this.currentRequestReject === reject) {
            this.currentRequestResolve = null;
            this.currentRequestReject = null;
            this.processingRequest = false;
            this.processQueue(); // Try to process the next item
        }
      }, timeoutMs)

      // Add the request to the queue
      this.requestQueue.push({
        payload,
        resolve,
        reject,
        timeoutId,
      })

      // Attempt to process the queue (will only run if no other request is in flight)
      this.processQueue()
    })
  }

  /**
   * Processes the request queue. This method ensures that requests are sent
   * sequentially, one at a time, preventing concurrency issues on the socket.
   */
  private async processQueue() {
    // If a request is already being processed, or the queue is empty, or not connected, do nothing
    if (this.processingRequest || this.requestQueue.length === 0) {
      return
    }
    if (!this.socket || this.connectionState !== 'Connected') {
        // If not connected, reject all pending requests immediately
        while (this.requestQueue.length) {
            const req = this.requestQueue.shift()!;
            clearTimeout(req.timeoutId);
            req.reject(new Error('Not connected to server. Request cancelled.'));
        }
        this.processingRequest = false; // Ensure flag is reset
        return;
    }

    this.processingRequest = true // Mark as processing
    const currentRequest = this.requestQueue.shift()! // Get the next request from the front of the queue

    try {
      await this.writeRequest(currentRequest.payload) // Send the request over the socket

      // Store the resolve/reject handlers for the current request.
      // These will be called when the corresponding response arrives in `handleIncomingData`.
      this.currentRequestResolve = (response: Response) => {
        clearTimeout(currentRequest.timeoutId) // Clear the request's timeout
        currentRequest.resolve(response) // Resolve the original request's Promise
        this.currentRequestResolve = null // Clear handlers
        this.currentRequestReject = null
        this.processingRequest = false // Mark as not processing
        this.processQueue() // Attempt to process the next request in the queue
      }

      this.currentRequestReject = (error: Error) => {
        clearTimeout(currentRequest.timeoutId) // Clear the request's timeout
        currentRequest.reject(error) // Reject the original request's Promise
        this.currentRequestResolve = null // Clear handlers
        this.currentRequestReject = null
        this.processingRequest = false // Mark as not processing
        this.processQueue() // Attempt to process the next request in the queue
      }
    } catch (writeError) {
      // Handle errors that occur during the writing process (e.g., socket closed unexpectedly)
      clearTimeout(currentRequest.timeoutId) // Clear timeout for failed write
      currentRequest.reject(writeError as Error) // Reject the original request's Promise
      this.processingRequest = false // Mark as not processing
      this.processQueue() // Attempt to process the next request in the queue
    }
  }

  /**
   * Serializes the request payload, compresses it, prefixes it with length, and sends it over the socket.
   * This is an internal helper called by `processQueue`.
   * @param payload The request object to be written to the socket.
   * @returns A Promise that resolves when the data is successfully written, or rejects on error.
   */
  private async writeRequest(payload: Request): Promise<void> {
    if (!this.socket) {
      throw new Error('Socket is not connected. Cannot write data.')
    }

    const jsonString = JSON.stringify(payload)
    console.log(`[TcpClient] Original payload size: ${jsonString.length} bytes`)

    // Compress the JSON string using pako's deflate (ZLIB)
    const compressedData = deflate(jsonString)

    console.log(
      `[TcpClient] Compressed payload size: ${compressedData.length} bytes. Compression ratio: ${(
        (compressedData.length / jsonString.length) *
        100
      ).toFixed(2)}%`
    )

    // Create a 4-byte buffer for the message length using Little-Endian byte order
    const lengthBuffer = Buffer.alloc(4)
    lengthBuffer.writeUInt32LE(compressedData.length, 0) // IMPORTANT: Use Little-Endian (LE) to match server expectation

    // Concatenate the length buffer and the compressed data to form the full message
    const messageBuffer = Buffer.concat([lengthBuffer, Buffer.from(compressedData)])

    console.log(`[TcpClient] Sending message total size: ${messageBuffer.length} bytes`)

    // Write the full message to the socket. Convert the callback to a Promise.
    await new Promise<void>((resolve, reject) => {
      this.socket?.write(messageBuffer, (error) => {
        if (error) {
          console.error('[TcpClient] Write error:', error.message)
          this.updateStatus('Error') // Update status on write error
          reject(error)
        } else {
          console.log('[TcpClient] Data sent successfully')
          resolve()
        }
      })
    })
  }

  /**
   * Sets up event listeners for the TCP socket: 'data', 'close', and 'error'.
   * Ensures previous listeners are removed to prevent duplicates.
   * @param socket The TCP socket instance to attach listeners to.
   */
  private setupListeners(socket: Socket) {
    socket.removeAllListeners() // Remove any old listeners from previous connections

    // Handle incoming data chunks
    socket.on('data', (data: Buffer) => {
      this.handleIncomingData(data) // Pass data to the buffer processor
    })

    // Handle socket closure
    socket.on('close', (hadError: boolean) => {
      console.log(`[TcpClient] Socket closed. Had error: ${hadError}`)
      this.updateStatus('Disconnected')
      this.socket = null // Clear socket reference
      this.receivedDataBuffer = Buffer.alloc(0) // Clear buffer

      // Reject the currently pending request if any
      if (this.currentRequestReject) {
        this.currentRequestReject(new Error('Socket closed unexpectedly.'))
        this.currentRequestResolve = null
        this.currentRequestReject = null
      }

      // Also reject all requests still in the queue
      while (this.requestQueue.length) {
        const req = this.requestQueue.shift()!
        clearTimeout(req.timeoutId)
        req.reject(new Error('Socket closed before request could complete.'))
      }

      this.processingRequest = false // Reset processing flag
    })

    // Handle socket errors
    socket.on('error', (error: any) => {
      console.error('[TcpClient] Socket error:', error.message)
      this.updateStatus('Error')

      // Reject the currently pending request
      if (this.currentRequestReject) {
        this.currentRequestReject(new Error(`Socket error during communication: ${error.message}`))
        this.currentRequestResolve = null
        this.currentRequestReject = null
      }

      // Initiate a full disconnect to clean up and allow for reconnect attempts
      this.disconnect()
    })
  }

  /**
   * Processes incoming data chunks received from the TCP socket.
   * It concatenates data to a buffer and attempts to extract and process
   * complete messages based on the 4-byte length prefix.
   * @param data The incoming data Buffer chunk.
   */
  private handleIncomingData(data: Buffer) {
    console.log(`[TcpClient] Received data chunk size: ${data.length} bytes`)

    // Efficiently append new data to the existing buffer
    this.receivedDataBuffer = Buffer.concat([this.receivedDataBuffer, data])
    console.log(`[TcpClient] Buffer size after append: ${this.receivedDataBuffer.length} bytes`)

    // Loop to process as many complete messages as possible from the buffer
    while (this.receivedDataBuffer.length >= 4) {
      // Read the 4-byte message length prefix (Little-Endian)
      const messageLength = this.receivedDataBuffer.readUInt32LE(0)

      // Defensive check: if messageLength is suspiciously large, it might indicate corrupted data
      // or a malicious payload. Disconnect to prevent resource exhaustion.
      if (messageLength > 10 * 1024 * 1024) { // Limit to 10MB message size
        console.error('[TcpClient] Message length too large, potential malformed data. Disconnecting.')
        this.disconnect() // Disconnect to reset state
        return // Stop processing this data stream
      }

      // Check if the entire message (length prefix + data) has been received yet
      if (this.receivedDataBuffer.length < 4 + messageLength) {
        // Not enough data for the full message; break loop and wait for more chunks
        break
      }

      // Extract the compressed message data (excluding the 4-byte length prefix)
      const compressedMessage = this.receivedDataBuffer.slice(4, 4 + messageLength)
      console.log(`[TcpClient] Extracted compressed message of size: ${compressedMessage.length} bytes`)

      try {
        // Decompress the message (assuming it was deflated)
        const decompressed = inflate(compressedMessage, { to: 'string' })
        console.log(`[TcpClient] Decompressed message size: ${decompressed.length} bytes`)

        // Parse the decompressed string as a JSON Response object
        const response: Response = JSON.parse(decompressed)
        console.log('[TcpClient] Parsed response:', response)

        // If there's a request waiting for this response, resolve its Promise
        if (this.currentRequestResolve) {
          this.currentRequestResolve(response) // Resolve the pending request
          // Clear the handlers for the completed request
          this.currentRequestResolve = null
          this.currentRequestReject = null
          this.processingRequest = false // Mark as no longer processing
          this.processQueue() // Immediately try to process the next request in the queue
        } else {
          // This should ideally not happen in a single-request-at-a-time model,
          // but serves as a safeguard against unexpected extra data.
          console.warn('[TcpClient] No request waiting for response, ignoring received message.')
        }
      } catch (e: any) {
        // Handle errors during decompression or JSON parsing
        console.error('[TcpClient] Error decompressing/parsing response:', e.message)
        if (this.currentRequestReject) {
          this.currentRequestReject(new Error(`Failed to parse response: ${e.message}`))
          // Clear handlers for the failed request
          this.currentRequestResolve = null
          this.currentRequestReject = null
          this.processingRequest = false // Mark as not processing
          this.processQueue() // Try to process the next request
        }
      }

      // Remove the processed message from the beginning of the buffer
      this.receivedDataBuffer = this.receivedDataBuffer.slice(4 + messageLength)
      console.log(`[TcpClient] Buffer size after processing message: ${this.receivedDataBuffer.length} bytes`)
    }
  }
}

// Dummy tcpClientInstance for build/export compatibility in certain environments (e.g., mocked builds).
// In a real application, you'd typically instantiate TcpClient where it's needed or manage a singleton.
export const tcpClientInstance: any = {}

/**
 * Mock function to simulate sending a prompt and receiving a response,
 * useful for testing components without a live TCP connection.
 * @param payload The mock request payload.
 * @returns A Promise that resolves with a mock Response after a delay.
 */
export const sendMockPrompt = async (payload: Request): Promise<Response> => {
  console.log('[Mock TCP Client] Mock prompt received:', payload.prompt)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        status: 'success',
        output: `Mock AI response to "${payload.prompt}" from model ${payload.model}. (Via Mock)`
      })
    }, 1000) // Simulate a 1-second delay for the mock response
  })
}

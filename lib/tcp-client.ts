// lib/tcp-client.ts
import TcpSocket from 'react-native-tcp-socket';
import * as pako from 'pako';
import { Buffer } from 'buffer';

// Polyfill for Buffer if not globally available
if (typeof global.Buffer === 'undefined') {
    global.Buffer = Buffer;
}

export interface Request {
  type: 'prompt';
  model: string;
  prompt: string;
  lora?: string;
}

export interface Response {
  status: 'success' | 'error';
  output?: string;
  error?: string;
}

export class TcpClient {
  private socket: TcpSocket.Socket | null = null;
  private receivedDataBuffer: Buffer = Buffer.alloc(0);
  private responseQueue: { resolve: (res: Response) => void, reject: (err: Error) => void }[] = [];

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = TcpSocket.createConnection({ host, port }, () => {
        console.log(`[TcpClient] Connected to ${host}:${port}`);
        resolve();
      });

      this.socket.on('error', (err: Error) => {
        console.error(`[TcpClient] Socket error: ${err.message}`);
        this.responseQueue.forEach(({ reject }) => reject(new Error(`Socket disconnected: ${err.message}`)));
        this.responseQueue = [];
        reject(err);
        this.disconnect();
      });

      this.socket.on('close', () => {
        console.log('[TcpClient] Socket closed.');
        this.responseQueue.forEach(({ reject }) => reject(new Error("Socket closed unexpectedly.")));
        this.responseQueue = [];
        this.socket = null;
      });

      this.socket.on('data', (data: Buffer) => {
        this.receivedDataBuffer = Buffer.concat([this.receivedDataBuffer, data]);
        this.processReceivedData();
      });
    });
  }

  private processReceivedData(): void {
    while (this.receivedDataBuffer.length >= 4 && this.responseQueue.length > 0) {
      const messageLength = this.receivedDataBuffer.readUInt32BE(0);
      if (this.receivedDataBuffer.length >= 4 + messageLength) {
        const compressedResponse = this.receivedDataBuffer.subarray(4, 4 + messageLength);
        this.receivedDataBuffer = this.receivedDataBuffer.subarray(4 + messageLength);
        const { resolve, reject } = this.responseQueue.shift()!;
        try {
          const decompressedString = pako.inflate(compressedResponse, { to: 'string' });
          resolve(JSON.parse(decompressedString));
        } catch (parseError: any) {
          reject(new Error(`Failed to parse response: ${parseError.message}`));
        }
      } else {
        break;
      }
    }
  }

  async send(request: Request): Promise<Response> {
    if (!this.socket) {
      throw new Error("[TcpClient] Not connected. Call connect() first.");
    }

    return new Promise(async (resolve, reject) => {
      this.responseQueue.push({ resolve, reject });
      try {
        const dataString = JSON.stringify(request);
        const compressedData = pako.deflate(dataString);
        console.log(`[TcpClient] Sending ${dataString.length} bytes (compressed to ${compressedData.length} bytes)`);
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32BE(compressedData.length, 0);
        this.socket.write(Buffer.concat([lengthBuffer, compressedData]));
        const timeout = setTimeout(() => {
          const index = this.responseQueue.findIndex(p => p.resolve === resolve);
          if (index !== -1) {
              this.responseQueue.splice(index, 1);
              reject(new Error("Response timeout."));
          }
        }, 15000);
      } catch (error: any) {
        const index = this.responseQueue.findIndex(p => p.resolve === resolve);
        if (index !== -1) {
            this.responseQueue.splice(index, 1);
        }
        reject(new Error(`Failed to send request: ${error.message}`));
      }
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      this.receivedDataBuffer = Buffer.alloc(0);
      this.responseQueue.forEach(({ reject }) => reject(new Error("Client disconnected.")));
      this.responseQueue = [];
    }
  }
}

export async function sendMockPrompt(model: string, prompt: string, lora?: string): Promise<string> {
  const request: Request = { type: 'prompt', model, prompt, lora };
  const dataString = JSON.stringify(request);
  const compressed = pako.deflate(dataString);
  console.log(`[Mock Send] Original: ${dataString.length} bytes, Compressed: ${compressed.length} bytes`);
  return new Promise(resolve => {
    setTimeout(() => {
      const mockOutput = `Mock response from ${model}: "${prompt}" (LoRA: ${lora || 'none'})`;
      const mockResponse: Response = { status: 'success', output: mockOutput };
      const mockResponseString = JSON.stringify(mockResponse);
      const mockCompressedResponse = pako.deflate(mockResponseString);
      console.log(`[Mock Recv] Mock response size: ${mockResponseString.length} bytes, Compressed: ${mockCompressedResponse.length} bytes`);
      resolve(mockOutput);
    }, 800);
  });
}

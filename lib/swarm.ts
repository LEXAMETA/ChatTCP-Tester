export interface Peer {
  ip: string;
  port: number;
  model: string; // The primary model hosted by this peer
  loras?: string[]; // Optional: list of LoRA IDs this peer can serve
  load?: number; // Optional: Simulated load factor (0.0 - 1.0)
  lastSeen?: number; // Timestamp of last seen for freshness
  // Future: version info, capabilities (e.g., hasGPU)
}

// Mock list of peers for testing the UI and client logic
export const mockPeers: Peer[] = [
  {
    ip: '192.168.49.2',
    port: 8080,
    model: 'qwen3',
    loras: ['math_specialist', 'code_expert'],
    load: 0.2,
    lastSeen: Date.now(),
  },
  {
    ip: '192.168.49.3',
    port: 8080,
    model: 'osmosis',
    loras: ['creative_writer'],
    load: 0.5,
    lastSeen: Date.now() - 30000, // 30s ago
  },
  {
    ip: '192.168.49.4',
    port: 8080,
    model: 'qwen3',
    loras: [],
    load: 0.1,
    lastSeen: Date.now(),
  },
  {
    ip: '192.168.49.5',
    port: 8080,
    model: 'llama3',
    loras: ['dutch_translator'],
    load: 0.8,
    lastSeen: Date.now() - 60000, // 1min ago
  },
];

export async function discoverPeers(): Promise<Peer[]> {
  console.log('[Swarm] Mock peer discovery initiated.');
  // Simulate a network discovery delay
  return new Promise((resolve) => {
    setTimeout(() => {
      // In a real scenario, this would use WifiP2pManager, mDNS, or a central server
      console.log('[Swarm] Mock peers discovered:', mockPeers);
      resolve(mockPeers);
    }, 1500); // Simulate 1.5-second discovery time
  });
}

// Future functions (stubs, uncomment and implement if needed):
// export async function getPeerLoad(ip: string): Promise<number> { /* ... */ }
// export async function transferLoRA(peer: Peer, loraData: Buffer): Promise<boolean> { /* ... */ }

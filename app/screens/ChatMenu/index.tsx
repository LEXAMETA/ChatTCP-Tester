// app/screens/ChatMenu/index.tsx
import React, { useState, useEffect, useRef } from 'react';
import { 
  View, Text, TextInput, Button, StyleSheet, ScrollView, 
  ActivityIndicator, Alert, Platform, SafeAreaView 
} from 'react-native';
import Drawer from '@components/views/Drawer';
import HeaderButton from '@components/views/HeaderButton';
import HeaderTitle from '@components/views/HeaderTitle';
import { Characters } from '@lib/state/Characters';
import { Chats } from '@lib/state/Chat';
import { Theme } from '@lib/theme/ThemeManager';
import AvatarViewer from '@screens/ChatMenu/ChatWindow/AvatarViewer';
import ChatWindow from '@screens/ChatMenu/ChatWindow/ChatWindow';
import ChatsDrawer from '@screens/ChatMenu/ChatsDrawer';
import OptionsMenu from '@screens/ChatMenu/OptionsMenu';
import SettingsDrawer from '@screens/SettingsDrawer';
import { useShallow } from 'zustand/react/shallow';
import { discoverPeers, Peer } from '../../../lib/swarm';
import { TcpClient, sendMockPrompt } from '../../../lib/tcp-client';
import { Picker } from '@react-native-picker/picker';

const ChatMenu = () => {
  // Existing state from second component
  const { spacing } = Theme.useTheme();
  const { unloadCharacter } = Characters.useCharacterCard(
    useShallow((state) => ({
      unloadCharacter: state.unloadCard,
    }))
  );
  const { chat, unloadChat } = Chats.useChat();
  const { showSettings, showChats } = Drawer.useDrawerState((state) => ({
    showSettings: state.values?.[Drawer.ID.SETTINGS],
    showChats: state.values?.[Drawer.ID.CHATLIST],
  }));

  // Swarm Chat state from first component
  const [availablePeers, setAvailablePeers] = useState<Peer[]>([]);
  const [selectedPeerIp, setSelectedPeerIp] = useState<string>('');
  const [selectedLoRA, setSelectedLoRA] = useState<string>('');
  const [swarmChatPrompt, setSwarmChatPrompt] = useState('');
  const [swarmChatResponse, setSwarmChatResponse] = useState<string[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [tcpClientInstance, setTcpClientInstance] = useState<TcpClient | null>(null);
  const [chatMode, setChatMode] = useState<'character' | 'swarm'>('character');
  const scrollViewRef = useRef<ScrollView>(null);

  // Effects for Swarm Chat
  useEffect(() => {
    const fetchPeers = async () => {
      if (chatMode !== 'swarm') return;
      
      setSwarmChatResponse(prev => [...prev, "Discovering peers..."]);
      try {
        const peers = await discoverPeers();
        setAvailablePeers(peers);
        if (peers.length > 0) {
          const initialPeer = peers.sort((a, b) => (a.load || 0) - (b.load || 0))[0];
          setSelectedPeerIp(initialPeer.ip);
          if (initialPeer.loras?.length > 0) {
            setSelectedLoRA(initialPeer.loras[0]);
          }
          setSwarmChatResponse(prev => [...prev, `Discovered ${peers.length} peers.`]);
        } else {
          setSwarmChatResponse(prev => [...prev, "No peers discovered."]);
        }
      } catch (error: any) {
        setSwarmChatResponse(prev => [...prev, `Peer discovery error: ${error.message}`]);
        Alert.alert("Peer Discovery Error", `Failed to discover peers: ${error.message}`);
      }
    };
    
    fetchPeers();

    return () => {
      tcpClientInstance?.disconnect();
      unloadCharacter();
      unloadChat();
    };
  }, [chatMode]);

  useEffect(() => {
    const connectClient = async () => {
      if (selectedPeerIp && chatMode === 'swarm') {
        if (tcpClientInstance) {
          tcpClientInstance.disconnect();
        }
        const peer = availablePeers.find(p => p.ip === selectedPeerIp);
        if (peer) {
          setIsConnecting(true);
          setSwarmChatResponse(prev => [...prev, `Connecting to ${peer.ip}:${peer.port}...`]);
          const client = new TcpClient();
          try {
            await client.connect(peer.ip, peer.port);
            setTcpClientInstance(client);
            setSwarmChatResponse(prev => [...prev, `Connected to ${peer.ip}`]);
          } catch (error: any) {
            setSwarmChatResponse(prev => [...prev, `Connection failed: ${error.message}`]);
            Alert.alert("Connection Error", `Failed to connect to ${peer.ip}`);
          } finally {
            setIsConnecting(false);
          }
        }
      }
    };
    
    connectClient();
  }, [selectedPeerIp, availablePeers, chatMode]);

  // Swarm Chat handler
  const handleSwarmChatSend = async () => {
    if (!swarmChatPrompt.trim()) return;

    const currentPeer = availablePeers.find(p => p.ip === selectedPeerIp);
    if (!currentPeer) {
      setSwarmChatResponse(prev => [...prev, "Error: No peer selected."]);
      Alert.alert("Send Error", "Please select a peer before sending.");
      return;
    }

    const message = `You: ${swarmChatPrompt}`;
    setSwarmChatResponse(prev => [...prev, message]);
    setSwarmChatPrompt('');

    setIsSending(true);
    try {
      const response = await sendMockPrompt(currentPeer.model, swarmChatPrompt, selectedLoRA || undefined);
      setSwarmChatResponse(prev => [...prev, `AI (${currentPeer.model} @ ${currentPeer.ip}): ${response}`]);
    } catch (error: any) {
      setSwarmChatResponse(prev => [...prev, `AI Error: ${error.message}`]);
      Alert.alert("Send Failed", `Could not get response: ${error.message}`);
    } finally {
      setIsSending(false);
    }
  };

  const currentSelectedPeer = availablePeers.find(p => p.ip === selectedPeerIp);

  return (
    <Drawer.Gesture
      config={[
        { drawerID: Drawer.ID.CHATLIST, openDirection: 'left', closeDirection: 'right' },
        { drawerID: Drawer.ID.SETTINGS, openDirection: 'right', closeDirection: 'left' },
      ]}
    >
      <SafeAreaView style={{ flex: 1, flexDirection: 'row' }}>
        <HeaderTitle />
        <HeaderButton
          headerLeft={() => !showChats && <Drawer.Button drawerID={Drawer.ID.SETTINGS} />}
          headerRight={() => (
            <>
              <Button
                title={chatMode === 'character' ? 'Switch to Swarm' : 'Switch to Character'}
                onPress={() => setChatMode(prev => prev === 'character' ? 'swarm' : 'character')}
              />
              {!showSettings && (
                <Drawer.Button drawerID={Drawer.ID.CHATLIST} openIcon="message1" />
              )}
            </>
          )}
        />

        <View style={{ flex: 1 }}>
          {chatMode === 'character' ? (
            <>
              {chat && <ChatWindow />}
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginVertical: spacing.m,
                paddingHorizontal: spacing.l,
              }}>
                <AvatarViewer />
                <OptionsMenu />
                {/* Character ChatInput would go here */}
              </View>
            </>
          ) : (
            <View style={styles.container}>
              {/* Swarm Chat UI */}
              <View style={styles.swarmHeader}>
                <Text style={styles.swarmTitle}>Swarm AI Chat</Text>
                <Button
                  title="Refresh Peers"
                  onPress={() => discoverPeers().then(setAvailablePeers)}
                  disabled={isConnecting || isSending}
                />
              </View>

              <Text style={styles.label}>Target Peer & Model:</Text>
              {isConnecting ? (
                <ActivityIndicator size="small" color="#0000ff" style={styles.loadingIndicator} />
              ) : (
                <Picker
                  selectedValue={selectedPeerIp}
                  onValueChange={setSelectedPeerIp}
                  style={styles.picker}
                  enabled={!isSending}
                >
                  {availablePeers.length > 0 ? (
                    availablePeers.map(peer => (
                      <Picker.Item
                        key={peer.ip}
                        label={`${peer.model} (${peer.ip}) Load: ${(peer.load * 100).toFixed(0)}%`}
                        value={peer.ip}
                      />
                    ))
                  ) : (
                    <Picker.Item label="Searching for peers..." value="" />
                  )}
                </Picker>
              )}

              {currentSelectedPeer?.loras?.length > 0 && (
                <>
                  <Text style={styles.label}>Select LoRA Adapter:</Text>
                  <Picker
                    selectedValue={selectedLoRA}
                    onValueChange={setSelectedLoRA}
                    style={styles.picker}
                    enabled={!isSending}
                  >
                    <Picker.Item label="No LoRA (Base Model)" value="" />
                    {currentSelectedPeer.loras.map(lora => (
                      <Picker.Item key={lora} label={lora} value={lora} />
                    ))}
                  </Picker>
                </>
              )}

              <ScrollView style={styles.chatOutput} ref={scrollViewRef}>
                {swarmChatResponse.map((msg, index) => (
                  <Text key={index} style={styles.chatMessage}>{msg}</Text>
                ))}
              </ScrollView>

              <View style={styles.chatInputContainer}>
                <TextInput
                  style={styles.chatTextInput}
                  placeholder="Type your message to the swarm..."
                  value={swarmChatPrompt}
                  onChangeText={setSwarmChatPrompt}
                  multiline
                  editable={!isSending && !isConnecting && !!selectedPeerIp}
                />
                <Button
                  title={isSending ? "Sending..." : "Send to Swarm"}
                  onPress={handleSwarmChatSend}
                  disabled={isSending || isConnecting || !selectedPeerIp || !swarmChatPrompt.trim()}
                />
              </View>
            </View>
          )}
        </View>

        <ChatsDrawer />
        <SettingsDrawer />
      </SafeAreaView>
    </Drawer.Gesture>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
    backgroundColor: '#f5f5f5',
  },
  swarmHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  swarmTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  label: {
    fontSize: 14,
    marginBottom: 5,
    color: '#555',
  },
  picker: {
    height: Platform.OS === 'ios' ? 150 : 50,
    width: '100%',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 4,
    backgroundColor: '#fff',
    ...(Platform.OS === 'android' && { backgroundColor: '#fff', color: '#333' }),
  },
  loadingIndicator: {
    marginVertical: 10,
  },
  chatOutput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#eee',
  },
  chatMessage: {
    fontSize: 15,
    marginBottom: 5,
    color: '#333',
  },
  chatInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 10,
  },
  chatTextInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 20,
    padding: 10,
    marginRight: 10,
    minHeight: 40,
    backgroundColor: '#fff',
    fontSize: 16,
    color: '#333',
  },
});

export default ChatMenu;

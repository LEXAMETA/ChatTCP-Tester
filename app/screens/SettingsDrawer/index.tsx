// app/screens/SettingsDrawer/index.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';

import SupportButton from '@components/buttons/SupportButton';
import Drawer from '@components/views/Drawer';
import { AppSettings } from '@lib/constants/GlobalValues';
import { Theme } from '@lib/theme/ThemeManager';
import appConfig from 'app.config';
import { useMMKVBoolean } from 'react-native-mmkv';

import AppModeToggle from './AppModeToggle';
import RouteList from './RouteList';
import UserInfo from './UserInfo';

import { sendMockPrompt } from '../../../lib/tcp-client';

const SettingsDrawer = () => {
  const { color, spacing } = Theme.useTheme();
  const [devMode] = useMMKVBoolean(AppSettings.DevMode);

  // TCP test states
  const [tcpTestPrompt, setTcpTestPrompt] = useState('');
  const [tcpTestResponse, setTcpTestResponse] = useState('Awaiting TCP test...');
  const [tcpTestModel, setTcpTestModel] = useState('qwen3');
  const [tcpTestLoRA, setTcpTestLoRA] = useState('math_specialist');
  const [isTestingTcp, setIsTestingTcp] = useState(false);

  const handleTcpTest = async () => {
    if (isTestingTcp) return;
    setTcpTestResponse('Sending request via mock TCP...');
    setIsTestingTcp(true);
    try {
      const output = await sendMockPrompt(tcpTestModel, tcpTestPrompt, tcpTestLoRA);
      setTcpTestResponse(output);
    } catch (error: any) {
      setTcpTestResponse(`Error: ${error.message}`);
      console.error('TCP test error:', error);
      Alert.alert('TCP Test Error', `Failed to send mock prompt: ${error.message}`);
    } finally {
      setIsTestingTcp(false);
    }
  };

  return (
    <Drawer.Body
      drawerID={Drawer.ID.SETTINGS}
      drawerStyle={{
        width: '60%',
        paddingBottom: spacing.xl2,
      }}
    >
      <ScrollView style={styles.container}>
        {/* Existing UI sections */}
        <UserInfo />
        <AppModeToggle />
        <RouteList />

        <Text
          style={{
            alignSelf: 'center',
            color: color.text._300,
            marginTop: spacing.l,
            marginBottom: spacing.xl2,
          }}
        >
          {__DEV__ && 'DEV BUILD\t'}
          {devMode && 'DEV MODE\t'}
          {'v' + appConfig.expo.version}
        </Text>

        <View style={{ marginHorizontal: spacing.xl2, marginBottom: spacing.xl2 }}>
          <SupportButton />
        </View>

        {/* New Swarm TCP Test Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Custom Swarm TCP Layer Test</Text>

          <TextInput
            style={styles.input}
            placeholder="Model (e.g., qwen3)"
            value={tcpTestModel}
            onChangeText={setTcpTestModel}
            editable={!isTestingTcp}
          />
          <TextInput
            style={styles.input}
            placeholder="LoRA ID (optional)"
            value={tcpTestLoRA}
            onChangeText={setTcpTestLoRA}
            editable={!isTestingTcp}
          />
          <TextInput
            style={[styles.input, { height: 80 }]}
            placeholder="Enter prompt for TCP communication test"
            value={tcpTestPrompt}
            onChangeText={setTcpTestPrompt}
            multiline
            editable={!isTestingTcp}
          />
          <Button
            title={isTestingTcp ? 'Testing...' : 'Test Swarm TCP Comm'}
            onPress={handleTcpTest}
            disabled={isTestingTcp}
          />
          <Text style={styles.responseLabel}>Latest Response:</Text>
          <Text style={styles.responseText}>{tcpTestResponse}</Text>
        </View>
      </ScrollView>
    </Drawer.Body>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 15,
  },
  section: {
    marginTop: 20,
    padding: 10,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    backgroundColor: '#f9f9f9',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 8,
    marginBottom: 10,
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#333',
  },
  responseLabel: {
    marginTop: 10,
    fontWeight: 'bold',
    color: '#555',
  },
  responseText: {
    backgroundColor: '#eee',
    padding: 10,
    borderRadius: 4,
    marginTop: 5,
    maxHeight: 200,
    overflow: 'scroll',
    color: '#333',
    fontSize: 14,
  },
});

export default SettingsDrawer;

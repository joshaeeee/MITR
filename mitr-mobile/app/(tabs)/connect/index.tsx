import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Animated,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Send,
  Mic,
  Clock,
  MessageCircle,
  Volume2,
  CheckCheck,
  AlertCircle,
  Loader,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import StatusBadge from '@/components/StatusBadge';
import SectionHeader from '@/components/SectionHeader';
import { NudgePriority, NudgeDeliveryState } from '@/constants/types';
import { useNudges, useSendNudge } from '@/lib/api';

const priorityColors: Record<NudgePriority, { bg: string; text: string; label: string }> = {
  gentle: { bg: Colors.mintLight, text: Colors.mintDark, label: 'Gentle' },
  important: { bg: Colors.warningLight, text: Colors.warning, label: 'Important' },
  urgent: { bg: Colors.dangerLight, text: Colors.danger, label: 'Urgent' },
};

const deliveryIcons: Record<NudgeDeliveryState, React.ReactNode> = {
  queued: <Clock size={14} color={Colors.textTertiary} />,
  delivering: <Loader size={14} color={Colors.skyDark} />,
  delivered: <CheckCheck size={14} color={Colors.mintDark} />,
  acknowledged: <CheckCheck size={14} color={Colors.lavenderDark} />,
  failed: <AlertCircle size={14} color={Colors.danger} />,
};

export default function ConnectScreen() {
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<NudgePriority>('gentle');
  const [isRecording, setIsRecording] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const recordPulse = useRef(new Animated.Value(1)).current;
  const { data: nudges = [] } = useNudges();
  const sendNudge = useSendNudge();

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(recordPulse, {
            toValue: 1.15,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(recordPulse, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      recordPulse.setValue(1);
    }
  }, [isRecording]);

  const handleSend = async () => {
    if (!message.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await sendNudge.mutateAsync({ text: message.trim(), priority });
      Alert.alert('Nudge sent', `"${message}" sent as ${priority} nudge.`);
      setMessage('');
    } catch (error) {
      Alert.alert('Send failed', (error as Error).message);
    }
  };

  const handleVoice = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (isRecording) {
      setIsRecording(false);
      try {
        await sendNudge.mutateAsync({
          voiceUrl: `voice-note://${Date.now()}`,
          priority
        });
        Alert.alert('Voice note', 'Voice note queued for delivery.');
      } catch (error) {
        Alert.alert('Voice note failed', (error as Error).message);
      }
    } else {
      setIsRecording(true);
    }
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
          <KeyboardAvoidingView
            style={styles.keyboardView}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={100}
          >
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
              <View style={styles.header}>
                <Text style={styles.title}>Connect</Text>
                <Text style={styles.subtitle}>Send a nudge or voice note to Kamla Devi</Text>
              </View>

              <PastelCard color="white" style={styles.composeCard}>
                <View style={styles.priorityRow}>
                  {(['gentle', 'important', 'urgent'] as NudgePriority[]).map((p) => (
                    <TouchableOpacity
                      key={p}
                      style={[
                        styles.priorityChip,
                        { backgroundColor: priority === p ? priorityColors[p].bg : Colors.surfaceAlt },
                      ]}
                      onPress={() => {
                        setPriority(p);
                        Haptics.selectionAsync();
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.priorityText,
                          { color: priority === p ? priorityColors[p].text : Colors.textTertiary },
                        ]}
                      >
                        {priorityColors[p].label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.input}
                    placeholder="Write a gentle nudge..."
                    placeholderTextColor={Colors.textTertiary}
                    value={message}
                    onChangeText={setMessage}
                    multiline
                    maxLength={200}
                  />
                </View>

                <View style={styles.composeActions}>
                  <TouchableOpacity
                    style={[styles.sendBtn, !message.trim() && styles.sendBtnDisabled]}
                    onPress={handleSend}
                    disabled={!message.trim()}
                    activeOpacity={0.7}
                  >
                    <Send size={18} color={message.trim() ? Colors.white : Colors.textTertiary} />
                    <Text
                      style={[styles.sendBtnText, !message.trim() && styles.sendBtnTextDisabled]}
                    >
                      Send nudge
                    </Text>
                  </TouchableOpacity>

                  <Animated.View style={{ transform: [{ scale: recordPulse }] }}>
                    <TouchableOpacity
                      style={[styles.voiceBtn, isRecording && styles.voiceBtnActive]}
                      onPress={handleVoice}
                      activeOpacity={0.7}
                    >
                      <Mic size={20} color={isRecording ? Colors.white : Colors.lavenderDark} />
                    </TouchableOpacity>
                  </Animated.View>
                </View>
              </PastelCard>

              <SectionHeader title="Nudge history" />
              <View style={styles.historyList}>
                {nudges.map((nudge) => (
                  <PastelCard key={nudge.id} color="white" style={styles.nudgeCard}>
                    <View style={styles.nudgeRow}>
                      <View
                        style={[
                          styles.nudgeIcon,
                          {
                            backgroundColor:
                              nudge.type === 'voice' ? Colors.lavenderLight : Colors.skyLight,
                          },
                        ]}
                      >
                        {nudge.type === 'voice' ? (
                          <Volume2 size={16} color={Colors.lavenderDark} />
                        ) : (
                          <MessageCircle size={16} color={Colors.skyDark} />
                        )}
                      </View>
                      <View style={styles.nudgeContent}>
                        <View style={styles.nudgeHeader}>
                          <Text style={styles.nudgeSender}>{nudge.senderName}</Text>
                          <View style={styles.nudgeMeta}>
                            {deliveryIcons[nudge.deliveryState]}
                            <StatusBadge type="delivery" value={nudge.deliveryState} size="small" />
                          </View>
                        </View>
                        <Text style={styles.nudgeMessage} numberOfLines={2}>
                          {nudge.message}
                        </Text>
                        <View style={styles.nudgeFooter}>
                          <View
                            style={[
                              styles.nudgePriority,
                              { backgroundColor: priorityColors[nudge.priority].bg },
                            ]}
                          >
                            <Text
                              style={[
                                styles.nudgePriorityText,
                                { color: priorityColors[nudge.priority].text },
                              ]}
                            >
                              {priorityColors[nudge.priority].label}
                            </Text>
                          </View>
                          <Text style={styles.nudgeTime}>
                            {new Date(nudge.sentAt).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </PastelCard>
                ))}
              </View>

              <View style={styles.bottomSpacer} />
            </ScrollView>
          </KeyboardAvoidingView>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 30,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  composeCard: {
    marginHorizontal: 20,
    marginBottom: 28,
  },
  priorityRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  priorityChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  priorityText: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
  inputRow: {
    marginBottom: 14,
  },
  input: {
    fontSize: 15,
    color: Colors.text,
    minHeight: 60,
    maxHeight: 100,
    textAlignVertical: 'top',
    padding: 0,
    lineHeight: 22,
  },
  composeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sendBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.text,
    borderRadius: 14,
    paddingVertical: 14,
  },
  sendBtnDisabled: {
    backgroundColor: Colors.surfaceAlt,
  },
  sendBtnText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  sendBtnTextDisabled: {
    color: Colors.textTertiary,
  },
  voiceBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.lavenderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceBtnActive: {
    backgroundColor: Colors.danger,
  },
  historyList: {
    paddingHorizontal: 20,
    gap: 10,
  },
  nudgeCard: {},
  nudgeRow: {
    flexDirection: 'row',
    gap: 12,
  },
  nudgeIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nudgeContent: {
    flex: 1,
  },
  nudgeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  nudgeSender: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  nudgeMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nudgeMessage: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: 6,
  },
  nudgeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nudgePriority: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  nudgePriorityText: {
    fontSize: 10,
    fontWeight: '600' as const,
  },
  nudgeTime: {
    fontSize: 11,
    color: Colors.textTertiary,
  },
  bottomSpacer: {
    height: 20,
  },
});

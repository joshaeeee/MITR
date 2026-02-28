import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Alert,
} from 'react-native';
import { Stack } from 'expo-router';
import {
  Crown,
  UserPlus,
  MoreVertical,
  Mail,
  Phone,
  Clock,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Colors from '@/constants/colors';
import PastelCard from '@/components/PastelCard';
import { useFamilyMembers, useInviteFamilyMember, useRemoveFamilyMember, useUpdateFamilyRole } from '@/lib/api';

const roleColors = {
  owner: { bg: Colors.peachLight, text: Colors.peachDark },
  member: { bg: Colors.skyLight, text: Colors.skyDark },
};

export default function FamilyMembersScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { data: familyMembers = [] } = useFamilyMembers();
  const inviteMember = useInviteFamilyMember();
  const updateRole = useUpdateFamilyRole();
  const removeMember = useRemoveFamilyMember();

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleInvite = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await inviteMember.mutateAsync({
        displayName: 'New Member',
        email: `family${Date.now()}@example.com`,
        role: 'member'
      });
      Alert.alert('Invite sent', 'A family invite was created.');
    } catch (error) {
      Alert.alert('Invite failed', (error as Error).message);
    }
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: 'Family Members' }} />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <View style={styles.memberList}>
            {familyMembers.map((member) => (
              <PastelCard key={member.id} color="white" style={styles.memberCard}>
                <View style={styles.memberRow}>
                  <View
                    style={[
                      styles.avatar,
                      {
                        backgroundColor:
                          member.role === 'owner' ? Colors.peachLight : Colors.skyLight,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.avatarText,
                        {
                          color:
                            member.role === 'owner' ? Colors.peachDark : Colors.skyDark,
                        },
                      ]}
                    >
                      {member.name.charAt(0)}
                    </Text>
                  </View>
                  <View style={styles.memberInfo}>
                    <View style={styles.memberNameRow}>
                      <Text style={styles.memberName}>{member.name}</Text>
                      {member.role === 'owner' && (
                        <Crown size={14} color={Colors.peachDark} />
                      )}
                    </View>
                    <Text style={styles.memberRelation}>{member.relation}</Text>
                    <View style={styles.memberMeta}>
                      <View
                        style={[
                          styles.roleBadge,
                          { backgroundColor: roleColors[member.role].bg },
                        ]}
                      >
                        <Text
                          style={[
                            styles.roleText,
                            { color: roleColors[member.role].text },
                          ]}
                        >
                          {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                        </Text>
                      </View>
                      {member.inviteStatus === 'pending' && (
                        <View style={styles.pendingBadge}>
                          <Clock size={10} color={Colors.warning} />
                          <Text style={styles.pendingText}>Pending</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.moreBtn}
                    onPress={() => {
                      Alert.alert(member.name, 'Manage member options', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Change role',
                          onPress: () => {
                            const nextRole = member.role === 'owner' ? 'member' : 'owner';
                            void updateRole.mutateAsync({ id: member.id, role: nextRole });
                          }
                        },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => {
                            void removeMember.mutateAsync(member.id);
                          },
                        },
                      ]);
                    }}
                    activeOpacity={0.6}
                  >
                    <MoreVertical size={20} color={Colors.textTertiary} />
                  </TouchableOpacity>
                </View>

                <View style={styles.contactRow}>
                  <View style={styles.contactItem}>
                    <Mail size={13} color={Colors.textTertiary} />
                    <Text style={styles.contactText}>{member.email}</Text>
                  </View>
                  <View style={styles.contactItem}>
                    <Phone size={13} color={Colors.textTertiary} />
                    <Text style={styles.contactText}>{member.phone}</Text>
                  </View>
                </View>
              </PastelCard>
            ))}
          </View>

          <TouchableOpacity
            style={styles.inviteBtn}
            onPress={handleInvite}
            activeOpacity={0.7}
          >
            <UserPlus size={20} color={Colors.white} />
            <Text style={styles.inviteBtnText}>Invite family member</Text>
          </TouchableOpacity>

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 30,
    paddingTop: 14,
  },
  memberList: {
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 24,
  },
  memberCard: {},
  memberRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    marginBottom: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700' as const,
  },
  memberInfo: {
    flex: 1,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  memberRelation: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  memberMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  roleBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  roleText: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: Colors.warningLight,
  },
  pendingText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: Colors.warning,
  },
  moreBtn: {
    padding: 4,
  },
  contactRow: {
    flexDirection: 'row',
    gap: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  contactText: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.text,
    marginHorizontal: 20,
    borderRadius: 16,
    paddingVertical: 16,
  },
  inviteBtnText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  bottomSpacer: {
    height: 20,
  },
});

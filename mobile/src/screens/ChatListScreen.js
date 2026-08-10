import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { fetchConversations, normalizeUser } from '../services/api';
import { colors, fonts, radius } from '../theme';

export default function ChatListScreen({ navigation }) {
  const { currentUser, logout } = useAuth();
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchConversations()
      .then(list => setUsers(list.map(c => ({ ...normalizeUser(c.user), unread: c.unread }))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Refresh every time the list screen regains focus (e.g. coming back from
  // a chat where new messages may have changed unread counts/ordering).
  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  return (
    <View style={styles.container}>
      <FlatList
        data={users}
        keyExtractor={(u) => u.id}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={users.length === 0 ? styles.emptyList : undefined}
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <FontAwesome6 name="comment-dots" size={28} color={colors.t3} />
              <Text style={styles.emptyText}>هنوز گفتگویی نداری</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => navigation.navigate('Chat', { peer: item })}
          >
            <View style={styles.avatarWrap}>
              {item.avatar
                ? <Image source={{ uri: item.avatar }} style={styles.avatar} />
                : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <FontAwesome6 name="user" size={16} color={colors.t2} />
                  </View>
                )}
              <View style={[styles.dot, { backgroundColor: item.status === 'online' ? colors.green : colors.t3 }]} />
            </View>

            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>

            {item.unread > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.unread}</Text>
              </View>
            )}
          </Pressable>
        )}
      />

      <View style={styles.footer}>
        <View style={styles.footerUser}>
          {currentUser?.avatar
            ? <Image source={{ uri: currentUser.avatar }} style={styles.footerAvatar} />
            : (
              <View style={[styles.footerAvatar, styles.avatarFallback]}>
                <FontAwesome6 name="user" size={13} color={colors.t2} />
              </View>
            )}
          <Text style={styles.myName} numberOfLines={1}>{currentUser?.name}</Text>
        </View>
        <Pressable onPress={logout} hitSlop={10}>
          <FontAwesome6 name="right-from-bracket" size={16} color={colors.t2} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.s0 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 16, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.s2 },

  avatarWrap: { width: 44, height: 44 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { backgroundColor: colors.s2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  dot: { position: 'absolute', bottom: 0, left: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.s0 },

  name: { flex: 1, color: colors.t1, fontFamily: fonts.medium, fontSize: 14, textAlign: 'right' },

  badge: { backgroundColor: colors.accent, minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { color: '#fff', fontFamily: fonts.semibold, fontSize: 11 },

  emptyList: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 100, gap: 12 },
  emptyText: { color: colors.t3, fontFamily: fonts.regular, fontSize: 13 },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border,
  },
  footerUser: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  footerAvatar: { width: 30, height: 30, borderRadius: 15 },
  myName: { color: colors.t1, fontFamily: fonts.semibold, fontSize: 13 },
});

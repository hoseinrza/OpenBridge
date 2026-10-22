import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import Avatar from '../components/Avatar';
import {
  fetchE2eeState, fetchShared, fetchUser, normalizeGroup, normalizeUser, resolveUrl, updateGroup,
} from '../services/api';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import { formatDayLabel } from '../utils/time';
import { fa, formatSize } from '../utils/persian';

const TABS = [
  { kind: 'media', label: 'رسانه',   icon: 'photo-film', empty: 'تصویری در این گفتگو نیست' },
  { kind: 'files', label: 'فایل‌ها', icon: 'file-lines', empty: 'فایلی در این گفتگو نیست' },
  { kind: 'links', label: 'لینک‌ها', icon: 'link',       empty: 'لینکی در این گفتگو نیست' },
];
const ROLE_TEXT = { OWNER: 'مالک', ADMIN: 'مدیر' };
// The same bounds the server enforces on PATCH /messages/groups/:id, so a draft
// that cannot be saved is caught before the round trip.
const NAME_MIN = 2;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 205;

function pageState() {
  return { status: 'loading', items: [], cursor: null, error: '' };
}

function longDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
}

function hostOf(url) {
  return String(url ?? '').replace(/^https?:\/\//, '').split('/')[0];
}

export default function ChatProfileScreen({ route }) {
  const peer = route.params?.peer;
  const { currentUser } = useAuth();
  const { socket } = useSocket();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [profile,   setProfile]   = useState(peer);
  const [locked,    setLocked]    = useState(peer?.encrypted === true);
  const [tab,       setTab]       = useState('media');
  const [pages,     setPages]     = useState({});
  const [viewer,    setViewer]    = useState(null);
  const [editing,   setEditing]   = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftBio,  setDraftBio]  = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const styles = useMemo(() => makeStyles(colors, insets), [colors, insets]);
  const isGroup = profile?.kind === 'group';
  const myRole = isGroup
    ? profile.participants?.find(p => p.id === currentUser?.id)?.role ?? 'MEMBER'
    : null;
  const canEdit = isGroup && (myRole === 'OWNER' || myRole === 'ADMIN');

  // A profile opens on the row the chat list already carries, then asks the
  // server for the fields a list row leaves out — a contact's bio and the day
  // the account joined.
  useEffect(() => {
    let cancelled = false;
    setProfile(peer);
    setPages({});
    setTab('media');
    setEditing(false);
    setError('');
    if (!peer) return undefined;
    if (peer.kind === 'group') return undefined;
    fetchUser(peer.id)
      .then(user => { if (!cancelled && user) setProfile(normalizeUser(user)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [peer?.id]);

  // The conversation may have become encrypted since this device last looked.
  useEffect(() => {
    let cancelled = false;
    setLocked(peer?.encrypted === true);
    if (!peer) return undefined;
    fetchE2eeState(peer)
      .then(state => { if (!cancelled) setLocked(state?.e2ee === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [peer?.id, peer?.encrypted]);

  // A rename done elsewhere should not leave this screen showing the old name.
  useEffect(() => {
    if (!socket || !isGroup) return undefined;
    const onUpdated = (payload) => {
      if (payload?.id !== peer?.id) return;
      setProfile(prev => (prev ? {
        ...prev,
        name:        payload.name ?? prev.name,
        description: payload.description ?? '',
        avatar:      resolveUrl(payload.avatar),
      } : prev));
    };
    socket.on('group:updated', onUpdated);
    return () => socket.off('group:updated', onUpdated);
  }, [socket, isGroup, peer?.id]);

  const loadPage = useCallback(async (kind, before) => {
    if (!peer) return;
    setPages(prev => ({ ...prev, [kind]: { ...(prev[kind] ?? pageState()), status: before ? 'more' : 'loading' } }));
    try {
      const data = await fetchShared(peer.id, kind, before);
      const items = (data.items ?? []).map(item => ({
        ...item,
        // The server signs upload paths relative to the API; a link is already
        // an absolute address and has nothing to resolve.
        src:    item.kind === 'link' ? undefined : resolveUrl(item.url),
        sender: item.sender?.name ?? null,
      }));
      setPages(prev => {
        const was = prev[kind] ?? pageState();
        return {
          ...prev,
          [kind]: {
            status: 'ready',
            items:    before ? [...was.items, ...items] : items,
            cursor:   data.nextCursor ?? null,
            error:    '',
          },
        };
      });
    } catch (err) {
      setPages(prev => ({
        ...prev,
        [kind]: { ...(prev[kind] ?? pageState()), status: 'error', error: err.message || 'دریافت فهرست ناموفق بود' },
      }));
    }
  }, [peer?.id]);

  // A tab is fetched the first time it is opened, never all three at once.
  useEffect(() => {
    if (locked || pages[tab]) return;
    loadPage(tab);
  }, [tab, locked, pages, loadPage]);

  function startEditing() {
    setDraftName(profile?.name ?? '');
    setDraftBio(profile?.description ?? '');
    setError('');
    setEditing(true);
  }

  async function handleSave() {
    const trimmedName = draftName.trim();
    const trimmedBio = draftBio.trim();

    if (trimmedName.length < NAME_MIN) {
      setError(`نام گروه باید حداقل ${fa(NAME_MIN)} کاراکتر باشد`);
      return;
    }
    if (trimmedName.length > NAME_MAX) {
      setError(`نام گروه نباید بیشتر از ${fa(NAME_MAX)} کاراکتر باشد`);
      return;
    }
    if (trimmedBio.length > DESCRIPTION_MAX) {
      setError(`توضیح گروه نباید بیشتر از ${fa(DESCRIPTION_MAX)} کاراکتر باشد`);
      return;
    }

    // Only what actually changed is sent; an empty body is a request the server
    // refuses, and a photo this screen cannot change must not be rewritten.
    const body = {};
    if (trimmedName !== (profile?.name ?? '')) body.name = trimmedName;
    if (trimmedBio !== (profile?.description ?? '')) body.description = trimmedBio;
    if (!Object.keys(body).length) {
      setError('تغییری برای ذخیره نکردی');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const wire = await updateGroup(profile.id, body);
      setProfile(normalizeGroup(wire));
      setEditing(false);
    } catch (err) {
      setError(err.message || 'ذخیره تغییرات ناموفق بود');
    } finally {
      setSaving(false);
    }
  }

  async function openAddress(url) {
    try {
      await Linking.openURL(url);
    } catch {
      setError('باز کردن لینک ناموفق بود');
    }
  }

  const shared = TABS.find(entry => entry.kind === tab);
  const page = pages[tab] ?? pageState();
  const items = page.items;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        testID="profile-screen"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Avatar
            uri={profile?.avatar}
            name={profile?.name}
            size={96}
            group={isGroup}
            status={isGroup ? undefined : profile?.status}
          />
          <Text style={styles.heroName}>{profile?.name}</Text>
          {isGroup ? (
            <Text style={styles.heroMeta}>{fa(profile?.memberCount ?? 0)} عضو</Text>
          ) : (
            <View style={styles.heroRow}>
              <Text style={styles.heroHandle}>@{profile?.username}</Text>
              <Text style={styles.heroDot}>·</Text>
              <Text style={[styles.heroMeta, profile?.status === 'online' && styles.heroOnline]}>
                {profile?.status === 'online' ? 'آنلاین' : 'آفلاین'}
              </Text>
            </View>
          )}
          {!!profile?.bio && !isGroup && <Text style={styles.bio}>{profile.bio}</Text>}
          {!!profile?.description && isGroup && <Text style={styles.bio}>{profile.description}</Text>}
        </View>

        {!!longDate(profile?.createdAt) && (
          <View style={styles.row}>
            <FontAwesome6 name="calendar" size={13} color={colors.text3} />
            <Text style={styles.rowText}>
              {isGroup ? 'گروه از' : 'پیوسته'} · {longDate(profile.createdAt)}
            </Text>
          </View>
        )}

        <View style={styles.row}>
          <FontAwesome6 name={locked ? 'lock' : 'shield-halved'} size={13} color={locked ? colors.accentText : colors.text3} />
          <Text style={styles.rowText}>
            {locked ? 'رمزنگاری سرتاسری' : 'بدون رمزنگاری'}
          </Text>
        </View>

        {editing ? (
          <View style={styles.form}>
            <Text style={styles.label}>نام گروه</Text>
            <TextInput
              testID="profile-edit-name"
              style={styles.input}
              value={draftName}
              onChangeText={value => { setDraftName(value); setError(''); }}
              maxLength={NAME_MAX}
              accessibilityLabel="نام گروه"
              placeholder="نام گروه"
              placeholderTextColor={colors.text3}
            />
            <Text style={styles.label}>توضیح گروه</Text>
            <TextInput
              testID="profile-edit-bio"
              style={[styles.input, styles.inputMultiline]}
              value={draftBio}
              onChangeText={value => { setDraftBio(value); setError(''); }}
              maxLength={DESCRIPTION_MAX}
              multiline
              accessibilityLabel="توضیح گروه"
              placeholder="توضیح کوتاه"
              placeholderTextColor={colors.text3}
            />
            {!!error && (
              <View style={styles.errorBanner} accessibilityRole="alert">
                <FontAwesome6 name="triangle-exclamation" size={12} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            <View style={styles.formActions}>
              <Pressable
                testID="profile-save"
                style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
                onPress={handleSave}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="ذخیره تغییرات"
              >
                {saving
                  ? <ActivityIndicator color={colors.onAccent} size="small" />
                  : <Text style={styles.saveText}>ذخیره</Text>}
              </Pressable>
              <Pressable
                style={styles.cancelBtn}
                onPress={() => { setEditing(false); setError(''); }}
                accessibilityRole="button"
                accessibilityLabel="لغو ویرایش"
              >
                <Text style={styles.cancelText}>لغو</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          canEdit && (
            <Pressable
              testID="profile-edit"
              style={styles.editBtn}
              onPress={startEditing}
              accessibilityRole="button"
              accessibilityLabel="ویرایش اطلاعات گروه"
            >
              <FontAwesome6 name="pen" size={12} color={colors.accentText} />
              <Text style={styles.editText}>ویرایش نام و توضیح</Text>
            </Pressable>
          )
        )}

        {!locked && (
          <View style={styles.section}>
            <View style={styles.tabs} accessibilityRole="tablist">
              {TABS.map(entry => (
                <Pressable
                  key={entry.kind}
                  testID={`profile-tab-${entry.kind}`}
                  style={[styles.tab, tab === entry.kind && styles.tabActive]}
                  onPress={() => setTab(entry.kind)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: tab === entry.kind }}
                  accessibilityLabel={entry.label}
                >
                  <FontAwesome6
                    name={entry.icon}
                    size={12}
                    color={tab === entry.kind ? colors.accentText : colors.text3}
                  />
                  <Text style={[styles.tabText, tab === entry.kind && styles.tabTextActive]}>
                    {entry.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {page.status === 'loading' && (
              <View style={styles.busy}>
                <ActivityIndicator color={colors.accent} size="small" />
                <Text style={styles.busyText}>در حال بارگذاری…</Text>
              </View>
            )}

            {page.status === 'error' && (
              <View style={styles.errorBanner} accessibilityRole="alert">
                <FontAwesome6 name="triangle-exclamation" size={12} color={colors.danger} />
                <Text style={styles.errorText}>{page.error}</Text>
                <Pressable onPress={() => loadPage(tab)} accessibilityRole="button" accessibilityLabel="تلاش دوباره">
                  <Text style={styles.retryText}>تلاش دوباره</Text>
                </Pressable>
              </View>
            )}

            {page.status === 'ready' && items.length === 0 && (
              <Text style={styles.empty}>{shared.empty}</Text>
            )}

            {tab === 'media' && items.length > 0 && (
              <View style={styles.grid}>
                {items.map(item => (
                  <Pressable
                    key={item.id}
                    testID="profile-media-cell"
                    style={styles.cell}
                    onPress={() => setViewer(item.src)}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={`بازکردن ${item.name || 'تصویر'} در اندازه کامل`}
                  >
                    <Image source={{ uri: item.src }} style={styles.cellImage} resizeMode="cover" />
                  </Pressable>
                ))}
              </View>
            )}

            {tab !== 'media' && items.length > 0 && (
              <View style={styles.list}>
                {items.map(item => (
                  <Pressable
                    key={item.id}
                    testID={tab === 'files' ? 'profile-file-row' : 'profile-link-row'}
                    style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
                    onPress={() => openAddress(tab === 'files' ? item.src : item.url)}
                    accessibilityRole="button"
                    accessibilityLabel={tab === 'files'
                      ? `دانلود ${item.name || 'فایل'}`
                      : `بازکردن ${hostOf(item.url)}`}
                  >
                    <FontAwesome6
                      name={tab === 'files' ? 'file-arrow-down' : 'link'}
                      size={14}
                      color={colors.accentText}
                    />
                    <View style={styles.listBody}>
                      <Text style={styles.listTitle} numberOfLines={1}>
                        {tab === 'files' ? (item.name || 'فایل') : hostOf(item.url)}
                      </Text>
                      {tab === 'links' && !!item.text && (
                        <Text style={styles.listSub} numberOfLines={2}>{item.text}</Text>
                      )}
                      <Text style={styles.listMeta}>
                        {tab === 'files' ? `${formatSize(item.size)} · ` : ''}
                        {item.sender ?? '—'} · {formatDayLabel(item.createdAt)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {page.status === 'ready' && !!page.cursor && (
              <Pressable
                testID="profile-load-more"
                style={styles.moreBtn}
                onPress={() => loadPage(tab, page.cursor)}
                accessibilityRole="button"
                accessibilityLabel="نمایش بیشتر"
              >
                <Text style={styles.moreText}>نمایش بیشتر</Text>
              </Pressable>
            )}
          </View>
        )}

        {locked && (
          <View style={styles.lockedNote}>
            <FontAwesome6 name="lock" size={13} color={colors.accentText} />
            <Text style={styles.lockedText}>
              این گفتگو سرتاسری رمزنگاری شده؛ فهرست رسانه‌ها و فایل‌ها فقط در نسخهٔ وب نشان داده می‌شود.
            </Text>
          </View>
        )}

        {isGroup && (profile?.participants?.length ?? 0) > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>اعضای گروه ({fa(profile.participants.length)})</Text>
            {profile.participants.map(person => (
              <View key={person.id} style={styles.member} testID="profile-member">
                <Avatar uri={person.avatar} name={person.name} size={38} status={person.status} />
                <View style={styles.memberBody}>
                  <Text style={styles.memberName} numberOfLines={1}>{person.name}</Text>
                  {!!person.username && (
                    <Text style={styles.memberHandle} numberOfLines={1}>@{person.username}</Text>
                  )}
                </View>
                <Text style={styles.memberRole}>
                  {person.id === currentUser?.id ? 'شما' : (ROLE_TEXT[person.role] ?? '')}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {!!viewer && (
        <Modal
          visible
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setViewer(null)}
        >
          <View style={styles.viewer} testID="profile-image-viewer">
            <Pressable
              testID="profile-viewer-close"
              style={styles.viewerClose}
              onPress={() => setViewer(null)}
              accessibilityRole="button"
              accessibilityLabel="بستن تصویر"
            >
              <FontAwesome6 name="xmark" size={16} color={colors.text1} />
            </Pressable>
            <Image
              testID="profile-viewer-image"
              source={{ uri: viewer }}
              style={styles.viewerImage}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          </View>
        </Modal>
      )}
    </View>
  );
}

function makeStyles(colors, insets) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },

    hero: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.md },
    heroName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.lg, marginTop: spacing.sm },
    heroMeta: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm },
    heroOnline: { color: colors.success },
    heroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    heroHandle: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm },
    heroDot: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm },
    bio: {
      color: colors.text2, fontFamily: fonts.regular, fontSize: type.base, textAlign: 'center',
      marginTop: spacing.sm, lineHeight: 22,
    },

    row: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      minHeight: 44, paddingHorizontal: spacing.md,
      borderRadius: radius.md, backgroundColor: colors.surface,
      borderWidth: 1, borderColor: colors.border,
    },
    rowText: { flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right' },

    editBtn: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      minHeight: 44, paddingHorizontal: spacing.md,
      borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
    },
    editText: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.sm },

    form: {
      gap: spacing.xs, padding: spacing.md,
      borderRadius: radius.md, backgroundColor: colors.surface,
      borderWidth: 1, borderColor: colors.border,
    },
    label: { color: colors.text2, fontFamily: fonts.medium, fontSize: type.xs },
    input: {
      minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong,
      backgroundColor: colors.surface2, color: colors.text1,
      fontFamily: fonts.regular, fontSize: type.base, textAlign: 'right',
    },
    inputMultiline: { minHeight: 76, textAlignVertical: 'top' },
    formActions: { flexDirection: 'row-reverse', gap: spacing.sm, marginTop: spacing.sm },
    saveBtn: {
      minHeight: 44, paddingHorizontal: spacing.xl, borderRadius: radius.md,
      backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    },
    saveBtnDisabled: { opacity: 0.7 },
    saveText: { color: colors.onAccent, fontFamily: fonts.semibold, fontSize: type.sm },
    cancelBtn: {
      minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.md,
      borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center',
    },
    cancelText: { color: colors.text2, fontFamily: fonts.medium, fontSize: type.sm },

    section: { gap: spacing.sm, marginTop: spacing.md },
    sectionTitle: { color: colors.text2, fontFamily: fonts.semibold, fontSize: type.sm },

    tabs: {
      flexDirection: 'row', gap: spacing.xs,
      borderRadius: radius.pill, backgroundColor: colors.surface2, padding: 4,
    },
    tab: {
      flex: 1, minHeight: 40, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
      gap: spacing.xs, borderRadius: radius.pill,
    },
    tabActive: { backgroundColor: colors.surface },
    tabText: { color: colors.text3, fontFamily: fonts.medium, fontSize: type.xs },
    tabTextActive: { color: colors.accentText },

    busy: { flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
    busyText: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },
    empty: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm, paddingVertical: spacing.md, textAlign: 'center' },
    errorBanner: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      padding: spacing.md, borderRadius: radius.sm, backgroundColor: colors.dangerSoft,
    },
    errorText: { flex: 1, color: colors.text1, fontFamily: fonts.regular, fontSize: type.xs, textAlign: 'right' },
    retryText: { color: colors.accentText, fontFamily: fonts.semibold, fontSize: type.xs },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
    cell: { width: '31.4%', aspectRatio: 1, backgroundColor: colors.surface2 },
    cellImage: { width: '100%', height: '100%' },

    list: { gap: 1, borderRadius: radius.md, overflow: 'hidden' },
    listRow: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.md,
      minHeight: 60, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      backgroundColor: colors.surface,
    },
    listRowPressed: { backgroundColor: colors.surface2 },
    listBody: { flex: 1, gap: 2 },
    listTitle: { color: colors.text1, fontFamily: fonts.medium, fontSize: type.sm },
    listSub: { color: colors.text2, fontFamily: fonts.regular, fontSize: type.xs },
    listMeta: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },

    moreBtn: {
      minHeight: 44, alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
    },
    moreText: { color: colors.accentText, fontFamily: fonts.semibold, fontSize: type.sm },

    lockedNote: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      padding: spacing.md, borderRadius: radius.md,
      backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
    },
    lockedText: {
      flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.xs,
      textAlign: 'right', lineHeight: 18,
    },

    member: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.md,
      minHeight: 56, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      borderRadius: radius.md, backgroundColor: colors.surface,
    },
    memberBody: { flex: 1, gap: 2 },
    memberName: { color: colors.text1, fontFamily: fonts.medium, fontSize: type.sm },
    memberHandle: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.xs },
    memberRole: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.xs },

    viewer: { flex: 1, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center' },
    viewerClose: {
      position: 'absolute', top: insets.top + spacing.md, right: spacing.lg, zIndex: 10,
      width: 40, height: 40, borderRadius: radius.pill,
      backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
    },
    viewerImage: { width: '100%', height: '70%' },
  });
}

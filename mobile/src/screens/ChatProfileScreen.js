import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useCall } from '../context/CallContext';
import { useSocket } from '../context/SocketContext';
import Avatar from '../components/Avatar';
import {
  fetchE2eeState, fetchShared, fetchUser, normalizeGroup, normalizeUser, resolveUrl, updateGroup,
} from '../services/api';
import { fonts, radius, spacing, type, useAppTheme } from '../theme';
import { formatDayLabel } from '../utils/time';
import { fa, formatSize } from '../utils/persian';
import VoiceBubble from '../components/VoiceBubble';

const TABS = [
  { kind: 'media',  label: 'رسانه',   empty: 'تصویری در این گفتگو نیست' },
  { kind: 'voice',  label: 'ویس',     empty: 'پیام صوتی‌ای در این گفتگو نیست' },
  { kind: 'music',  label: 'موسیقی',  empty: 'فایل صوتی‌ای در این گفتگو نیست' },
  { kind: 'files',  label: 'فایل‌ها', empty: 'فایلی در این گفتگو نیست' },
  { kind: 'links',  label: 'لینک‌ها', empty: 'لینکی در این گفتگو نیست' },
];
// Members are already on this screen with the chat, so the tab fetches nothing —
// and it is the one tab a chat with legacy encrypted history can still show,
// because a member list is not message content.
const MEMBERS_TAB = { kind: 'members', label: 'اعضا' };
const CALL_ACTIONS = [
  { id: 'call',  icon: 'phone', label: 'تماس',    kind: 'audio' },
  { id: 'video', icon: 'video', label: 'تصویری', kind: 'video' },
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
  const { startCall, phase } = useCall();
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

  // The conversation may have gained its legacy encrypted history since this
  // device last looked.
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

  // A tab is fetched the first time it is opened, never every tab at once.
  useEffect(() => {
    if (locked || pages[tab] || tab === MEMBERS_TAB.kind) return;
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
  const tabs = isGroup ? [MEMBERS_TAB, ...TABS] : TABS;
  const onMembers = tab === MEMBERS_TAB.kind;
  // A recording and a song are listened to where they stand, so their rows carry
  // a player; a document and a link are kept, so theirs are doors.
  const onAudio = tab === 'voice' || tab === 'music';
  const members = profile?.participants ?? [];
  // A locked chat has nothing to list except its members, so the strip only
  // appears where there is a tab that still works.
  const showTabs = !locked || isGroup;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        testID="profile-screen"
        keyboardShouldPersistTaps="handled"
      >
        {/* The hero is the person or the group and nothing else: face, name, and
            the one line that says who they are here. Everything that describes
            them rather than identifies them goes in the card under it. */}
        <View style={styles.hero}>
          <Avatar
            uri={profile?.avatar}
            name={profile?.name}
            size={96}
            group={isGroup}
            status={isGroup ? undefined : profile?.status}
          />
          <Text style={styles.heroName}>{profile?.name}</Text>
          <Text
            style={[
              styles.heroMeta,
              !isGroup && profile?.status === 'online' && styles.heroOnline,
            ]}
          >
            {isGroup
              ? `${fa(profile?.memberCount ?? 0)} عضو`
              : (profile?.status === 'online' ? 'آنلاین' : 'آفلاین')}
          </Text>
        </View>

        {/* The two calls a phone can start from here. A search lives in the
            transcript, which this screen does not hold, so it stays on the web. */}
        <View style={styles.actions}>
          {CALL_ACTIONS.map(action => (
            <Pressable
              key={action.id}
              testID={`profile-action-${action.id}`}
              style={[styles.action, phase !== 'idle' && styles.actionDisabled]}
              onPress={() => startCall(profile, action.kind)}
              disabled={phase !== 'idle'}
              accessibilityRole="button"
              accessibilityLabel={action.label}
            >
              <FontAwesome6 name={action.icon} size={17} color={colors.accentText} />
              <Text style={styles.actionText}>{action.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          {!!profile?.username && !isGroup && (
            <View style={styles.cardRow}>
              <FontAwesome6 name="at" size={13} color={colors.text3} />
              <Text style={[styles.rowText, styles.rowHandle]}>@{profile.username}</Text>
            </View>
          )}
          {!!(isGroup ? profile?.description : profile?.bio) && (
            <View style={styles.cardRow}>
              <FontAwesome6 name="circle-info" size={13} color={colors.text3} />
              <Text style={styles.rowText}>{isGroup ? profile.description : profile.bio}</Text>
            </View>
          )}
          {!!longDate(profile?.createdAt) && (
            <View style={styles.cardRow}>
              <FontAwesome6 name="calendar" size={13} color={colors.text3} />
              <Text style={styles.rowText}>
                {isGroup ? 'گروه از' : 'پیوسته'} · {longDate(profile.createdAt)}
              </Text>
            </View>
          )}
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

        {(showTabs || locked) && (
          <View style={styles.section}>
            {showTabs && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tabs}
                accessibilityRole="tablist"
              >
                {tabs.map(entry => (
                  <Pressable
                    key={entry.kind}
                    testID={`profile-tab-${entry.kind}`}
                    style={[styles.tab, tab === entry.kind && styles.tabActive]}
                    onPress={() => setTab(entry.kind)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: tab === entry.kind }}
                    accessibilityLabel={entry.kind === MEMBERS_TAB.kind
                      ? `${entry.label} ${fa(members.length)}`
                      : entry.label}
                  >
                    <Text style={[styles.tabText, tab === entry.kind && styles.tabTextActive]}>
                      {entry.kind === MEMBERS_TAB.kind ? `${entry.label} ${fa(members.length)}` : entry.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {onMembers ? (
              <View style={styles.list}>
                {members.map(person => (
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
            ) : locked ? (
              <View style={styles.lockedNote}>
                <Text style={styles.lockedText}>
                  پیام‌های قدیمیِ این گفتگو با رمزنگاری قبلی ذخیره شده‌اند؛ فهرست رسانه‌ها و فایل‌ها فقط در نسخهٔ وب نشان داده می‌شود.
                </Text>
              </View>
            ) : (
              <>
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

                {onAudio && items.length > 0 && (
                  <View style={styles.list}>
                    {items.map(item => (
                      <View key={item.id} style={styles.listRow} testID="profile-audio-row">
                        <View style={styles.listBody}>
                          {tab === 'music' && !!item.name && (
                            <Text style={styles.listTitle} numberOfLines={1}>{item.name}</Text>
                          )}
                          <VoiceBubble id={item.id} src={item.src} durationMs={item.durationMs} />
                          <Text style={styles.listMeta}>
                            {item.sender ?? '—'} · {formatDayLabel(item.createdAt)}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {!onAudio && tab !== 'media' && items.length > 0 && (
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
              </>
            )}
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
    heroName: { color: colors.text1, fontFamily: fonts.semibold, fontSize: type.xl, marginTop: spacing.sm },
    heroMeta: { color: colors.text3, fontFamily: fonts.regular, fontSize: type.sm },
    heroOnline: { color: colors.success },

    actions: { flexDirection: 'row', gap: spacing.sm },
    action: {
      flex: 1, height: 58, alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
      borderRadius: radius.lg, backgroundColor: colors.surface,
    },
    actionDisabled: { opacity: 0.5 },
    actionText: { color: colors.accentText, fontFamily: fonts.medium, fontSize: type.xs },

    card: { borderRadius: radius.lg, backgroundColor: colors.surface, overflow: 'hidden' },
    cardRow: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.md,
      minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },

    row: {
      flexDirection: 'row-reverse', alignItems: 'center', gap: spacing.sm,
      minHeight: 44, paddingHorizontal: spacing.md,
      borderRadius: radius.md, backgroundColor: colors.surface,
      borderWidth: 1, borderColor: colors.border,
    },
    rowText: { flex: 1, color: colors.text2, fontFamily: fonts.regular, fontSize: type.sm, textAlign: 'right' },
    rowHandle: { color: colors.accentText, fontFamily: fonts.medium },

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

    // Five shelves plus members do not fit one row on a phone, so the capsule
    // scrolls sideways instead of shrinking the labels below reading size.
    tabs: {
      flexDirection: 'row', gap: spacing.xs,
      borderRadius: radius.pill, backgroundColor: colors.surface2, padding: 4,
    },
    tab: {
      paddingHorizontal: spacing.lg, minHeight: 40, alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.pill,
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

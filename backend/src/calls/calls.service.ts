import { randomBytes } from 'crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger,
  NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { signedFileUrl } from '../uploads/file-urls';
import {
  CALL_MAX_DURATION_SECONDS,
  CALL_MAX_GROUP_PARTICIPANTS,
  CALL_RING_TIMEOUT_SECONDS,
} from '../config/env';
import { CallEvents } from './call-events';
import { LiveKitService } from './livekit.service';
import {
  CallEndReason, CallRecord, CallStatus, CallType, TERMINAL_STATUSES, toCallView,
} from './call.types';

const RING_MS = CALL_RING_TIMEOUT_SECONDS * 1000;
const MAX_CALL_MS = CALL_MAX_DURATION_SECONDS * 1000;
const SWEEP_MS = 30_000;
// A finished call stays in the map for a while so a late accept/end is answered
// idempotently instead of creating a second room for the same ring.
const RETENTION_MS = 5 * 60 * 1000;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isCallType(value: unknown): value is CallType {
  return value === 'audio' || value === 'video';
}

/**
 * Server-authoritative call state. The media itself is LiveKit's job; this
 * service decides who may ring whom, who may receive a room token, when a call
 * has ended, and which of those facts late or duplicated events are allowed to
 * change.
 *
 * State is in-process, matching the single-API-instance presence model. A
 * restart therefore forgets active calls; LiveKit rooms left behind are swept
 * on boot when room administration is configured.
 */
@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  private readonly calls = new Map<string, CallRecord>();
  // One active call per account. A direct invite reserves the callee during
  // ringing; a group invite reserves only the caller, because an invite is not
  // an obligation to join.
  private readonly userCalls = new Map<string, string>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly livekit: LiveKitService,
    private readonly events: CallEvents,
  ) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => this.logger.error(`call sweep failed: ${err?.message ?? err}`));
    }, SWEEP_MS);
    this.sweepTimer.unref?.();
    if (this.livekit.roomAdminEnabled) {
      void this.livekit.deleteStaleRooms();
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const call of this.calls.values()) {
      if (!TERMINAL_STATUSES.has(call.status)) {
        this.finish(call, 'ENDED', 'shutdown', null, false);
      }
    }
  }

  // ── Creating calls ─────────────────────────────────────────────

  async inviteDirect(
    callerId: string,
    body: { callId?: unknown; toId?: unknown; type?: unknown },
  ) {
    this.assertConfigured();
    const { toId, type } = body ?? {};
    if (!isId(toId) || toId === callerId) throw new BadRequestException('گیرندهٔ تماس مشخص نیست');
    if (!isCallType(type)) throw new BadRequestException('نوع تماس مشخص نیست');
    const callId = this.claimCallId(body.callId);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: callerId } } },
          { participants: { some: { userId: toId } } },
        ],
      },
      select: { id: true, e2ee: true },
    });
    // A call starts from an existing conversation. This also makes arbitrary
    // account ids unringable, which is the same boundary the chat already has.
    if (!conversation) throw new ForbiddenException('تماس فقط در یک گفتگوی موجود امکان‌پذیر است');

    if (this.activeForUser(callerId)) throw new ConflictException('شما در تماس دیگری هستید');
    if (this.activeForUser(toId)) throw new ConflictException('کاربر در تماس دیگری است');

    const [caller, callee] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: callerId },
        select: { id: true, username: true, displayName: true, avatar: true },
      }),
      this.prisma.user.findUnique({ where: { id: toId }, select: { id: true } }),
    ]);
    if (!caller) throw new NotFoundException('تماس‌گیرنده پیدا نشد');
    if (!callee) throw new NotFoundException('کاربر پیدا نشد');

    const call = this.createCall({
      id: callId,
      kind: 'direct',
      type,
      conversationId: conversation.id,
      callerId,
      calleeId: toId,
      participantIds: [callerId, toId],
      e2ee: conversation.e2ee,
      mediaKey: conversation.e2ee ? randomBytes(32).toString('base64') : null,
    });

    this.events.publish('call:incoming', [toId], {
      callId: call.id,
      kind: 'direct',
      type,
      from: this.wireUser(caller),
      conversationId: conversation.id,
      e2ee: conversation.e2ee,
    });

    return {
      ok: true,
      callId: call.id,
      conversationId: conversation.id,
      e2ee: conversation.e2ee,
      type,
    };
  }

  async startGroupCall(
    callerId: string,
    body: { callId?: unknown; conversationId?: unknown; type?: unknown },
  ) {
    this.assertConfigured();
    const { conversationId, type } = body ?? {};
    if (!isId(conversationId)) throw new BadRequestException('گروه مشخص نیست');
    if (!isCallType(type)) throw new BadRequestException('نوع تماس مشخص نیست');
    const callId = this.claimCallId(body.callId);

    const group = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        isGroup: true,
        participants: { some: { userId: callerId } },
      },
      select: {
        id: true,
        name: true,
        avatar: true,
        e2ee: true,
        participants: { select: { userId: true } },
      },
    });
    if (!group) throw new ForbiddenException('گروه پیدا نشد یا شما عضو آن نیستید');

    const memberIds = group.participants.map((p) => p.userId);
    if (memberIds.length < 2) throw new BadRequestException('تماس گروهی حداقل دو عضو می‌خواهد');
    if (memberIds.length > CALL_MAX_GROUP_PARTICIPANTS) {
      throw new BadRequestException(`تماس گروهی حداکثر برای ${CALL_MAX_GROUP_PARTICIPANTS} عضو است`);
    }
    // Matches LiveKit's E2EE participant ceiling. Refusing here is clearer than
    // a room where the last five people silently cannot encrypt.
    if (group.e2ee && memberIds.length > 20) {
      throw new BadRequestException('تماس رمزنگاری‌شدهٔ گروهی حداکثر ۲۰ عضو دارد');
    }

    if (this.activeForUser(callerId)) throw new ConflictException('شما در تماس دیگری هستید');
    if (this.activeGroupForConversation(group.id)) {
      throw new ConflictException('یک تماس گروهی در این گفتگو در جریان است');
    }

    const caller = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { id: true, username: true, displayName: true, avatar: true },
    });
    if (!caller) throw new NotFoundException('تماس‌گیرنده پیدا نشد');

    const call = this.createCall({
      id: callId,
      kind: 'group',
      type,
      conversationId: group.id,
      callerId,
      calleeId: null,
      participantIds: memberIds,
      e2ee: group.e2ee,
      mediaKey: group.e2ee ? randomBytes(32).toString('base64') : null,
    });

    // An invite is sent only to members who are not already on another call.
    // Offline members simply do not receive it; they can still see the active
    // call when they open the group (GET /calls/active/:conversationId).
    const recipients = memberIds.filter((id) => id !== callerId && !this.activeForUser(id));

    this.events.publish('call:incoming', recipients, {
      callId: call.id,
      kind: 'group',
      type,
      from: this.wireUser(caller),
      conversationId: group.id,
      e2ee: group.e2ee,
      group: {
        id: group.id,
        name: group.name ?? 'گروه',
        avatar: signedFileUrl(group.avatar) ?? '',
        memberCount: memberIds.length,
      },
    });

    return {
      ok: true,
      callId: call.id,
      conversationId: group.id,
      e2ee: group.e2ee,
      type,
      memberCount: memberIds.length,
      reachable: recipients.length,
    };
  }

  // ── Answering ──────────────────────────────────────────────────

  async accept(userId: string, callId: string) {
    const call = this.requireCall(callId);
    this.assertParticipant(call, userId);
    if (TERMINAL_STATUSES.has(call.status)) {
      // A late duplicate must not turn into a second ring or an error the UI
      // has to explain; the token endpoint still refuses to mint a room token.
      return {
        ok: true,
        duplicate: true,
        ended: call.responses.get(userId) !== 'accepted',
        callId: call.id,
        status: call.status,
        e2ee: call.e2ee,
      };
    }

    if (call.kind === 'direct') {
      if (userId !== call.calleeId) throw new ForbiddenException('فقط طرف مقابل می‌تواند این تماس را پاسخ دهد');
      if (call.status !== 'RINGING') {
        if (call.responses.get(userId) === 'accepted') {
          return { ok: true, duplicate: true, callId: call.id, e2ee: call.e2ee };
        }
        throw new ConflictException('این تماس دیگر در حال زنگ خوردن نیست');
      }
    } else if (userId === call.callerId) {
      // The caller opens the room; the first accept belongs to a member.
      return { ok: true, duplicate: true, callId: call.id, e2ee: call.e2ee };
    }

    // No await between the check above and this write: the event loop cannot
    // interleave a reject or a second accept here.
    if (call.status === 'RINGING') {
      call.status = 'CONNECTING';
      call.acceptedAt = Date.now();
      this.clearRing(call);
    }
    call.responses.set(userId, 'accepted');
    if (!this.userCalls.has(userId)) this.userCalls.set(userId, call.id);

    this.events.publish(
      'call:accepted',
      call.participantIds,
      { callId: call.id, userId, e2ee: call.e2ee },
    );

    return { ok: true, callId: call.id, e2ee: call.e2ee };
  }

  async reject(userId: string, callId: string) {
    const call = this.requireCall(callId);
    this.assertParticipant(call, userId);
    if (TERMINAL_STATUSES.has(call.status)) return { ok: true, duplicate: true };

    if (call.kind === 'direct') {
      if (userId !== call.calleeId) throw new ForbiddenException('فقط طرف مقابل می‌تواند این تماس را رد کند');
      if (call.status !== 'RINGING') {
        // Rejecting an already answered call is not a state transition; the
        // caller's end button is `call:end`, not `call:reject`.
        if (call.responses.get(userId) === 'accepted' || call.connected.has(userId)) {
          return { ok: true, duplicate: true };
        }
        throw new ConflictException('این تماس دیگر در حال زنگ خوردن نیست');
      }
      this.finish(call, 'REJECTED', 'rejected', userId);
      return { ok: true };
    }

    if (call.responses.get(userId) === 'accepted' || call.connected.has(userId)) {
      throw new ConflictException('شما قبلاً به این تماس پیوسته‌اید');
    }
    call.responses.set(userId, 'rejected');
    call.left.add(userId);
    if (this.userCalls.get(userId) === call.id) this.userCalls.delete(userId);
    this.publishParticipantLeft(call, userId, 'rejected');
    this.endIfNobodyLeft(call);
    return { ok: true };
  }

  async cancel(userId: string, callId: string) {
    const call = this.requireCall(callId);
    this.assertParticipant(call, userId);
    if (TERMINAL_STATUSES.has(call.status)) return { ok: true, duplicate: true };
    if (userId !== call.callerId) throw new ForbiddenException('فقط تماس‌گیرنده می‌تواند این تماس را لغو کند');
    if (call.status === 'CONNECTED') {
      this.finish(call, 'ENDED', 'hangup', userId);
    } else {
      this.finish(call, 'CANCELLED', 'cancelled', userId);
    }
    return { ok: true };
  }

  async end(userId: string, callId: string) {
    const call = this.requireCall(callId);
    this.assertParticipant(call, userId);
    if (TERMINAL_STATUSES.has(call.status)) return { ok: true, duplicate: true };

    // In a group, ending is leaving unless the initiator is the one asking.
    if (call.kind === 'group' && userId !== call.callerId) {
      this.leaveGroup(call, userId, 'hangup');
      return { ok: true };
    }
    this.finish(call, 'ENDED', 'hangup', userId);
    return { ok: true };
  }

  async userDisconnected(userId: string) {
    const callId = this.userCalls.get(userId);
    if (!callId) return;
    const call = this.calls.get(callId);
    if (!call || TERMINAL_STATUSES.has(call.status)) return;

    if (call.kind === 'direct') {
      if (call.status === 'RINGING') {
        const callerLeft = userId === call.callerId;
        this.finish(call, callerLeft ? 'CANCELLED' : 'MISSED', callerLeft ? 'caller-disconnected' : 'unavailable', userId);
      } else {
        this.finish(call, 'ENDED', 'disconnected', userId);
      }
      return;
    }

    if (userId === call.callerId) {
      this.finish(call, 'ENDED', 'caller-disconnected', userId);
      return;
    }
    this.leaveGroup(call, userId, 'disconnected');
  }

  /** A late joiner opening a group can discover the room it was invited to. */
  activeGroupCall(conversationId: string, userId: string) {
    const call = this.activeGroupForConversation(conversationId);
    if (!call || !call.participantIds.includes(userId) || call.left.has(userId)) return null;
    return toCallView(call);
  }

  // ── Room token ─────────────────────────────────────────────────

  async token(
    userId: string,
    callId: string,
    body: { client: 'web' | 'mobile' },
  ) {
    const call = this.requireCall(callId);
    this.assertParticipant(call, userId);
    if (call.left.has(userId)) throw new ForbiddenException('شما این تماس را ترک کرده‌اید');
    if (TERMINAL_STATUSES.has(call.status)) throw new ConflictException('این تماس پایان یافته است');

    if (call.e2ee) {
      // Mobile has no LiveKit E2EE support. It is refused rather than allowed
      // into the room without encryption.
      if (body?.client !== 'web') {
        throw new ForbiddenException('نسخهٔ موبایل فعلاً رسانهٔ رمزنگاری‌شدهٔ این تماس را پشتیبانی نمی‌کند');
      }
      // The key belongs to the call and is held for its lifetime. A missing key
      // on an encrypted call is a server-side fault, never a reason to mint an
      // unencrypted token.
      if (!call.mediaKey) throw new ServiceUnavailableException('کلید رسانهٔ این تماس در دسترس نیست');
    }

    if (call.kind === 'direct') {
      if (call.status === 'RINGING') throw new ConflictException('این تماس هنوز پاسخ داده نشده است');
    } else if (userId !== call.callerId) {
      if (call.status === 'RINGING') throw new ConflictException('برای پیوستن، ابتدا تماس را بپذیرید');
      const response = call.responses.get(userId);
      if (response !== 'accepted') throw new ForbiddenException('شما این تماس را نپذیرفته‌اید');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });
    if (!user) throw new NotFoundException('کاربر پیدا نشد');

    const issued = await this.livekit.issueRoomToken({
      identity: userId,
      name: user.displayName || user.username || 'کاربر',
      room: call.room,
      callId: call.id,
    });

    return {
      ...issued,
      callId: call.id,
      room: call.room,
      e2ee: call.e2ee,
      mediaKey: call.e2ee ? call.mediaKey : null,
    };
  }

  // ── LiveKit webhooks ───────────────────────────────────────────

  async handleWebhook(event: { event: string; room?: { name?: string }; participant?: { identity?: string } }) {
    const roomName = event?.room?.name;
    if (typeof roomName !== 'string' || !roomName.startsWith('ob_')) return;
    const call = this.calls.get(roomName.slice(3));
    if (!call || TERMINAL_STATUSES.has(call.status)) return;

    const identity = event?.participant?.identity;

    if (event.event === 'participant_joined' && typeof identity === 'string') {
      if (!call.participantIds.includes(identity) || call.left.has(identity)) {
        // A token can outlive the authorization that produced it; remove anyone
        // who is no longer a participant.
        if (this.livekit.roomAdminEnabled) void this.livekit.removeParticipant(roomName, identity);
        return;
      }
      call.connected.add(identity);
      if (!call.connectedAt) call.connectedAt = Date.now();
      if (call.status === 'CONNECTING') {
        const answered = call.kind === 'direct'
          ? call.participantIds.every((id) => call.connected.has(id))
          : [...call.connected].some((id) => id !== call.callerId);
        if (answered) call.status = 'CONNECTED';
      }
      return;
    }

    if (event.event === 'participant_left' && typeof identity === 'string') {
      call.connected.delete(identity);
      if (call.kind === 'direct') {
        this.finish(call, 'ENDED', 'participant-left', identity);
      } else if (identity === call.callerId) {
        this.finish(call, 'ENDED', 'participant-left', identity);
      } else {
        this.leaveGroup(call, identity, 'participant-left', false);
      }
      return;
    }

    if (event.event === 'room_finished') {
      this.finish(call, 'ENDED', 'room-finished', null);
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private assertConfigured() {
    if (!this.livekit.configured) {
      throw new ServiceUnavailableException('تماس هنوز روی این سرور پیکربندی نشده است');
    }
  }

  private createCall(input: {
    id: string;
    kind: 'direct' | 'group';
    type: CallType;
    conversationId: string;
    callerId: string;
    calleeId: string | null;
    participantIds: string[];
    e2ee: boolean;
    mediaKey: string | null;
  }): CallRecord {
    const id = input.id;
    const call: CallRecord = {
      id,
      room: `ob_${id}`,
      kind: input.kind,
      type: input.type,
      conversationId: input.conversationId,
      callerId: input.callerId,
      calleeId: input.calleeId,
      participantIds: [...new Set(input.participantIds)],
      left: new Set(),
      responses: new Map(),
      connected: new Set(),
      status: 'RINGING',
      e2ee: input.e2ee,
      mediaKey: input.mediaKey,
      createdAt: Date.now(),
      acceptedAt: null,
      connectedAt: null,
      endedAt: null,
    };

    this.calls.set(id, call);
    this.userCalls.set(call.callerId, id);
    // A ringing direct call reserves both people: the callee should see this
    // ring, not a second one, and the caller must not start a second call.
    if (call.kind === 'direct' && call.calleeId) this.userCalls.set(call.calleeId, id);

    call.ringTimer = setTimeout(() => this.onRingTimeout(id), RING_MS);
    call.ringTimer.unref?.();
    return call;
  }

  private onRingTimeout(callId: string) {
    const call = this.calls.get(callId);
    if (!call || call.status !== 'RINGING') return;
    this.finish(call, 'MISSED', 'timeout', null);
  }

  private leaveGroup(call: CallRecord, userId: string, reason: CallEndReason, removeFromRoom = true) {
    if (call.kind !== 'group' || call.left.has(userId)) return;
    call.left.add(userId);
    call.connected.delete(userId);
    if (this.userCalls.get(userId) === call.id) this.userCalls.delete(userId);
    if (removeFromRoom && this.livekit.roomAdminEnabled) {
      void this.livekit.removeParticipant(call.room, userId);
    }
    this.publishParticipantLeft(call, userId, reason);
    this.endIfNobodyLeft(call);
  }

  private publishParticipantLeft(call: CallRecord, userId: string, reason: CallEndReason) {
    // Sent to the leaver too: their other tabs must stop showing a call that
    // this tab has already left.
    this.events.publish(
      'call:participant-left',
      call.participantIds,
      { callId: call.id, userId, reason },
    );
  }

  private endIfNobodyLeft(call: CallRecord) {
    if (TERMINAL_STATUSES.has(call.status)) return;
    const others = call.participantIds.filter((id) => id !== call.callerId);
    const anyoneLeft = others.some((id) => !call.left.has(id));
    const anyoneConnected = [...call.connected].some((id) => id !== call.callerId);
    if (anyoneLeft || anyoneConnected) return;
    // For a ringing group every invite was declined; after it connected every
    // other participant left. Both leave the initiator alone in a room.
    const status: CallStatus = call.status === 'RINGING' ? 'MISSED' : 'ENDED';
    this.finish(call, status, status === 'MISSED' ? 'unavailable' : 'empty', null);
  }

  private finish(
    call: CallRecord,
    status: CallStatus,
    reason: CallEndReason,
    byUserId: string | null,
    notify = true,
  ): boolean {
    if (TERMINAL_STATUSES.has(call.status)) return false;
    call.status = status;
    call.endedAt = Date.now();
    this.clearRing(call);
    for (const id of call.participantIds) {
      if (this.userCalls.get(id) === call.id) this.userCalls.delete(id);
    }
    if (notify) {
      this.events.publish('call:ended', call.participantIds, {
        callId: call.id,
        reason,
        status,
        by: byUserId,
        e2ee: call.e2ee,
        // Recorded from the server side of the lifecycle; a call that never
        // produced a participant_joined webhook reports zero.
        durationMs: call.connectedAt ? Math.max(0, call.endedAt - call.connectedAt) : 0,
      });
    }
    if (this.livekit.roomAdminEnabled) void this.livekit.deleteRoom(call.room);
    const cleanup = setTimeout(() => this.calls.delete(call.id), RETENTION_MS);
    cleanup.unref?.();
    return true;
  }

  private clearRing(call: CallRecord) {
    if (!call.ringTimer) return;
    clearTimeout(call.ringTimer);
    call.ringTimer = undefined;
  }

  private requireCall(callId: unknown): CallRecord {
    if (!isId(callId)) throw new BadRequestException('تماس مشخص نیست');
    const call = this.calls.get(callId);
    if (!call) throw new NotFoundException('تماس پیدا نشد');
    return call;
  }

  // The caller still generates the id so its cancel/end refer to one call, but
  // it is not a secret and grants nothing: the room name is built server-side
  // and access still requires a server-issued token.
  private claimCallId(value: unknown): string {
    if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException('شناسهٔ تماس نامعتبر است');
    }
    if (this.calls.has(value)) throw new ConflictException('این شناسهٔ تماس قبلاً استفاده شده است');
    return value;
  }

  private assertParticipant(call: CallRecord, userId: string) {
    if (!call.participantIds.includes(userId)) throw new ForbiddenException('شما در این تماس نیستید');
  }

  private activeForUser(userId: string): CallRecord | null {
    const callId = this.userCalls.get(userId);
    if (!callId) return null;
    const call = this.calls.get(callId);
    if (!call || TERMINAL_STATUSES.has(call.status)) return null;
    return call;
  }

  private activeGroupForConversation(conversationId: string): CallRecord | null {
    for (const call of this.calls.values()) {
      if (call.kind === 'group' && call.conversationId === conversationId && !TERMINAL_STATUSES.has(call.status)) {
        return call;
      }
    }
    return null;
  }

  private wireUser(user: { id: string; username: string; displayName: string | null; avatar: string | null }) {
    return {
      id: user.id,
      name: user.displayName || user.username,
      username: user.username,
      avatar: signedFileUrl(user.avatar) ?? '',
    };
  }

  private async sweep() {
    const now = Date.now();
    for (const call of [...this.calls.values()]) {
      if (TERMINAL_STATUSES.has(call.status)) {
        if (now - (call.endedAt ?? call.createdAt) > RETENTION_MS) this.calls.delete(call.id);
        continue;
      }
      if (now - call.createdAt > MAX_CALL_MS) {
        this.finish(call, 'ENDED', 'max-duration', null);
      }
    }

    const active = [...this.calls.values()].filter((call) => !TERMINAL_STATUSES.has(call.status));
    if (!active.length) return;

    const watched = new Set<string>();
    for (const call of active) {
      watched.add(call.callerId);
      if (call.calleeId) watched.add(call.calleeId);
      for (const id of call.responses.keys()) watched.add(id);
      for (const id of call.connected) watched.add(id);
    }

    let alive: Set<string>;
    try {
      const sessions = await this.prisma.session.findMany({
        where: {
          userId: { in: [...watched] },
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { userId: true },
      });
      alive = new Set(sessions.map((session) => session.userId));
    } catch (err) {
      // A database blip must not end calls by itself.
      this.logger.warn(`session sweep skipped: ${(err as Error)?.message ?? err}`);
      return;
    }

    for (const call of active) {
      const participants = new Set<string>([call.callerId]);
      if (call.calleeId) participants.add(call.calleeId);
      for (const id of call.responses.keys()) participants.add(id);
      for (const id of call.connected) participants.add(id);
      for (const id of participants) {
        if (!alive.has(id)) this.handleLostSession(call, id);
      }
    }
  }

  private handleLostSession(call: CallRecord, userId: string) {
    if (TERMINAL_STATUSES.has(call.status)) return;
    if (call.kind === 'direct') {
      this.finish(call, 'ENDED', 'disconnected', userId);
      return;
    }
    if (userId === call.callerId) {
      this.finish(call, 'ENDED', 'caller-disconnected', userId);
      return;
    }
    this.leaveGroup(call, userId, 'disconnected');
  }
}

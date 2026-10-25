export type CallKind = 'direct' | 'group';
export type CallType = 'audio' | 'video';

// Terminal states are kept distinct so a late event can be answered without
// rewriting history: a reject after a timeout is still a timeout.
export type CallStatus =
  | 'RINGING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ENDED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'MISSED'
  | 'FAILED';

export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  'ENDED', 'REJECTED', 'CANCELLED', 'MISSED', 'FAILED',
]);

export type CallEndReason =
  | 'hangup'
  | 'rejected'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'unavailable'
  | 'participant-left'
  | 'disconnected'
  | 'caller-disconnected'
  | 'empty'
  | 'room-finished'
  | 'max-duration'
  | 'shutdown'
  | 'failed';

export interface CallRecord {
  id: string;
  room: string;
  kind: CallKind;
  type: CallType;
  conversationId: string;
  callerId: string;
  calleeId: string | null;
  // Everyone invited, kept immutable so a terminal event still reaches people
  // who already left. `left` is what makes a member no longer a participant.
  participantIds: string[];
  left: Set<string>;
  responses: Map<string, 'accepted' | 'rejected'>;
  connected: Set<string>;
  status: CallStatus;
  e2ee: boolean;
  // The server issues one media key per encrypted call and holds it for the
  // call's lifetime. It is never persisted and never sent to the invitee before
  // a room token is issued.
  mediaKey: string | null;
  createdAt: number;
  acceptedAt: number | null;
  connectedAt: number | null;
  endedAt: number | null;
  ringTimer?: NodeJS.Timeout;
}

export interface CallView {
  callId: string;
  conversationId: string;
  kind: CallKind;
  type: CallType;
  e2ee: boolean;
  status: CallStatus;
  callerId: string;
  calleeId: string | null;
  participantIds: string[];
  connectedParticipantIds: string[];
}

export function toCallView(call: CallRecord): CallView {
  return {
    callId: call.id,
    conversationId: call.conversationId,
    kind: call.kind,
    type: call.type,
    e2ee: call.e2ee,
    status: call.status,
    callerId: call.callerId,
    calleeId: call.calleeId,
    participantIds: [...call.participantIds],
    connectedParticipantIds: [...call.connected],
  };
}

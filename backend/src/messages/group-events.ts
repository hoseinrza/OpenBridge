import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface GroupUpdated {
  // Who has to hear about the change: every member's open chat list and header.
  memberIds: string[];
  group: unknown;
}

export interface ConversationDeleted {
  conversationId: string;
  // Both people in the 1-to-1 chat: the one who deleted it and the one whose
  // row has to disappear too.
  memberIds: string[];
  byId: string;
}

// REST owns group edits (an avatar is an upload first), but only the gateway
// holds the socket server. Rather than import the chat module into the messages
// module and back, the edit is published here and the gateway relays it.
//
// In-process like the gateway's other state: one API instance serves the app, so
// a publisher and a subscriber are always in the same process.
@Injectable()
export class GroupEvents {
  private bus = new EventEmitter();

  constructor() {
    // A group edit is rare, but a burst of them must not trip the default limit.
    this.bus.setMaxListeners(0);
  }

  publishGroupUpdated(event: GroupUpdated) {
    this.bus.emit('group:updated', event);
  }

  onGroupUpdated(handler: (event: GroupUpdated) => void) {
    this.bus.on('group:updated', handler);
  }

  publishConversationDeleted(event: ConversationDeleted) {
    this.bus.emit('conversation:deleted', event);
  }

  onConversationDeleted(handler: (event: ConversationDeleted) => void) {
    this.bus.on('conversation:deleted', handler);
  }
}

import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface CallEvent {
  userIds: string[];
  payload: unknown;
}

// The call service owns state, the gateway owns the socket server. They meet
// here, in-process, like GroupEvents does for group metadata.
@Injectable()
export class CallEvents {
  private bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(0);
  }

  publish(name: string, userIds: string[], payload: unknown) {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (!unique.length) return;
    this.bus.emit(name, { userIds: unique, payload } satisfies CallEvent);
  }

  on(name: string, handler: (event: CallEvent) => void) {
    this.bus.on(name, handler);
  }
}

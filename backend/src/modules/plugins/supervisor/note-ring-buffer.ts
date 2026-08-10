import type { Note } from '../../../common/plugin-contract';

const CAPACITY = 64;

/**
 * Bounded outbound queue for Notes to one plugin: a stalled reader must
 * never stall core's fan-out. Overflow drops the oldest and counts it — at-most-once by construction.
 */
export class NoteRingBuffer {
  private items: Note[] = [];
  private droppedCount = 0;

  push(note: Note): void {
    if (this.items.length >= CAPACITY) {
      this.items.shift();
      this.droppedCount++;
    }
    this.items.push(note);
  }

  shift(): Note | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}

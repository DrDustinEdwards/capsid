import type { UndoRequest } from "../app/ctx";

// What the message region holds (capsid/decisions.md 2026-09-30, "admin panels review
// adopted", item 3): a performed action's result, with Undo for a switch change, and
// every failure that is not a refusal in a dialog. A plain result is replaced by the
// next one. A warning (an audit row naming you was not written), an Undo that failed,
// or a failure (a refresh, a copy, a sign out) stays until you dismiss it, whatever
// happens after it: the missing audit row is the one fact that cannot be found later
// by looking.
export interface Message {
  id: number;
  text: string;
  warning: string | null;
  undo: UndoRequest | null;
  // An Undo that was refused or could not be sent.
  error: string | null;
  busy: boolean;
  // Something that did not happen: the text is the failure.
  failure: boolean;
}

/** Whether a message stays when the next one arrives. */
export function lasting(m: Pick<Message, "warning" | "error" | "failure">): boolean {
  return m.failure || m.warning !== null || m.error !== null;
}

/** The region after `m` arrives: it first, then every lasting message before it. */
export function withMessage(all: Message[], m: Message): Message[] {
  return [m, ...all.filter(lasting)];
}

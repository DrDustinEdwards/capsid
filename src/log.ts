// The one place the Worker writes a log line. Every line is a JSON object with an
// upper-case `event` token to filter on and a `message` holding the human text, so a
// log search can match the token exactly and a person still reads the sentence.
//
// This file depends on nothing in the Worker (no Env), so any module can import it.
// It never throws: a log call sits inside catch blocks and cron steps, and a field
// that cannot be serialised (a circular object, a BigInt) must not turn a handled
// failure into a new one.

export type LogLevel = "log" | "warn" | "error";

export type LogFields = { message: string } & Record<string, unknown>;

export function logEvent(level: LogLevel, event: string, fields: LogFields): void {
  let line: string;
  try {
    const { message, event: _shadowed, ...rest } = fields;
    line = JSON.stringify({ event, message, ...rest });
  } catch {
    line = `${event} ${String(fields.message)}`;
  }
  try {
    console[level](line);
  } catch {
    // A console that throws has nowhere left to report to.
  }
}

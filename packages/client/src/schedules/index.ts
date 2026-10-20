import type { DaemonClient } from "../daemon-client.js";

export interface PaseoScheduleActions {
  create: DaemonClient["scheduleCreate"];
  list: DaemonClient["scheduleList"];
  inspect: DaemonClient["scheduleInspect"];
  update: DaemonClient["scheduleUpdate"];
  pause: DaemonClient["schedulePause"];
  resume: DaemonClient["scheduleResume"];
  delete: DaemonClient["scheduleDelete"];
  logs: DaemonClient["scheduleLogs"];
  runOnce: DaemonClient["scheduleRunOnce"];
}

export function createScheduleActions(
  client: DaemonClient,
  signal: AbortSignal,
): PaseoScheduleActions {
  const action =
    <A extends unknown[], R>(method: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (signal.aborted) return Promise.reject(new Error("Paseo API is disposed"));
      return method(...args);
    };
  return {
    create: action((...args) => client.scheduleCreate(...args)),
    list: action((...args) => client.scheduleList(...args)),
    inspect: action((...args) => client.scheduleInspect(...args)),
    update: action((...args) => client.scheduleUpdate(...args)),
    pause: action((...args) => client.schedulePause(...args)),
    resume: action((...args) => client.scheduleResume(...args)),
    delete: action((...args) => client.scheduleDelete(...args)),
    logs: action((...args) => client.scheduleLogs(...args)),
    runOnce: action((...args) => client.scheduleRunOnce(...args)),
  };
}

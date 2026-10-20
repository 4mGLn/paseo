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
    create: action(client.scheduleCreate.bind(client)),
    list: action(client.scheduleList.bind(client)),
    inspect: action(client.scheduleInspect.bind(client)),
    update: action(client.scheduleUpdate.bind(client)),
    pause: action(client.schedulePause.bind(client)),
    resume: action(client.scheduleResume.bind(client)),
    delete: action(client.scheduleDelete.bind(client)),
    logs: action(client.scheduleLogs.bind(client)),
    runOnce: action(client.scheduleRunOnce.bind(client)),
  };
}

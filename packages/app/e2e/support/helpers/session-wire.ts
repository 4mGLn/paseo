/** Inspect an ordinary session request while preserving any owning transport envelopes. */
export function inspectSessionWireRequest(message: string | Buffer): {
  request: Record<string, unknown>;
  reply(response: unknown): string;
} | null {
  const routes: string[] = [];
  let raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    for (;;) {
      const envelope = JSON.parse(raw);
      if (envelope?.type !== "session" || !envelope.message || typeof envelope.message !== "object")
        return null;
      const request: Record<string, unknown> = envelope.message;
      if (request.type !== "hosts.route.frame.request") {
        return {
          request,
          reply(response) {
            let data = JSON.stringify({ type: "session", message: response });
            for (const subscriptionId of routes.toReversed()) {
              data = JSON.stringify({
                type: "session",
                message: {
                  type: "hosts.route.frame",
                  payload: { subscriptionId, data, binary: false },
                },
              });
            }
            return data;
          },
        };
      }
      if (
        typeof request.routeId !== "string" ||
        typeof request.data !== "string" ||
        request.binary !== false
      )
        return null;
      routes.push(request.routeId);
      raw = request.data;
    }
  } catch {
    return null;
  }
}

import type { MessageSubmissionWriter } from "@/composer/actions";
import type { SessionStoreApi } from "@/stores/session-store";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type UserMessageItem,
} from "@/types/stream";

function appendUntrackedSubmission(
  store: SessionStoreApi,
  serverId: string,
  agentId: string,
  message: UserMessageItem,
) {
  const session = store.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  store
    .getState()
    .setAgentStreamState(serverId, agentId, appendSubmittedUserMessage({ tail, head, message }));
}

function removeUntrackedSubmission(
  store: SessionStoreApi,
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const session = store.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  store
    .getState()
    .setAgentStreamState(
      serverId,
      agentId,
      removeSubmittedUserMessage({ tail, head, clientMessageId }),
    );
}

function createUntrackedMessageSubmissionWriter(
  serverId: string,
  store: SessionStoreApi,
): MessageSubmissionWriter {
  return {
    begin: (agentId, message) => appendUntrackedSubmission(store, serverId, agentId, message),
    accept: () => undefined,
    reject: (agentId, clientMessageId) => {
      removeUntrackedSubmission(store, serverId, agentId, clientMessageId);
      return "rejected";
    },
  };
}

export function createMessageSubmissionWriter(
  serverId: string,
  store: SessionStoreApi,
): MessageSubmissionWriter {
  const supportsTrackedMessageSubmissions =
    store.getState().sessions[serverId]?.serverInfo?.features?.canonicalSubmittedPrompts === true;
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createUntrackedMessageSubmissionWriter(serverId, store);
  }
  return {
    begin: (agentId, message) =>
      store.getState().beginAgentMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      store.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      store.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId),
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
  store: SessionStoreApi,
): boolean {
  return store.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}

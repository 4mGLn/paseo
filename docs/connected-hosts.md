# Connected hosts

A saved host belongs to the daemon that stores it. The app's saved connections remain a separate list.
Connect A to B through `paseo --host A host` or `paseo.hosts`. Consumers select B by its learned `serverId`; management uses the stable
`registrationId` created before B is reachable.

## Ownership and authority

Credentials live in A's `hosts.json`, written atomically with mode `0600` on POSIX systems. Discovery returns a safe
target description. Replacement inputs never come back through a read API. Keep this file private
when collecting diagnostics or backing up daemon state.

The authenticated producer owns its source key. Repeating an unchanged add returns the saved entry,
including a user's disabled state. Changed input requires an explicit update. Display labels and
access can be changed by users with `tunnel.manage`; connection and metadata changes require the
producer or `access.manage`. Removing a producer-managed entry allows that producer to add it again.
Disabling retains the opt-out.

Each enabled registration owns one physical daemon link, shared by status monitoring and every
routed API scope. Each scope owns an isolated virtual session on B. A derives its identity from the
admitted origin session, producer, and logical SDK scope. B admits virtual sessions under the actual
physical link principal, then intersects forwarded caller grants with that link's current authority.
Changing or resuming a parent's grants closes its existing channels; reconnect re-admits demand with
current authority. A routed API cannot select a second hop, and saving a host grants no reverse access.

A producer that registers a host through a routed API is qualified on B as
`route:<B principal>:<A serverId>:<A producer>`, with each component percent-encoded. This namespace belongs to the authenticated link
principal. An ordinary direct B consumer does not become that producer by supplying a source key.
The optional `server_info.sourceId` reports this producer identity separately from the authenticated admission principal.
Trusted server plugins retain the authority of their runtime; they are not sandboxed by this feature.

A managed child has a qualified `{serverId, agentId}` address on every host. The parent's daemon owns membership and lifecycle intent; a destination's parent pointer is metadata. Workspace comparisons include the server ID, so matching workspace strings on different hosts do not share lifecycle ownership. Preserve the archive policy in [agent lifecycle](agent-lifecycle.md). The first child snapshot carries the owner's ledger projection even while creation is pending, because tab placement runs before creation finishes. Explicit clearing survives list and disk-cache round trips; a parent pointer or label cannot recreate membership on a capable daemon.

Retained app conversations bind their stores, queries, initialization and layout to origin authority as well as destination. Two routes to B therefore keep separate cached evidence and command capabilities. Provider catalog pushes belong to that same destination binding, including facts shown in the parent's track. Route restore remembers an origin ID, then reacquires current authority; persisted namespaces grant no access.

Durable relationships retain a stable authority reference and creation ceiling, never live credentials or execution capabilities. Recovery must resolve current authority through its owner. Derived runtime sessions cannot authorize their own recovery. Execution-scoped admissions and non-owner durable references without a supported authority resolver fail explicitly; do not recover them through the daemon owner's MCP runtime.

Before accepting new writes, the daemon adopts eligible pre-feature local parent labels into authoritative membership. The upgrade records its bounded candidates before qualifying agent metadata, then resumes those candidates after interruption. It never rescans later label edits. Existing membership, including forgotten entries, takes precedence; explicit null or qualified parent pointers do not establish legacy provenance. Adopted entries preserve the old daemon-owned local lifecycle, not an authenticated creator grant, and contain no creation recipe to replay. Recovery still resolves current owner authority within the retained self-only ceiling.

Provider-owned subagents are descriptors and timelines in `ProviderSubagentStore`, not `AgentStorage` records. They retain their provider observation/cancellation path. Internal managed agents and execution-owned records are separate stored/runtime concepts and are excluded from adoption on both sides of the relationship.

## Connections and recovery

The shared Node connector owns the target grammar and each connection attempt, including a fresh
SSH process. SSH reaches an already running daemon. The shared client connection lifecycle owns
physical reconnect and keepalive; the registry retains configuration, identity acceptance, and recovery
status. Unreachable registrations remain saved. Identity is pinned when discovered. Self and duplicate
registrations remain inspectable; a changed destination requires explicit identity replacement.

Both daemons advertise `connectedHosts`; the shared link additionally requires `hostMultiplexing`.
A completes capability and pinned-identity checks on each physical recovery before admitting channels. There is no local fallback. An older daemon continues to serve existing local
operations; requesting this feature gives update guidance.

Disposing a routed API releases its observations and session. It does not remove the saved host or
affect sibling API scopes. Disposing the origin cascades to its derived scopes. Observations restore
through the usual owned-subscription contract. The ordinary client queues new requests while connecting
within its existing deadline and rejects requests while disconnected. Connection loss clears old
waiters and queued sends. Submitted requests with no response fail with `DaemonConnectionError`
(`DAEMON_CONNECTION_LOST`), optional `outcome: "unknown"` and known `serverId`. Inspect the destination
before retrying a mutation.
Ordinary non-recoverable mutations are not automatically replayed. Existing acknowledged/idempotent
creation recovery retains its request identity and resumes through the ordinary creation lifecycle. Multiplexing changes only the transport: ordinary permission
RPC codes pass through unchanged, and connection/recovery behavior matches direct clients.

Creation cancellation fences a reserved creation identity before admission. An admitted receipt can precede resource readiness and cannot be reported as canceled. Observe its current receipt and later changes through the ordinary SDK instead of replaying an uncertain prompt. Parent archive retains a pending obligation until cancellation or destination lifecycle confirmation; explicit forget removes local membership without claiming the destination changed.

Run journals retain submission and provider-turn identity. Restarted nonterminal evidence is interrupted, and subsequent evidence must match that turn. Idle and reconnect do not prove completion. A storage failure retains observed evidence with pending durability; a later read retries persistence. Notification recovery must preserve checkpoint identity and this durability distinction.

Text session envelopes carry a channel identifier. Binary routing adds an opcode, a bounded UTF-8
channel identifier, and the original terminal or file-transfer bytes. It never converts those bytes to
base64 JSON. The existing direct binary opcodes and 100 MiB message limit remain unchanged; routed
payloads reserve space for the routing header inside that limit. Relay encryption retains its own
existing frame limit.

Host links cap saved registrations, simultaneous channels, handshake lifetime, frames, physical
output, and aggregate queued bytes. Capacity checks use the actual escaped outer JSON or binary
frame size. Awaitable output completes when the physical send completes. An overflowing channel
closes without closing siblings or the saved link. Routed sessions release resources on disconnect;
subscription demand is rebuilt by its owning client on reconnect.

See the [SDK reference](../public-docs/sdk/reference.md#clienthosts),
[CLI reference](../public-docs/cli.md#connected-hosts), and
[plugin reference](../public-docs/plugins/reference.md#connected-hosts).

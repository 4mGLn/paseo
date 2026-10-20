import {
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  indexedDB as fakeIndexedDb,
} from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { runReplicaRowStoreContract } from "./row-store.contract";
import { createReplicaRowStore, createIndexedDbReplicaRowStore } from "./row-store.web";

globalThis.indexedDB = fakeIndexedDb;
globalThis.IDBKeyRange = FakeIDBKeyRange;

let databaseSequence = 0;

runReplicaRowStoreContract("IndexedDB", async () => {
  const databaseName = `replica-row-store-test-${databaseSequence++}`;
  return {
    store: createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 }),
    async openWithSchemaVersion(schemaVersion) {
      const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion });
      await store.open();
      return store;
    },
  };
});

it("uses exact IndexedDB keys for targeted rows instead of scanning the host", async () => {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-targeted-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  await store.apply({
    upserts: [
      { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
      { serverId: "server-a", kind: "workspace", id: "workspace-1", payload: "workspace" },
    ],
    deletes: [],
  });
  const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll");

  expect(await store.read("server-a", ["agent"], ["agent-1"])).toEqual([
    { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
  ]);
  expect(get).toHaveBeenCalledWith(["server-a", "agent", "agent-1"]);
  expect(getAll).not.toHaveBeenCalled();

  get.mockRestore();
  getAll.mockRestore();
});

it("restores only rows in the selected authority namespace while retaining the destination server ID", async () => {
  const serverId = `B-${crypto.randomUUID()}`;
  const origin = `A-${crypto.randomUUID()}`;
  const direct = createReplicaRowStore();
  const selected = createReplicaRowStore(origin);
  await Promise.all([direct.open(), selected.open()]);
  const row = {
    serverId,
    kind: "agent" as const,
    id: "colliding-agent",
    payload: "broader-direct",
  };
  await direct.apply({ upserts: [row], deletes: [] });
  expect(await selected.read(serverId, ["agent"])).toEqual([]);
  await selected.apply({ upserts: [{ ...row, payload: "selected-authority" }], deletes: [] });
  const restored = createReplicaRowStore(origin);
  await restored.open();
  expect(await restored.read(serverId, ["agent"])).toEqual([
    { ...row, payload: "selected-authority" },
  ]);
  expect(await direct.read(serverId, ["agent"])).toEqual([row]);
  await Promise.all([selected.clear(), direct.deleteHost(serverId)]);
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { searchDirectoryEntries } from "./directory-suggestions.js";

it("suggests an exact filename beyond the default scan budget", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-search-3694-"));
  try {
    for (let i = 0; i < 201; i += 1) {
      const folder = path.join(root, `package-${String(i).padStart(3, "0")}`);
      mkdirSync(folder);
      for (let j = 0; j < 100; j += 1) writeFileSync(path.join(folder, `file-${j}.ts`), "");
    }
    const target = "package-200/xhci-ring.c";
    writeFileSync(path.join(root, target), "");
    const options = {
      root,
      query: "xhci-ring",
      pathFormat: "relative" as const,
      includeFiles: true,
      includeDirectories: false,
    };
    const bounded = await searchDirectoryEntries(options);
    const unbounded = await searchDirectoryEntries({ ...options, maxEntriesScanned: 100_000 });
    console.log(JSON.stringify({ bounded, unbounded }));
    expect(unbounded).toContainEqual({ path: target, kind: "file" });
    expect(bounded).toContainEqual({ path: target, kind: "file" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

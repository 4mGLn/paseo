// Diagnostic reproduction for #3833. Intentionally fails until its behavior is resolved.
// Build: npm run build:main --workspace=@getpaseo/desktop
// Linux: xvfb-run -a node_modules/.bin/electron --no-sandbox packages/desktop/e2e/browser-sandbox.e2e.cjs
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { adaptWebContents } = require("../dist/features/browser-automation/ipc.js");
const { executeAutomationCommand } = require("../dist/features/browser-automation/service.js");
const policies = {
  plain: undefined,
  csp: "default-src 'none'; style-src 'unsafe-inline'",
  sandbox: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  scripts: "default-src 'none'; style-src 'unsafe-inline'; sandbox allow-scripts",
  eval: "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'",
  scriptsEval:
    "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; sandbox allow-scripts",
};
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-browser-sandbox-"));
app.setPath("userData", path.join(fixtureRoot, "user-data"));
(async () => {
  let server, win;
  try {
    await app.whenReady();
    server = createServer((req, res) => {
      const policy = policies[req.url.slice(1)];
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (policy) res.setHeader("Content-Security-Policy", policy);
      res.end("Sandbox text document\nFixture text.");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const consoleMessages = [];
    win.webContents.on("console-message", (_event, level, message) =>
      consoleMessages.push(message),
    );
    const contents = adaptWebContents(win.webContents);
    const registry = {
      listRegisteredBrowserIds: () => ["sandbox-repro"],
      listRegisteredBrowserIdsForWorkspace: () => ["sandbox-repro"],
      getTabContents: (id) => (id === "sandbox-repro" ? contents : null),
      getBrowserWorkspaceId: () => null,
      getWorkspaceActiveBrowserId: () => null,
    };
    const results = {};
    for (const name of Object.keys(policies)) {
      consoleMessages.length = 0;
      await win.loadURL(`http://127.0.0.1:${server.address().port}/${name}`);
      results[name] = {};
      for (const command of ["snapshot", "evaluate"]) {
        try {
          results[name][command] = await executeAutomationCommand(
            {
              type: "browser.automation.execute.request",
              requestId: `${name}-${command}`,
              command: {
                command,
                args: {
                  browserId: "sandbox-repro",
                  ...(command === "evaluate" ? { function: "() => document.body.innerText" } : {}),
                },
              },
            },
            registry,
          );
        } catch (e) {
          results[name][command] = { thrown: e.message };
        }
      }
      results[name].console = [...consoleMessages];
    }
    if (process.env.PASEO_SANDBOX_REPRO_OUTPUT) {
      fs.writeFileSync(process.env.PASEO_SANDBOX_REPRO_OUTPUT, JSON.stringify(results, null, 2));
    }
    for (const name of ["plain", "eval", "scriptsEval"]) {
      assert.equal(results[name].snapshot.ok, true, `${name}: snapshot control`);
      assert.equal(results[name].evaluate.ok, true, `${name}: evaluate control`);
    }
    console.log("PASS: no policy, CSP unsafe-eval, sandbox allow-scripts + unsafe-eval controls");
    for (const name of ["csp", "scripts"])
      assert.equal(results[name].snapshot.ok, true, `${name}: snapshot control`);
    console.log(JSON.stringify(results.sandbox, null, 2));
    // The report accepts a usable snapshot OR an explicit unsupported response.
    const failures = ["snapshot", "evaluate"].filter((command) => {
      const result = results.sandbox[command];
      return !(
        result.ok === true ||
        (result.ok === false && result.error.code === "browser_unsupported")
      );
    });
    assert.deepEqual(
      failures,
      [],
      "Expected success or structured browser_unsupported for sandboxed text",
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
})();

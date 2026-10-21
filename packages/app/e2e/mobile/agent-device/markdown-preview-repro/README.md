# Large Markdown preview restore diagnostic

Reproduces the Android path in [issue #1384](https://github.com/getpaseo/paseo/issues/1384), using the public synthetic document in [the Android report](https://github.com/getpaseo/paseo/issues/1384#issuecomment-6186501327).

## Preconditions

Use an isolated Android emulator with an official Paseo APK and a connected daemon. Generate `mixed-500k.md` from the report's public generator with seed 1. Verify its SHA-256 is `23a5ec243319e62c5314523b44db8854c0b4d305793be74bc8e33cd16b48a0bc` (467,495 bytes).

1. Open a workspace containing the fixture.
2. Open Explorer → Files → `mixed-500k.md`, with Preview selected.
3. Return the preview to the top, where its heading is `Partition review payload limit`. Leave this file selected and close the application.
4. Run the diagnostic on that emulator:

```sh
agent-device test packages/app/e2e/mobile/agent-device/markdown-preview-repro/restore.android.ad --platform android --device <emulator-name>
```

The heading must become accessibility-visible within 15 seconds after application launch. This is a diagnostic responsiveness bound, not a product rendering SLA. The check includes startup, reconnection, rendering, and accessibility collection. A failure before Preview, or with the document scrolled away from its heading, does not establish a Markdown rendering failure.

## Observed comparison

On the same Android 15/API 35 emulator, with identical document bytes and a Linux daemon:

- Official 0.11.2 (versionCode 11002): the diagnostic failed its heading wait, completing in 16.6 seconds. A native stack during restore captured the main thread in `SpannableStringBuilder.restoreInvariants`, through React Native `TextLayoutManager` and Fabric mounting. The document eventually appeared.
- Official 0.12.0 (versionCode 12000): the same diagnostic passed in 1.32 seconds after returning the document to the top. The preview also scrolled successfully.

An initial 0.12.0 launch stopped at Loading workspace; selecting the fixture workspace again recovered it. A separate run with the preview left scrolled down failed the heading check, as expected from the precondition. Neither result is attributed to Markdown rendering.

No Android ANR dialog or white-screen crash was observed. Physical Android devices, iOS, desktop, private documents, and the reported inability to close the file remain unverified. The version comparison does not isolate an individual commit as the sole cause of the difference.

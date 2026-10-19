# About version clipping reproduction ([#4368](https://github.com/getpaseo/paseo/issues/4368))

This is a diagnostic branch, with no production fix. The Android test compares
React Native's measured box for `v0.12.0` with the native TextView layout that
renders the same attributed text. It runs both ordinary and system-bold text.
It does not turn off accessibility scaling or bold text.

## Run the native test

From the repository root, prepare a development Android project if necessary:

```sh
cd packages/app
APP_VARIANT=development npx expo prebuild --platform android --no-install
```

In generated `android/app/build.gradle`, add:

```groovy
android.defaultConfig.testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
dependencies {
    androidTestImplementation 'androidx.test:runner:1.6.2'
    androidTestImplementation 'androidx.test.ext:junit:1.2.1'
}
```

Copy this test into the generated test source set, then build the app and tests:

```sh
mkdir -p android/app/src/androidTest/java/sh/paseo/diagnosis
cp e2e/mobile/about-font-size/AboutFontWeightTest.java android/app/src/androidTest/java/sh/paseo/diagnosis/
cd android
APP_VARIANT=development ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 -Dorg.gradle.parallel=false
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class sh.paseo.diagnosis.AboutFontWeightTest \
  sh.paseo.debug.test/androidx.test.runner.AndroidJUnitRunner
```

The test requires Android 12 or later for `fontWeightAdjustment`. The native
contexts set that adjustment to 0 and 300 independently; they do not change the
device setting. The selected device's density and font scale still apply.

On Android 16 at 540 dpi and 2× font scale, both contexts receive a 301×123-pixel
box. The ordinary-weight control passes, with one rendered line. The bold test
fails with two rendered lines, so the final digit falls outside the allocated
single-line height. This isolates the measurement/rendering disagreement from
the About row's flex layout. A native dependency/build decision is still needed
before implementing a fix; changing an About-row style would leave the producer
of the incorrect measurement in place.

## UI comparison

Observed on Android 16, with current main's JavaScript and a freshly built native
development app: open Settings → About with 2× system font scale and 540 dpi on
a 1080-pixel-wide emulator. With system bold text, the displayed app version
loses its final digit (`v0.12.`). At the same display and text sizes without
system bold, the complete `v0.12.0` is visible. Cold-launch after configuration
changes before comparing; changing font scale in a running app also produced
temporary vertical clipping, which disappeared after a cold launch.

This substitutes standard Android accessibility settings for Samsung Easy Mode.
It verifies the truncated-version symptom, not Samsung's complete UI or the
already-fixed home-screen overlap. The reporter used Paseo 0.7.2; this branch
uses main `dd244c076d5f17d56d5592c7fb173dc7fdc2bbae`.

# home web viewer (Android)

The `home.xinutec.org` dashboard as an app: one full-screen WebView, no browser
chrome. The WebView itself — insets, system-bar colours, Back — is the fleet's
shared shell in `ui-harness/android`, which must be checked out beside this
repo. This app only names the URL (`MainActivity.HOME_URL`).

The dashboard is public over HTTPS, so the app needs only `INTERNET`.

Android 8+ (minSdk 26).

## Build & install

The toolchain is borrowed from the recall project's `android` dev shell (JDK
17 + Android SDK; the Gradle wrapper pins Gradle). `deploy.sh` builds and
installs to the Pixel 9, checking the model so it never installs elsewhere:

```sh
cd android
nix develop ~/Code/recall#android --command ./deploy.sh [<ip[:port]>]
```

To build only:

```sh
nix develop ~/Code/recall#android --command ./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

The APK is signed with the debug key; sideloading is the only distribution.

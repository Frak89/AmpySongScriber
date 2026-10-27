# AmpySongScriber — Android

Porting project for Songscribe 1.2.1 on Android via Next.js static export + Capacitor.

Original project: [gabe-serna/songscribe](https://github.com/gabe-serna/songscribe) at commit `c46a942a00d9445a15895461ae55910da0f3cbd7`. Originally by Gabriel Serna, MIT license.

## Get the APK

Go to **Actions → Build AmpySongScriber APK → Run workflow**. When successful, open **Artifacts** and download **AmpySongScriber-Android-debug**. Extract and install `app-debug.apk` on your Android device.

The Android interface is bundled into the APK, but AI audio separation, transcription, and YouTube import depend on the separate Python backend [gabe-serna/songscribe-api](https://github.com/gabe-serna/songscribe-api), not in the uploaded archive.

The **⚙ API** button saves your backend URL on-device. The backend must be reachable from the phone and allow CORS requests from `https://localhost`. Flat.io sheet-music/PDF additionally needs separate credentials.

Build stack: JDK 21, Android SDK API 36, Node 20, Capacitor 8. This is an installable **debug** APK, not a signed production release.

### Local build

```bash
git clone https://github.com/Frak89/AmpySongScriber.git
cd AmpySongScriber
git clone https://github.com/gabe-serna/songscribe.git source
cd source && git checkout c46a942a00d9445a15895461ae55910da0f3cbd7 && cd ..
node scripts/prepare-source.mjs source
cd source
npm ci --legacy-peer-deps
npm install --no-save --package-lock=false --legacy-peer-deps @capacitor/core@8 @capacitor/cli@8 @capacitor/android@8
npm run build
npx cap add android
cd android && ./gradlew :app:assembleDebug
```

Original frontend's audio output/downloads and cloud score services need device testing. Offline ML transcription is **not** implemented. Use HTTPS for backend deployment; HTTP is allowed only to facilitate LAN testing.
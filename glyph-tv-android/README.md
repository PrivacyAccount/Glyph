# GlyphTV Android (APK)

Dieses Unterprojekt ist eine native Android-TV App (Kotlin + Compose + ExoPlayer), die gegen den Glyph Server arbeitet.

## Enthaltene V1-Funktionen

- Pairing-Flow gegen `/api/tv/v1/pairing/start` und `/api/tv/v1/pairing/status`
- Home-Ansicht (`/api/tv/v1/home`)
- Libraries (`/api/tv/v1/libraries`)
- Videos je Library (`/api/tv/v1/libraries/:id/videos`)
- Playback-Start (`/api/tv/v1/videos/:id/playback`) mit ExoPlayer

## Projektpfad

- `glyph-tv-android/`

## APK bauen

1. Android Studio installieren (inkl. Android SDK Platform 34).
2. Projekt `glyph-tv-android` in Android Studio öffnen.
3. Falls nötig `local.properties` anlegen:
   - `sdk.dir=C:\\Users\\<dein-user>\\AppData\\Local\\Android\\Sdk`
4. Build:
   - Android Studio: Build -> Build APK(s)
   - oder CLI: `gradlew.bat assembleDebug`

Ausgabe:
- `app/build/outputs/apk/debug/app-debug.apk`

## Hinweis

- `android:usesCleartextTraffic="true"` ist gesetzt, damit lokale HTTP-Server-URLs wie `http://10.0.2.2:4000` funktionieren.


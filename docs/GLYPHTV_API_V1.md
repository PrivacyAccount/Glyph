# GlyphTV API V1 (Entwurf)

Ziel: TV-Client (Android TV / Fire TV) mit stabilen, UI-unabhaengigen Endpoints.

Base URL:
- `http://<glyph-server>:4000/api/tv/v1`

## 1. Auth / Pairing

### 1.1 Pairing starten
- `POST /pairing/start`
- Request:
```json
{
  "deviceName": "Living Room TV",
  "platform": "android-tv"
}
```
- Response:
```json
{
  "pairingCode": "4H7K9P",
  "expiresAt": "2026-03-11T16:10:00.000Z",
  "pollIntervalMs": 2000
}
```

### 1.2 Pairing Status pollen
- `GET /pairing/status?code=4H7K9P`
- Response (pending):
```json
{
  "status": "pending"
}
```
- Response (approved):
```json
{
  "status": "approved",
  "token": "<jwt-or-random-token>",
  "tokenType": "Bearer",
  "expiresInSec": 2592000
}
```

## 2. Home

### 2.1 Home-Feed
- `GET /home`
- Header: `Authorization: Bearer <token>`
- Response:
```json
{
  "continueWatching": [
    {
      "videoId": "abc123",
      "title": "Episode 1",
      "thumbnailUrl": "/api/videos/abc123/thumbnail",
      "durationSec": 1420,
      "progressSec": 511,
      "updatedAt": "2026-03-11T15:20:00.000Z"
    }
  ],
  "recentByLibrary": [
    {
      "libraryId": "f70a726e-6b34-486d-8ac0-a67b2f2e7af0",
      "libraryName": "2D",
      "items": [
        {
          "videoId": "v1",
          "title": "Video 1",
          "thumbnailUrl": "/api/videos/v1/thumbnail"
        }
      ]
    }
  ],
  "playlists": [
    {
      "id": "pl1",
      "name": "Favoriten",
      "count": 23
    }
  ]
}
```

## 3. Libraries & Browse

### 3.1 Libraries
- `GET /libraries`
- Response:
```json
{
  "items": [
    {
      "id": "82cd464a-5a04-417c-9ed8-22d93b6a4f32",
      "name": "HStream",
      "type": "series",
      "videoCount": 120
    }
  ]
}
```

### 3.2 Serien-Ordner einer Library
- `GET /libraries/:libraryId/series`
- Response:
```json
{
  "items": [
    {
      "id": "folder_1",
      "name": "Show Name",
      "path": "F:\\Hentai\\HStream\\Show Name",
      "videoCount": 12,
      "posterUrl": "/api/poster?path=..."
    }
  ]
}
```

### 3.3 Serien-Detail (Folgen)
- `GET /series/detail?path=<encoded-path>`
- Response:
```json
{
  "name": "Show Name",
  "seasons": [
    {
      "name": "Season 1",
      "videos": [
        {
          "id": "vid_44",
          "title": "Episode 1",
          "duration": 1412,
          "thumbnailUrl": "/api/videos/vid_44/thumbnail"
        }
      ]
    }
  ],
  "videos": []
}
```

### 3.4 Flat Videos einer Video-Library
- `GET /libraries/:libraryId/videos?sort=recent|name&page=1&pageSize=60`
- Response:
```json
{
  "items": [
    {
      "id": "vid_1",
      "title": "Clip A",
      "duration": 621,
      "thumbnailUrl": "/api/videos/vid_1/thumbnail",
      "tags": ["tag1", "tag2"]
    }
  ],
  "page": 1,
  "pageSize": 60,
  "total": 932
}
```

## 4. Suche

### 4.1 Globale Suche
- `GET /search?q=umbreon&type=all|videos|series&page=1&pageSize=40`
- Response:
```json
{
  "items": [
    {
      "kind": "video",
      "id": "vid_33",
      "title": "[WhisperingForNothing] Umbreon",
      "libraryId": "f70a726e-6b34-486d-8ac0-a67b2f2e7af0",
      "thumbnailUrl": "/api/videos/vid_33/thumbnail"
    }
  ],
  "page": 1,
  "pageSize": 40,
  "total": 1
}
```

## 5. Playback

### 5.1 Playback-Info laden
- `GET /videos/:videoId/playback`
- Response:
```json
{
  "videoId": "vid_33",
  "title": "Umbreon",
  "streamUrl": "/api/videos/vid_33/stream",
  "directUrl": "/api/videos/vid_33/play",
  "subtitleTracksUrl": "/api/videos/vid_33/subtitle-tracks",
  "audioTracksUrl": "/api/videos/vid_33/audio-tracks",
  "previewUrl": "/api/videos/vid_33/preview",
  "durationSec": 1337,
  "lastProgressSec": 511
}
```

### 5.2 Watch Progress updaten
- `POST /watch-progress`
- Request:
```json
{
  "videoId": "vid_33",
  "positionSec": 777,
  "durationSec": 1337
}
```
- Response:
```json
{
  "ok": true
}
```

### 5.3 Watch Progress lesen
- `GET /watch-progress?videoId=vid_33`
- Response:
```json
{
  "videoId": "vid_33",
  "positionSec": 777,
  "durationSec": 1337,
  "updatedAt": "2026-03-11T15:40:00.000Z"
}
```

## 6. Playlists

### 6.1 Listen
- `GET /playlists`
- Response:
```json
{
  "items": [
    { "id": "pl1", "name": "Favoriten", "count": 23 }
  ]
}
```

### 6.2 Playlist Videos
- `GET /playlists/:id/videos?page=1&pageSize=60`

## 7. Fehlerformat

Alle Fehler konsistent:
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Video not found",
    "details": null
  }
}
```

Empfohlene Codes:
- `BAD_REQUEST`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `INTERNAL`

## 8. Mapping auf bestehende Endpoints (Ist-Stand)

Diese V1 kann intern auf bestehende APIs aufsetzen:
- `GET /api/tv/v1/libraries` -> `GET /api/libraries`
- `GET /api/tv/v1/libraries/:id/videos` -> `GET /api/libraries/:id/videos`
- `GET /api/tv/v1/libraries/:id/series` -> `GET /api/libraries/:id/folders`
- `GET /api/tv/v1/series/detail` -> `GET /api/series/detail`
- `GET /api/tv/v1/playlists` -> `GET /api/playlists`
- `GET /api/tv/v1/playlists/:id/videos` -> `GET /api/playlists/:id/videos`
- `GET /api/tv/v1/videos/:id/playback` -> `GET /api/videos/:id/play` + `GET /api/videos/:id/stream` + `GET /api/watch-progress`
- `POST /api/tv/v1/watch-progress` -> `POST /api/watch-progress`
- `GET /api/tv/v1/watch-progress` -> `GET /api/watch-progress`

## 9. Nicht-funktionale Mindestanforderungen (TV)

- Timeouts: max. 6s fuer Browse/Home, 10s fuer Search.
- Pagination: Pflicht ab 60+ Items.
- ETag/Cache-Control fuer Home/Library Listen.
- Bilder immer mit klein/gross-Varianten (`w342`, `w780` o.ae.).
- Keine UI-abhängigen Felder im API-Contract.


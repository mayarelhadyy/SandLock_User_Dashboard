# SandLock — Final PWA (Android + iPhone)

Final installable build of the approved SandLock app. The existing 19-screen design and logic are preserved: dynamic locker map, minute-level booking, cancellation, 15-minute reminder, 3× overtime fee, mobile/device time sync, reservation PIN flow, and HiveMQ MQTT communication.

## Test on the laptop
Run inside this folder:

```bash
python3 -m http.server 8080
```

Then open:

`http://localhost:8080`

Modern browsers treat localhost as a secure context, so the manifest and service worker work there.

## Install on Android / iPhone
On a phone, PWA installation/service workers require the app to be served through **HTTPS**. Upload this folder unchanged to an HTTPS static host.

### Android
Open the HTTPS link in Chrome or Edge, then use **Install app** / **Add to Home screen** when offered. SandLock opens in standalone mode.

### iPhone / iPad
Open the HTTPS link in Safari → **Share** → **Add to Home Screen**. Launch SandLock from the Home Screen icon.

## PWA layer added
- `manifest.webmanifest` — install metadata, portrait standalone mode, theme/background colors, normal + maskable icons.
- `service-worker.js` — cached app shell/static assets, navigation fallback, update-safe runtime cache, notification click handling.
- `pwa.js` — service-worker registration, install capability handling, standalone-mode detection, service-worker notification helper.
- `icons/` — Android, maskable, favicon, and Apple Touch icons.

## MQTT
The approved HiveMQ configuration remains unchanged in `config.js`. Locker A is the real MQTT-enabled prototype locker. The web/PWA uses secure WebSocket (WSS), while the ESP32 uses the separate TLS MQTT connection.

## 15-minute reminder
At booking confirmation the app requests notification permission when the browser allows it. When permission is granted, the 15-minute reminder uses the PWA service-worker notification API; the existing in-app reminder remains as a fallback.

Platform limitation: a browser-only PWA cannot guarantee a future local notification after the app has been fully terminated. Guaranteed reminders while the app is completely closed require Web Push from a backend (or a native notification scheduler). This does not affect reservation timing, late-fee logic, map status, or MQTT operation.

## Prototype credential note
The browser MQTT credential is necessarily visible to browser users because front-end JavaScript is client-side. Keep its HiveMQ permission restricted to the prototype topic tree. For production, use a backend/token service and rotate credentials that have been exposed during testing.

## v7 — account persistence + cross-device reservation sync
This build keeps the approved visual design/mobile scale unchanged while adding the user-app synchronization layer requested for the semi-final prototype.

- Persistent sign-in: a user returns directly to the map until explicit Log Out.
- Prototype account identity is derived from **full name + mobile number only**. Payment card data is excluded from account identity.
- Reservations and reservation history sync between phones signed in with the same name + mobile through retained HiveMQ app-sync topics.
- The local payment method stays device-local; only the existing last-four-digits behavior is retained.
- Shared locker availability is synchronized so another phone sees a reserved locker without needing the original phone.
- Claim-based conflict protection reduces simultaneous double-booking attempts before a reservation is committed.
- One-user/one-open-locker policy remains enforced after cross-device synchronization.
- Reservation times are limited to the next **24 hours** from the phone/device clock.
- User-created reservation PIN `0000` is blocked because it is reserved for owner emergency access.
- Existing ESP32 topics and approved HiveMQ configuration remain unchanged; new app-sync topics stay inside the already permitted `sandlock/locker/A/#` tree.

### Production note
This version is intentionally compatible with the current static PWA + HiveMQ prototype. The name+phone identity and MQTT claim protocol are appropriate for the competition prototype, but production-grade authentication and strict atomic booking guarantees should later be moved to an always-on backend/database (for example, phone OTP + transactional reservation records). The future dashboard backend can consume the same app events and persist them without changing the approved app layout.

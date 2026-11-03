# SafeHer

SafeHer is a mobile-first Women Safety and Emergency Alert web application and installable Progressive Web App (PWA). Designed with a clean, flat aesthetic, SafeHer delivers rapid access to emergency alerts, live GPS location sharing, nearby safety resources, community volunteer response, and discreet protection tools directly in the browser.

---

## Features

- **Emergency SOS Modes**:
  - **Normal Mode**: 5-second countdown with cancel option, live GPS coordinates, OpenStreetMap Leaflet map, direct 112 dialing, and instant alert dispatch to contacts via WhatsApp and SMS.
  - **Silent Mode**: Stealth black screen disguise preventing detection while continuing live tracking. Protected by 3-tap unlock and safety PIN.
  - **Emergency Mode**: Full alert screen with flashing high-contrast banner, continuous Web Audio siren, and device vibration pattern.
- **PWA & Offline Capability**:
  - Installable standalone mobile app with custom maskable icons and theme colors.
  - Service worker caching core app shell and assets for offline use.
  - Dedicated offline fallback screen (`offline.html`) when network connectivity is lost.
  - Home screen app shortcut (`/?sos=1`) to trigger emergency SOS countdown immediately upon launch.
- **Live Location & Safety Map**:
  - Live GPS tracking via `navigator.geolocation.watchPosition`.
  - Leaflet + OpenStreetMap interactive map with accuracy circle.
  - Color-coded safety zones legend (Safe, Moderate, Caution).
  - Quick location sharing via Web Share API and Google Maps clipboard link.
- **Nearby Places (Police & Hospitals)**:
  - Discovers open emergency amenities within 3 km using Overpass API queries.
  - Haversine formula calculation for exact distance from current location.
  - Turn-by-turn directions via Google Maps and direct phone call actions.
  - Automatic fallback caching for offline or slow network conditions.
- **Community Volunteer Network**:
  - "Available to help" status toggle saving volunteer location.
  - Cross-tab active alert detection within a 2 km proximity radius.
  - "I'm coming" response updates active SOS screens in real time.
- **Safe Timer**:
  - Adjustable countdown timer (5, 10, 15, 30, 60 mins) with trusted contact selection.
  - Circular SVG progress indicator that persists across browser refreshes.
  - Automatically triggers emergency SOS if not cancelled with "I'm Safe".
- **Fake Call**:
  - Realistic incoming phone call simulation with customizable caller names and delays (now, 10s, 30s).
  - Web Audio API dual-tone synthesis for ringtone and continuous vibration patterns without external audio files.
  - Realistic call screen with active call timer, keypad, mute, and speaker controls.
- **Audio Evidence Recorder**:
  - In-browser microphone audio recording using the MediaRecorder API.
  - Persistent local storage of recordings using client-side IndexedDB.
  - Playback, duration calculation, and recording management.
- **Trusted Emergency Contacts**:
  - Add, edit, and delete emergency contacts with relationship tags.
  - One-tap WhatsApp, SMS, and direct phone dialer actions.
- **Emergency Helplines Directory**:
  - Quick-dial cards for national emergency lines: 112 (National Emergency), 1091 (Women Helpline), 1090 (Women Power Line), 181 (Domestic Abuse), and 1098 (Child Helpline).
- **Security PIN**:
  - 4-digit custom safety PIN required to end active SOS alerts or modify security settings.
- **Multilingual Support (i18n)**:
  - Instant UI switching between English, Kannada, and Hindi across all screens and notifications.

---

## How to Run

SafeHer requires no build tools, npm packages, or compilers. It runs directly as standard vanilla web technologies.

### Method 1: Direct File Opening
Open `index.html` directly in any modern mobile or desktop web browser (Google Chrome, Safari, Firefox, Microsoft Edge).

### Method 2: Local HTTP Server
Run a local static file server from the project directory:

```bash
# Using Python 3
python -m http.server 8000

# Using Node.js (npx)
npx serve .
```

Open `http://localhost:8000` in your browser.

### Method 3: GitHub Pages
SafeHer is configured with relative paths (`./`) and runs seamlessly in any GitHub Pages subfolder:
`https://<username>.github.io/Safeher/`

---

## File Structure

```
Safeher/
├── index.html              # Main single-page application entry point
├── offline.html            # PWA offline fallback screen
├── track.html              # Public emergency tracking page with live Leaflet map
├── admin.html              # Admin verification dashboard protected by ADMIN_KEY
├── manifest.webmanifest    # PWA configuration, icons, and SOS shortcut
├── sw.js                   # Service worker with offline asset caching and Web Push handlers
├── README.md               # Project documentation and specifications
├── RULES.md                # Architecture, design rules, and constraints
├── css/
│   └── style.css           # Flat mobile-first stylesheets and design variables
├── js/
│   ├── api.js              # Data abstraction layer for client & backend endpoints
│   ├── app.js              # Global router, toast system, and initialization
│   ├── auth.js             # Authentication, registration, OTP validation, and login
│   ├── contacts.js         # Emergency contacts management
│   ├── evidence.js         # Audio recording and IndexedDB storage
│   ├── fakecall.js         # Fake call simulator with Web Audio sound & vibration
│   ├── home.js             # Home dashboard, SOS trigger, and tile navigation
│   ├── i18n.js             # Internationalization (English, Kannada, Hindi)
│   ├── map.js              # Live GPS tracking, Leaflet map, and safety zones
│   ├── onboarding.js       # Welcome walkthrough screens
│   ├── pin.js              # 4-digit safety PIN keypad protection
│   ├── police.js           # Overpass API nearby police and hospital finder
│   ├── profile.js          # User profile, notifications, alert history, and data reset
│   ├── sos.js              # Multi-mode SOS alert logic, timer, and sirens
│   ├── storage.js          # localStorage helper utilities
│   ├── timer.js            # Safe Timer countdown and automatic escalation
│   ├── tips.js             # Safety tips and self-defense guidance
│   └── volunteer.js        # Community volunteer proximity alert coordination
└── assets/
    ├── logo.png            # App logo
    ├── icon-192.png        # 192x192 PWA application icon
    ├── icon-512.png        # 512x512 PWA application icon
    ├── icon-maskable.png   # 512x512 PWA maskable adaptive icon
    ├── onboard1.svg        # Onboarding illustration 1
    ├── onboard2.svg        # Onboarding illustration 2
    ├── onboard3.svg        # Onboarding illustration 3
    └── success.svg         # Signup completion illustration
```

---

## Working Now / Needs Backend

| Feature | Working Now (Integrated with Flask Backend) | Next Production Enhancements |
|---|---|---|
| **SOS Alerts** | Triggers countdown, saves alert, generates public token, emails contacts via Gmail SMTP, dispatches Web Push notifications. | Automated SMS gateway (e.g. Twilio/Fast2SMS) for cellular fallback. |
| **Silent SOS** | Black screen disguise, background location streaming, notifies verified volunteers within range with no sound. | Native background location streaming while device screen is locked. |
| **Emergency Siren** | Synthesized dual-tone siren audio and vibration patterns via Web Audio API. | Direct computerized dispatch integration with local police authorities. |
| **Public Live Tracking** | Standalone `track.html` polling every 5s with Leaflet live map, status, and en-route volunteers. | Crowdsourced historical heatmaps and danger zone ratings. |
| **Volunteer Network** | Verification with notes, admin approval via `admin.html`, 5s cross-phone polling, Web Push nearby alerts. | Volunteer navigation route optimization and turn-by-turn routing. |
| **Web Push Notifications** | VAPID keypair in `.env`, pywebpush dispatch, service worker event handling, 404/410 auto-pruning. | Push notification grouping and rich action buttons. |
| **Safe Timer** | Countdown timer with active escalation daemon; auto-triggers SOS alert and emails contacts after deadline. | Contact acknowledgement confirmation tokens. |
| **Admin Dashboard** | Standalone `admin.html` with ADMIN_KEY header auth, live platform stats, and volunteer approve/reject actions. | Multi-role administrator hierarchy with audit logs. |
| **User & Contact Data** | SQLite database with JWT authentication, password hashing, and user-scoped contact CRUD. | Production PostgreSQL replication and Redis caching. |

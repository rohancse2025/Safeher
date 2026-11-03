# SafeHer Backend

Lightweight REST API backend for the SafeHer Women Safety and Emergency Alert web application. Built with Python 3, Flask, and SQLite.

---

## Requirements

- Python 3.9+
- pip (Python package installer)

---

## Installation & Setup

### 1. Navigate to the backend directory
```bash
cd backend
```

### 2. Create and activate a Python virtual environment
```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. Install required dependencies
```bash
pip install -r requirements.txt
```

### 4. Configure environment variables
Copy the example environment file to `.env`:
```bash
# Windows
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Edit `.env` to configure your settings:
- `SECRET_KEY`: Random secret string for JWT and session security.
- `ALLOWED_ORIGINS`: Comma-separated CORS origins (localhost ports and your GitHub Pages domain).
- `FRONTEND_URL`: URL of the hosted frontend (e.g. `https://<username>.github.io/Safeher`).
- `DATABASE_PATH`: SQLite database file path (defaults to `safeher.db`).
- `PORT`: Server port (defaults to `5000`).
- `ADMIN_KEY`: Admin secret key for volunteer approvals and platform metrics.
- `VAPID_PUBLIC_KEY`: Base64url VAPID public key for Web Push.
- `VAPID_PRIVATE_KEY`: Base64url raw 32-byte VAPID private key.
- `VAPID_CLAIMS_SUB`: Contact email/subject for VAPID claims (e.g. `mailto:admin@safeher.local`).

---

## Running the Server

Start the Flask application:

```bash
python app.py
```

The database (`safeher.db`) and all 7 tables (`users`, `contacts`, `alerts`, `locations`, `volunteers`, `responses`, `timers`) will be **created automatically** on the first run.

---

## API Endpoints

### 1. System Health
- **`GET /api/health`** – Verifies server status and database connectivity.

### 2. Authentication
- **`POST /api/register`** – Creates account with hashed password (`name`, `phone`, `email`, `password`). Returns JWT.
- **`POST /api/login`** – Authenticates user with phone & password. Returns JWT token.
- **`GET /api/me`** *(Auth required)* – Retrieves current authenticated user profile.

### 3. Safety PIN Management
- **`POST /api/pin/set`** *(Auth required)* – Sets 4-digit hashed safety PIN and optional duress PIN.
- **`POST /api/pin/change`** *(Auth required)* – Updates PIN (verifies old PIN first).
- **`POST /api/pin/verify`** *(Auth required)* – Validates PIN; returns `"ok"`, `"duress"`, or `"wrong"`. Implements 30-second lockout after 5 failed attempts.

### 4. Emergency Contacts (Per-User)
- **`GET /api/contacts`** *(Auth required)* – Lists contacts for authenticated user.
- **`POST /api/contacts`** *(Auth required)* – Adds contact (`name`, 10-digit `phone`, optional `email`, `relationship`).
- **`PUT /api/contacts/<id>`** *(Auth required)* – Updates user's contact.
- **`DELETE /api/contacts/<id>`** *(Auth required)* – Deletes user's contact.

### 5. Emergency Alerts & Live Tracking
- **`POST /api/alerts`** *(Auth required)* – Initiates an emergency alert (`mode`: `"normal"|"silent"|"emergency"`, `lat`, `lng`). Generates random `share_token`, records first location, and dispatches background emails to emergency contacts.
- **`POST /api/alerts/<id>/location`** *(Auth required)* – Appends real-time coordinates to tracking history for an active alert.
- **`POST /api/alerts/<id>/end`** *(Auth required)* – Ends alert with 4-digit PIN. If duress PIN is submitted, returns success to attacker while silently keeping alert active with `duress=1`.
- **`GET /api/alerts`** *(Auth required)* – Returns full chronological alert history for current user.

### 6. Public Tracking (No Auth)
- **`GET /api/track/<share_token>`** – Public live-tracking link returning only first name, mode, status, latest coordinates, last updated time, and number of volunteers on the way. Never exposes personal contact information.

### 7. Email Testing
- **`POST /api/test-email`** *(Auth required)* – Sends a diagnostic test email to the user's registered address using Gmail SMTP.

### 8. Volunteer Network
- **`POST /api/volunteers/status`** *(Auth required)* – Saves volunteer availability (`available`: true/false) and latest GPS coordinates.
- **`GET /api/volunteers/nearby-alerts`** *(Auth required)* – Finds active alerts within 2 km of volunteer's position using the Haversine formula (excludes own alerts; hides names on silent alerts).
- **`POST /api/alerts/<id>/respond`** *(Auth required)* – Volunteer responds to an alert with `"coming"` or `"cannot"`.
- **`GET /api/alerts/<id>/status`** *(Auth required, owner only)* – Returns how many volunteers are currently on the way.
- **`GET /api/volunteers/count`** – Returns the number of currently available volunteers.

### 9. Safe Timers & Background Escalation
- **`POST /api/timers`** *(Auth required)* – Starts a countdown timer (`minutes`, optional `contact_id`).
- **`POST /api/timers/<id>/safe`** *(Auth required)* – Cancels/marks a running timer safe.
- **`GET /api/timers/active`** *(Auth required)* – Returns user's currently running timer with remaining seconds.
- **Background Daemon**: Checks every 10 seconds for expired timers. Automatically generates an active SOS alert with mode `"timer"` using last known coordinates, dispatches emergency emails to contacts, and marks the timer `"expired"`.

### 10. Web Push Notifications
- **`GET /api/push/vapid-public-key`** – Returns public VAPID key for client subscriptions.
- **`POST /api/push/subscribe`** *(Auth required)* – Registers a Web Push subscription (`endpoint`, `p256dh`, `auth`).
- **`POST /api/push/unsubscribe`** *(Auth required)* – Removes a subscription (`endpoint`).
- **Automatic Triggers:**
  1. Nearby available approved volunteers within 2 km receive "Someone nearby needs help" (distance only, no name) when a normal or emergency alert starts.
  2. Silent alerts notify nearby volunteers only, with `silent: true` (no sound).
  3. Victim receives a push when a volunteer taps "I'm coming".
  4. User receives a push when their safe-arrival timer expires.
  5. Expired 404/410 subscriptions are automatically pruned.

### 11. Admin Management (Protected by ADMIN_KEY)
- **`GET /api/admin/stats`** – Platform metrics: total users, active alerts, alerts today, approved volunteers.
- **`GET /api/admin/volunteers/pending`** – Lists pending volunteer applications.
- **`POST /api/admin/volunteers/<id>/approve`** – Approves a volunteer for alert matching.
- **`POST /api/admin/volunteers/<id>/reject`** – Rejects a volunteer application.

---

## Response Convention

All endpoints follow this consistent JSON structure:
- **Success:** `{"ok": true, "data": ...}`
- **Error:** `{"ok": false, "error": "Clear description of error"}`

---

## Database Schema

The database uses SQLite (built-in module, no ORM) with foreign key constraints enabled:

- **`users`**: User profiles with phone uniqueness and hashed credentials (`password_hash`, `pin_hash`, `duress_pin_hash`).
- **`contacts`**: Emergency contacts linked to users.
- **`alerts`**: Emergency SOS records with mode, coordinates, status, and unique share tokens.
- **`locations`**: Live GPS tracking history for active alerts.
- **`volunteers`**: Nearby volunteer coordinates and availability status.
- **`responses`**: Volunteer dispatch responses to active alerts.
- **`timers`**: Safe Timer records and automatic escalation deadlines.
- **`push_subscriptions`**: Web Push subscription endpoints and crypto keys per user (`endpoint`, `p256dh`, `auth`).

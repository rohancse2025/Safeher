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
- **`POST /api/alerts`** *(Auth required)* – Initiates an emergency alert (`mode`: `"normal"|"silent"|"emergency"`, `lat`, `lng`, optional `note`).
- **`POST /api/alerts/<id>/location`** *(Auth required)* – Appends real-time coordinates to tracking history for an active alert.
- **`POST /api/alerts/<id>/end`** *(Auth required)* – Ends alert with 4-digit PIN. If duress PIN is submitted, returns success to attacker while silently keeping alert active with `duress=1`.
- **`GET /api/alerts`** *(Auth required)* – Returns full chronological alert history for current user.

### 6. Public Tracking & Contact Responses (No Auth)
- **`GET /api/track/<token>`** – Accepts either a general `share_token` (read-only) or a personalized `contact_token`.
  - For `share_token`: Returns read-only alert status (`is_contact: false`, alert owner's `first_name`, `mode`, `status`, `latest_lat`, `latest_lng`, `last_update_time`, `volunteers_en_route`).
  - For `contact_token`: Returns contact personalization (`is_contact: true`, `contact_first_name`, `contact_name`, alert owner's `first_name`, `mode`, `status`, `latest_lat`, `latest_lng`, `last_update_time`, `volunteers_en_route`).
  - Never exposes phone number, email, or credentials.
- **`POST /api/track/<token>/respond`** – Allows trusted contacts to respond directly from `track.html` without logging in:
  - Expects JSON: `{"status": "on_my_way" | "called" | "alerted_police" | "cannot_reach"}`.
  - Valid ONLY with a `contact_token` and an active alert.
  - Rate-limited to 10 responses per hour per contact token.
  - Recorded in the `contact_responses` table with timestamp.
  - Dispatches an instant Web Push notification to the alert owner if subscribed.

### 7. Email Testing
- **`POST /api/test-email`** *(Auth required)* – Sends a diagnostic test email to the user's registered address using Gmail SMTP.

### 8. Volunteer Network & KYC Application System
*Full-fledged multi-step volunteer onboarding with strict safety training, identity document verification, reference checks, and cooldowns.*
- **`GET /api/volunteers/application`** *(Auth required)* – Retrieves the volunteer's current application draft, KYC state, training status, and references.
- **`PUT /api/volunteers/application`** *(Auth required)* – Saves or updates the volunteer application draft:
  - Details: `full_name`, `dob` (YYYY-MM-DD), `locality`, `id_type` ("Voter ID", "Driving Licence", "College ID", "Passport", "Other"), `id_last4` (strictly $\le 4$ digits, never full ID number).
  - Motivation & Availability: `motivation`, `availability_text`.
  - 2 References: Array of personal/professional references (`name`, `phone`, `relation`).
  - Code of Conduct: `declaration_accepted` (boolean), `declaration_version`, `typed_signature` (must match full name).
  - Enforces 30-day cooldown if the previous application was rejected (`reapply_after`).
- **`POST /api/volunteers/application/id-image`** *(Auth required)* – Uploads multipart ID document photo (JPEG/PNG only, max 2 MB). Validates magic bytes, saves to private directory `backend/private_uploads/` with unguessable random name. Never served publicly.
- **`POST /api/volunteers/application/selfie`** *(Auth required)* – Uploads multipart live verification selfie (JPEG/PNG only, max 2 MB, magic byte verified, stored in `backend/private_uploads/`).
- **`GET /api/volunteers/training`** *(Auth required)* – Returns 8 multiple-choice safety questions without revealing correct answers.
- **`POST /api/volunteers/training/submit`** *(Auth required)* – Scores training answers. Requires at least 80% (7/8) to pass. If failed, enforces a strict **24-hour retry cooldown** before another attempt is permitted.
- **`POST /api/volunteers/application/submit`** *(Auth required)* – Final submission validation:
  - Validates age $\ge 18$ calculated from Date of Birth.
  - Verifies full name, locality, ID type, and ID last 4 digits (never a full ID).
  - Confirms physical existence of uploaded ID image and selfie files on disk.
  - Verifies at least 2 references with different phone numbers, neither matching the applicant's own phone.
  - Confirms safety training passed with score $\ge 80\%$.
  - Validates declaration acceptance and typed signature matching full name.
  - Sets application status to `"submitted"` for administrator review.
- **`POST /api/volunteers/status`** *(Auth required)* – Saves volunteer availability (`available`: true/false) and latest GPS coordinates for approved volunteers.
- **`GET /api/volunteers/nearby-alerts`** *(Auth required)* – Finds active alerts within proximity of approved volunteer's position (excludes own alerts; hides names on silent alerts).
- **`POST /api/alerts/<id>/respond`** *(Auth required)* – Approved volunteer responds to an alert with `"coming"` or `"cannot"`.
- **`GET /api/alerts/<id>/status`** – Returns `volunteers_coming` and full chronological list of `contact_responses` (`name`, `status`, `time`).
- **`GET /api/volunteers/count`** – Returns the number of currently available approved volunteers.

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
  5. Alert owner receives a push whenever an emergency contact responds from their tracking link ("Mom: I'm on my way").
  6. Expired 404/410 subscriptions are automatically pruned.

### 11. Admin Management & Volunteer Review Backend
*Protected by `ADMIN_KEY` or named reviewer keys defined in `ADMIN_REVIEWERS` (`name:key,name:key`). Supports optional dual-reviewer policy (`REQUIRE_TWO_REVIEWERS=true`).*

- **Reviewer Authentication & Identification**:
  - Reviewer key provided via `X-Admin-Key: <key>` or `Authorization: Bearer <key>`.
  - Maps to reviewer name stored with every audit action, review decision, reference verification, and interview.
  - Optional `REQUIRE_TWO_REVIEWERS=true`: Enforces that approval requires an initial `"recommend"` by one reviewer and final `"approve"` by a different reviewer.
- **Automatic Fraud & Safety Risk Flags (`flags_json`)**:
  - `duplicate_phone` *(high)*: Applicant phone matches an existing volunteer application.
  - `duplicate_id` *(high)*: `id_type` and `id_last4` combination already registered to another applicant.
  - `reference_phone_conflict` *(high)*: Reference phone equals applicant's own or another applicant's phone number.
  - `recent_rejection` *(high)*: Applicant had a volunteer rejection within the last 90 days.
  - `name_signature_mismatch` *(high)*: Typed signature differs from declared full name.
  - `incomplete_profile` *(info)*: Motivation (< 15 chars) or availability (< 5 chars) is sparse.
- **Review Routes**:
  - **`GET /api/admin/volunteers?status=`**: Lists volunteers filtered by status with parsed flags, severity counts, and aggregate counts (`counts: {all, submitted, in_review, approved, rejected, ...}`).
  - **`GET /api/admin/volunteers/<id>`**: Retrieves full application packet (details, references, training attempts, phone interview verification, flags) with sensitive `id_image_path` safely excluded.
  - **`GET /api/admin/volunteers/<id>/id-image`**: Streams the government ID image document and writes a persistent view audit row to `volunteer_reviews`.
  - **`POST /api/admin/volunteers/<id>/references/<rid>`**: Records reference verification phone call (`outcome` in `"pending"`, `"confirmed"`, `"not_reachable"`, `"negative"`, `notes`, `reviewer`, `time`).
  - **`POST /api/admin/volunteers/<id>/interview`**: Records phone verification interview (`notes`, `confirmed_identity`, `called_applicant_number`), validating phone ownership.
  - **`POST /api/admin/volunteers/<id>/decision`**:
    - **`approve`**: Strict gate checks:
      1. Checklist all true (`identity_matches_photo`, `phone_verified_by_call`, `interview_done`, `declaration_checked`).
      2. At least 2 references have outcome `"confirmed"` and none is `"negative"`.
      3. Safety training passed (>= 80%).
      4. Note >= 20 characters.
      5. No unresolved high-severity flags (override permitted only with `override_flags: true` and a note explicitly mentioning the override/flag code).
      6. Dual-reviewer check: If `REQUIRE_TWO_REVIEWERS=true`, requires prior recommendation from a different reviewer.
      - Sets `status = "approved"`, `level = "provisional"`, `approved_by`, `approved_at`, `valid_until = 12 months`.
    - **`recommend`**: Marks status `"in_review"` for secondary reviewer sign-off.
    - **`request_info`**: Marks status `"in_review"` and records audit note.
    - **`reject`**: Requires valid `reason_code` (`id_mismatch`, `references_negative`, `references_unreachable`, `training_not_passed`, `incomplete`, `safety_concern`, `underage`, `other`) and note. Sets status `"rejected"` and 30-day cooldown (`reapply_after`).
  - **`GET /api/admin/volunteers/<id>/audit`**: Returns complete chronological audit trail from `volunteer_reviews`.
  - **`POST /api/admin/volunteers/<id>/revoke`**: Revokes volunteer privileges at any time with note and reviewer attribution.
- **Platform Metrics & Logs**:
  - **`GET /api/admin/stats`**: Platform metrics: total users, active alerts, alerts today, approved volunteers.
  - **`GET /api/admin/logs`**: Last 100 log lines with masked sensitive data.
  - **`POST /api/admin/purge-test-data`**: Cleans dummy test users while preserving production accounts.

### 12. Evidence Vault (Auth Required, Owner Only)
*Zero-Knowledge, Tamper-Proof Evidence Storage. Contacts, volunteers, and the admin page never get access to evidence.*
- **`POST /api/evidence/key`** *(Auth required, owner only)* – Stores the user's plain RSA-OAEP public key, AES-GCM wrapped private key, and PBKDF2 salt.
- **`GET /api/evidence/key`** *(Auth required, owner only)* – Retrieves the authenticated owner's public and wrapped private keys.
- **`POST /api/evidence/sessions`** *(Auth required, owner only)* – Initiates an evidence recording session (`id`, optional `alertId`, `kind`: `"audio"|"video"`).
- **`POST /api/evidence/sessions/<id>/chunks`** *(Auth required, owner only)* – Uploads an encrypted evidence chunk via multipart form-data (`file`, `idx`, `sha256`, `prev_hash`, optional `encrypted_key`, `iv`):
  - Enforces chunk size limit of at most 3 MB.
  - Enforces total user storage limit of at most 200 MB.
  - Validates `idx` is strictly sequential (`0, 1, 2...`).
  - Recomputes the SHA-256 of the received file bytes and rejects mismatches.
  - Computes `chain_hash = sha256(prev_hash + sha256)` and saves the chunk to `backend/evidence/<user_id>/<session_id>/chunk_<idx>.bin`.
- **`GET /api/evidence/sessions`** *(Auth required, owner only)* – Lists all recorded sessions with chunk counts and total sizes for the authenticated owner.
- **`GET /api/evidence/sessions/<id>/verify`** *(Auth required, owner only)* – Validates the cryptographic SHA-256 hash chain and on-disk file integrity across all session chunks. Returns `{"verified": true}` or reports the first `brokenIndex`.
- **`GET /api/evidence/chunks/<id>`** *(Auth required, owner only)* – Streams/downloads the raw encrypted chunk binary file.
- **`DELETE /api/evidence/sessions/<id>`** *(Auth required, owner only)* – Requires the user's 4-digit Safety PIN. Permanently deletes the session, its chunk records, and its on-disk files.
- **Automated Retention Scheduler**:
  1. Purges evidence recording sessions and chunk files older than 30 days automatically.
  2. Permanently deletes volunteer ID image files from disk 7 days after any final decision (approved, rejected, revoked, expired) while preserving `id_last4` and `id_type` for audit integrity.

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
- **`volunteers`**: Extended volunteer records with KYC and lifecycle tracking (`id`, `user_id`, `full_name`, `dob`, `locality`, `id_type`, `id_last4`, `id_image_path`, `selfie_path`, `motivation`, `availability_text`, `declaration_accepted_at`, `declaration_version`, `typed_signature`, `training_score`, `training_passed_at`, `status` in draft/submitted/in_review/approved/rejected/suspended/revoked/expired, `level` in provisional/trusted, `approved_at`, `approved_by`, `valid_until`, `reject_reason_code`, `reapply_after`, `flags_json`, `available`, `lat`, `lng`, `updated_at`).
- **`volunteer_references`**: Personal & professional references for background checks (`id`, `volunteer_id`, `name`, `phone`, `relation`, `contacted_at`, `outcome` in pending/confirmed/not_reachable/negative, `notes`, `reviewer`).
- **`volunteer_training_attempts`**: Audit log of safety questionnaire attempts (`id`, `volunteer_id`, `score`, `taken_at`).
- **`responses`**: Volunteer dispatch responses to active alerts.
- **`alert_contacts`**: Unique personalized tracking tokens generated for each emergency contact when an alert is created (`id`, `alert_id`, `contact_id`, `token`).
- **`contact_responses`**: Status responses submitted by contacts via their personalized tracking page (`id`, `alert_id`, `contact_id`, `status`, `created_at`).
- **`timers`**: Safe Timer records and automatic escalation deadlines.
- **`push_subscriptions`**: Web Push subscription endpoints and crypto keys per user (`endpoint`, `p256dh`, `auth`).
- **`evidence_keys`**: Public and wrapped private keys with salt per user (`user_id`, `public_key`, `wrapped_private_key`, `salt`).
- **`evidence_sessions`**: Evidence recording sessions (`id`, `user_id`, `alert_id`, `kind`, `started_at`, `ended_at`).
- **`evidence_chunks`**: Cryptographically chained encrypted media chunks (`id`, `session_id`, `idx`, `mime`, `size`, `sha256`, `prev_hash`, `chain_hash`, `file_path`, `created_at`).

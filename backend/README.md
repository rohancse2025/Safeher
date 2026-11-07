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
- `ADMIN_REVIEWERS`: Comma-separated reviewer names and keys (e.g. `Admin:safeher-admin-secret-key-123,Reviewer1:key_rev1_2026`).
- `REQUIRE_TWO_REVIEWERS`: Set to `true` to enforce two-reviewer recommendation and approval flow.
- `VAPID_PUBLIC_KEY`: Base64url VAPID public key for Web Push.
- `VAPID_PRIVATE_KEY`: Base64url raw 32-byte VAPID private key.
- `VAPID_CLAIMS_SUB`: Contact email/subject for VAPID claims (e.g. `mailto:admin@safeher.local`).

---

## Running the Server

Start the Flask application:

```bash
python app.py
```

The database (`safeher.db`) and all tables (`users`, `contacts`, `alerts`, `locations`, `volunteers`, `responses`, `timers`, `volunteer_references`, `volunteer_training_attempts`, `volunteer_reviews`, `volunteer_view_log`, `volunteer_feedback`, `incident_events`, `volunteer_query_log`, `evidence_keys`, `evidence_sessions`, `evidence_chunks`) will be **created automatically** on the first run.

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
- **`GET /api/alerts/<id>/status`** – Returns `volunteers_coming`, `contact_responses`, and verified `responders` (volunteer first name, badge, completed response count, verification code, and authenticated selfie URL).
- **`GET /api/alerts/<id>/responder-selfie/<volunteer_id>`** *(Auth required, Alert Owner only)* – Authenticated route streaming the responder volunteer's selfie only to the alert owner.
- **`POST /api/alerts/<id>/volunteer-feedback`** *(Auth required, Alert Owner only)* – Submit feedback on a responder (`volunteer_id`, `helpful`, `respectful`, `report_type`: `"none"|"unsafe"|"inappropriate"|"other"`, `comment`). If report is `"unsafe"` or `"inappropriate"`, the volunteer is immediately suspended.

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

### 8. Volunteer Network, KYC Application & Matching System
*Full-fledged multi-step volunteer onboarding with strict safety training, identity document verification, reference checks, cooldowns, and secure location masking.*
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
- **`GET /api/volunteers/nearby-alerts`** *(Auth required)*:
  - Enforces status `"approved"` and `valid_until > CURRENT_TIMESTAMP`.
  - Rate-limited to at most 20 queries per hour per volunteer.
  - Provisional volunteers are excluded from silent-mode alerts and see only masked coordinates (rounded to 0.003 degrees) and distance band ("about 1 km").
  - Trusted volunteers receive silent-mode alerts and see distance band only before responding.
  - Exact coordinates returned only after volunteer taps "I'm coming", with audit logging in `volunteer_view_log`.
- **`POST /api/alerts/<id>/respond`** *(Auth required)*:
  - Approved volunteer responds with `"coming"` or `"cannot"`.
  - Generates a random 4-digit verification code returned to the volunteer and alert owner.
  - Logs anonymous responder labels in `incident_events` ("Volunteer 1", "Volunteer 2").
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
  2. Silent alerts notify nearby trusted volunteers only, with `silent: true` (no sound).
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
  - **`GET /api/admin/volunteers?status=`**: Lists volunteers filtered by status with parsed flags, severity counts, and aggregate counts (`counts: {all, submitted, in_review, approved, suspended, rejected, ...}`).
  - **`GET /api/admin/volunteers/<id>`**: Retrieves full application packet (details, references, training attempts, phone interview verification, flags) with sensitive `id_image_path` safely excluded.
  - **`GET /api/admin/volunteers/<id>/id-image`**: Streams the government ID image document and writes a persistent view audit row to `volunteer_reviews`.
  - **`GET /api/admin/volunteers/<id>/selfie`**: Streams the applicant selfie for verification against the revealed ID document.
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
    - **`resolve`**: Un-suspends a volunteer after incident investigation and restores status to `"approved"`.
  - **`GET /api/admin/volunteers/<id>/audit`**: Returns complete chronological audit trail from `volunteer_reviews`.
  - **`POST /api/admin/volunteers/<id>/revoke`**: Revokes volunteer privileges at any time with note and reviewer attribution.
- **Platform Metrics & Logs**:
  - **`GET /api/admin/stats`**: Platform metrics: total users, active alerts, alerts today, approved volunteers, active reviewer name, dual-reviewer mode.
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
- **Automated Retention & Promotion Scheduler**:
  1. Purges evidence recording sessions and chunk files older than 30 days automatically.
  2. Permanently deletes volunteer ID image files from disk 7 days after any final decision (approved, rejected, revoked, expired) while preserving `id_last4` and `id_type` for audit integrity.
  3. Promotes provisional volunteers to `"trusted"` if they have $\ge 3$ completed responses, clean feedback (all helpful & respectful, 0 reports), and $\ge 30$ days since approval.
  4. Marks volunteers whose `valid_until` has passed as `"expired"`.

### 13. Escort Mode & Safe Journey Monitoring (Auth Required, Owner Only)
*Real-time safe journey tracking with route deviation calculation, automated check-in deadlines, stationary detection, and emergency escalation.*
- **`POST /api/escorts`** *(Auth required, owner only)* – Initiates an Escort Mode journey:
  - Expects JSON: `destination` (or `dest_name`), `dest_lat`, `dest_lng`, `route` (list of `[lat, lng]` points), `expected_minutes`, `checkin_interval` (`5, 10, 15, 30` or `None`), `deviation_distance` (`100` to `500` m), `contact_ids` (list of integer contact IDs).
  - Generates 1 unique token per selected contact (`escort_contacts`).
  - Dispatches email notifications asynchronously to each contact: `"X started a journey to [destination], expected by [time]"` with direct link `FRONTEND_URL/track.html?t=[token]`.
  - Logs `escort_started` in `incident_events`.
- **`POST /api/escorts/<id>/position`** *(Auth required, owner only)* – Reports user's live coordinates `{lat, lng}`:
  - Calculates perpendicular distance in meters to the planned polyline using local equirectangular projection:
    $$x = \Delta\lambda \cdot \cos\left(\frac{\phi_1 + \phi_2}{2}\right) \cdot R, \quad y = \Delta\phi \cdot R$$
    $$t = \text{clamp}\left(\frac{\vec{w} \cdot \vec{v}}{|\vec{v}|^2}, 0, 1\right), \quad d = |\vec{w} - t\vec{v}|$$
  - Sets `off_route_since` if perpendicular distance exceeds `deviation_m`; resets when back on route.
  - Stationary detection: detects if user moved $< 30$ m over 5 minutes while not paused.
  - Arrival detection: detects arrival when within $100$ m of destination (automatically updates status to `"arrived"`, emails `"arrived safely"`, and logs `escort_arrived`).
- **`POST /api/escorts/<id>/checkin`** *(Auth required, owner only)* – Records user safe check-in, advances `next_checkin_due`, and logs `escort_checkin_ok`.
- **`POST /api/escorts/<id>/pause`** *(Auth required, owner only)* – Pauses the journey for up to 15 minutes (at most 2 pauses per escort), suspending deviation alerts, and logs `escort_paused`.
- **`POST /api/escorts/<id>/reroute`** *(Auth required, owner only)* – Replaces the planned route points, clears off-route state, and logs `escort_rerouted`.
- **`POST /api/escorts/<id>/escalate`** *(Auth required, owner only)* – Manually escalates journey to an emergency SOS alert, attaches `alert_id` to the escort, and logs `escort_alerted`.
- **`POST /api/escorts/<id>/end`** *(Auth required, owner only)* – Concludes the journey (`arrived: true|false`). If `arrived` is true, sends `"arrived safely"` emails to contacts and logs `escort_arrived`.
- **`GET /api/escorts/active`** *(Auth required, owner only)* – Retrieves active or paused journey for the authenticated user.
- **`GET /api/escorts/<id>`** *(Auth required, owner only)* – Retrieves detailed journey metadata.
- **Background Escort Monitor (Runs every 10 seconds)**:
  - (a) Creates alert with `reason="route_deviation"` if off-route for $> 2$ minutes and not paused.
  - (b) Creates alert with `reason="missed_checkin"` if check-in is $> 60$ seconds overdue.
  - (c) Sends uneasy alert to close contacts with `reason="no_signal"` if no update for 5 minutes, escalating to normal alert after 10 minutes.
  - (d) Creates alert with `reason="late_arrival"` if destination not reached 10 minutes past ETA (`expected_end + 10 min`).
  - Bypasses hourly rate limits for system alerts, enforces max 1 active system alert per escort, and attaches `alert_id` to the escort.
- **Public Tracking Extension (`GET /api/track/<token>`)**:
  - Resolves escort contact tokens without requiring login.
  - Returns `type: "escort"`, `first_name` (owner), `destination_name`, `route`, `current_position`, `progress_percent`, `status` (`On route`, `Off route`, `Paused`, `Check-in due`, `Alerted`, `Arrived`), `last_checkin_time`, `next_checkin_time`, and `eta`.
  - Enforces link expiration 1 hour after arrival or journey completion.

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
- **`volunteer_reviews`**: Immutable administrative review and decision audit trail (`id`, `volunteer_id`, `reviewer`, `action`, `checklist_json`, `note`, `ts`).
- **`volunteer_view_log`**: Audit log of every exact location view by volunteers when responding to alerts (`id`, `volunteer_id`, `alert_id`, `time`).
- **`volunteer_feedback`**: Alert owner feedback on volunteers (`id`, `alert_id`, `volunteer_id`, `helpful`, `respectful`, `report_type`, `comment`, `created_at`).
- **`volunteer_query_log`**: Rate-limiting log for nearby alert requests per volunteer (`id`, `volunteer_id`, `created_at`).
- **`alerts`**: Emergency alerts triggered by users (`id`, `user_id`, `mode`, `reason`, `status`, `lat`, `lng`, `share_token`, `duress`, `notified_count`, `created_at`, `ended_at`). `reason` tracks trigger origin: `manual` (default), `route_deviation`, `missed_checkin`, `no_signal`, `late_arrival`, `timer`, `safe_point`.
- **`incident_events`**: Central incident event log (`id`, `user_id`, `alert_id`, `escort_id`, `seq`, `ts`, `type`, `actor`, `detail_json`, `created_at`).
  - **`seq`**: Strictly sequential integer assigned per alert/escort (1, 2, 3...).
  - **`ts`**: UTC ISO 8601 timestamp string (`YYYY-MM-DDTHH:MM:SSZ`).
  - **`actor`**: One of `user`, `system`, `contact`, `volunteer`, `safepoint`.
  - **Privacy Sanitization**: Details strictly exclude phone numbers, emails, tokens, PINs, and full addresses. Contacts are referred to by first name only, and volunteers are labeled anonymously as `Volunteer 1`, `Volunteer 2`.
  - **Duress Confidentiality**: Duress PIN use is NEVER logged, and `alert_ended` is NEVER recorded if the duress PIN is entered.
  - **30-Day Retention**: Scheduled background worker automatically deletes all incident events older than 30 days.
  - **Logged Event Types**: `alert_created`, `alert_mode_changed`, `alert_ended` (by normal PIN), `email_sent` (count), `email_failed` (count), `push_sent` (count), `volunteer_notified` (count), `volunteer_responded`, `contact_responded`, `user_checkin_ok`, `timer_expired`, `evidence_session_started`, `evidence_session_ended`, `evidence_chunks_uploaded` (count).
- **`responses`**: Volunteer dispatch responses to active alerts with verification code (`id`, `alert_id`, `volunteer_id`, `status`, `verification_code`, `responded_at`).
- **`alert_contacts`**: Unique personalized tracking tokens generated for each emergency contact when an alert is created (`id`, `alert_id`, `contact_id`, `token`).
- **`contact_responses`**: Status responses submitted by contacts via their personalized tracking page (`id`, `alert_id`, `contact_id`, `status`, `created_at`).
- **`timers`**: Safe Timer records and automatic escalation deadlines.
- **`push_subscriptions`**: Web Push subscription endpoints and crypto keys per user (`endpoint`, `p256dh`, `auth`).
- **`evidence_keys`**: Public and wrapped private keys with salt per user (`user_id`, `public_key`, `wrapped_private_key`, `salt`).
- **`evidence_sessions`**: Evidence recording sessions (`id`, `user_id`, `alert_id`, `kind`, `started_at`, `ended_at`).
- **`evidence_chunks`**: Cryptographically chained encrypted media chunks (`id`, `session_id`, `idx`, `mime`, `size`, `sha256`, `prev_hash`, `chain_hash`, `file_path`, `created_at`).
- **`escorts`**: Safe journey tracking sessions (`id`, `user_id`, `dest_name`, `dest_lat`, `dest_lng`, `route_json`, `route_distance_m`, `started_at`, `expected_end`, `status` in active/paused/arrived/ended/alerted, `checkin_interval_min`, `deviation_m`, `last_lat`, `last_lng`, `last_update_at`, `last_checkin_at`, `next_checkin_due`, `off_route_since`, `stationary_since`, `pauses_used`, `alert_id`, `ended_at`).
- **`escort_contacts`**: Unique personalized tracking tokens generated per emergency contact per escort journey (`id`, `escort_id`, `contact_id`, `token`).

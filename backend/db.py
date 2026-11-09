# backend/db.py – SQLite database connection and table schema creation
import os
import sqlite3
import secrets
from dotenv import load_dotenv

# Load settings from .env file
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
load_dotenv()

# Database path: safely resolves relative paths whether called from root or backend
db_env = (os.getenv('DATABASE_PATH') or 'safeher.db').strip()
backend_dir = os.path.dirname(os.path.abspath(__file__))

clean_env = db_env.replace('\\', '/')
if os.path.isabs(db_env):
    DB_PATH = db_env
elif clean_env.startswith('backend/'):
    # Strip redundant 'backend/' if environment variable specified relative to repo root
    DB_PATH = os.path.join(backend_dir, clean_env[8:])
else:
    DB_PATH = os.path.join(backend_dir, clean_env)

# Always ensure parent directory exists before any SQLite connection
try:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
except Exception:
    pass


def get_db():
    """
    Open and return a new SQLite connection.
    Enables dictionary-like column access (sqlite3.Row) and foreign key constraints.
    """
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON;')
    try:
        conn.execute('PRAGMA journal_mode = WAL;')
        conn.execute('PRAGMA busy_timeout = 30000;')
    except Exception:
        pass
    return conn


def init_db():
    """
    Create all required tables automatically on first run.
    """
    conn = get_db()
    cursor = conn.cursor()

    # 1. Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            email TEXT,
            password_hash TEXT NOT NULL,
            pin_hash TEXT,
            duress_pin_hash TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    ''')

    # 2. Contacts table (with opted_out, email_status, optout_token)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT,
            relationship TEXT,
            close INTEGER DEFAULT 0,
            opted_out INTEGER DEFAULT 0,
            email_status TEXT DEFAULT 'unknown',
            optout_token TEXT UNIQUE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')
    cursor.execute("PRAGMA table_info(contacts);")
    existing_contact_cols = {col['name'] for col in cursor.fetchall()}
    if 'close' not in existing_contact_cols:
        cursor.execute("ALTER TABLE contacts ADD COLUMN close INTEGER DEFAULT 0;")
    if 'opted_out' not in existing_contact_cols:
        cursor.execute("ALTER TABLE contacts ADD COLUMN opted_out INTEGER DEFAULT 0;")
    if 'email_status' not in existing_contact_cols:
        cursor.execute("ALTER TABLE contacts ADD COLUMN email_status TEXT DEFAULT 'unknown';")
    if 'optout_token' not in existing_contact_cols:
        cursor.execute("ALTER TABLE contacts ADD COLUMN optout_token TEXT;")
    
    # Ensure all contacts have an optout_token for 1-click unsubscribe links
    cursor.execute("SELECT id FROM contacts WHERE optout_token IS NULL OR optout_token = '';")
    for r in cursor.fetchall():
        cursor.execute("UPDATE contacts SET optout_token = ? WHERE id = ?;", (secrets.token_urlsafe(24), r['id']))

    # 3. Alerts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            mode TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT 'manual',
            status TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMP,
            share_token TEXT UNIQUE NOT NULL,
            notified_count INTEGER DEFAULT 0,
            duress INTEGER DEFAULT 0,
            note TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 4. Locations history table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
        );
    ''')

    # 5. Volunteers table (extended application & KYC fields)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE NOT NULL,
            available INTEGER DEFAULT 0,
            lat REAL,
            lng REAL,
            status TEXT DEFAULT 'draft',
            note TEXT,
            full_name TEXT,
            dob TEXT,
            locality TEXT,
            id_type TEXT,
            id_last4 TEXT,
            id_image_path TEXT,
            selfie_path TEXT,
            motivation TEXT,
            availability_text TEXT,
            declaration_accepted_at TIMESTAMP,
            declaration_version TEXT,
            typed_signature TEXT,
            training_score REAL,
            training_passed_at TIMESTAMP,
            level TEXT DEFAULT 'provisional',
            approved_at TIMESTAMP,
            approved_by TEXT,
            valid_until TIMESTAMP,
            reject_reason_code TEXT,
            reapply_after TIMESTAMP,
            flags_json TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 5a. Volunteer references table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_references (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volunteer_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            relation TEXT,
            contacted_at TIMESTAMP,
            outcome TEXT DEFAULT 'pending',
            notes TEXT,
            reviewer TEXT,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
        );
    ''')

    # 5b. Volunteer training attempts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_training_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volunteer_id INTEGER NOT NULL,
            score REAL NOT NULL,
            taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
        );
    ''')

    # 5c. Volunteer reviews & audit trail table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volunteer_id INTEGER NOT NULL,
            reviewer TEXT NOT NULL,
            action TEXT NOT NULL,
            checklist_json TEXT,
            note TEXT,
            ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
        );
    ''')

    # Add columns if migrating existing database
    cursor.execute("PRAGMA table_info(alerts);")
    alert_cols = [col['name'] for col in cursor.fetchall()]
    if 'note' not in alert_cols:
        cursor.execute("ALTER TABLE alerts ADD COLUMN note TEXT;")
    if 'reason' not in alert_cols:
        cursor.execute("ALTER TABLE alerts ADD COLUMN reason TEXT DEFAULT 'manual';")

    cursor.execute("PRAGMA table_info(volunteers);")
    existing_vol_cols = {col['name'] for col in cursor.fetchall()}
    if 'status' not in existing_vol_cols:
        cursor.execute("ALTER TABLE volunteers ADD COLUMN status TEXT DEFAULT 'draft';")
    if 'note' not in existing_vol_cols:
        cursor.execute("ALTER TABLE volunteers ADD COLUMN note TEXT;")

    vol_columns_to_add = [
        ('full_name', 'TEXT'),
        ('dob', 'TEXT'),
        ('locality', 'TEXT'),
        ('id_type', 'TEXT'),
        ('id_last4', 'TEXT'),
        ('id_image_path', 'TEXT'),
        ('selfie_path', 'TEXT'),
        ('motivation', 'TEXT'),
        ('availability_text', 'TEXT'),
        ('declaration_accepted_at', 'TIMESTAMP'),
        ('declaration_version', 'TEXT'),
        ('typed_signature', 'TEXT'),
        ('training_score', 'REAL'),
        ('training_passed_at', 'TIMESTAMP'),
        ('level', "TEXT DEFAULT 'provisional'"),
        ('approved_at', 'TIMESTAMP'),
        ('approved_by', 'TEXT'),
        ('valid_until', 'TIMESTAMP'),
        ('reject_reason_code', 'TEXT'),
        ('reapply_after', 'TIMESTAMP'),
        ('flags_json', 'TEXT'),
        ('interview_notes', 'TEXT'),
        ('interview_confirmed_identity', 'INTEGER DEFAULT 0'),
        ('interview_called_applicant_number', 'INTEGER DEFAULT 0'),
        ('interview_by', 'TEXT'),
        ('interview_at', 'TIMESTAMP'),
    ]
    for col_name, col_type in vol_columns_to_add:
        if col_name not in existing_vol_cols:
            cursor.execute(f"ALTER TABLE volunteers ADD COLUMN {col_name} {col_type};")

    # 6. Responses table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            volunteer_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            verification_code TEXT,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
        );
    ''')

    cursor.execute("PRAGMA table_info(responses);")
    existing_resp_cols = {col['name'] for col in cursor.fetchall()}
    if 'verification_code' not in existing_resp_cols:
        cursor.execute("ALTER TABLE responses ADD COLUMN verification_code TEXT;")

    # 6a. Alert contacts table (one unique token per contact per alert)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS alert_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')

    # 6b. Contact responses table (responses submitted by contacts via their unique link)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS contact_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')

    # 6c. Volunteer precise view log table (audit every exact coordinate view)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_view_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volunteer_id INTEGER NOT NULL,
            alert_id INTEGER NOT NULL,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
        );
    ''')

    # 6d. Volunteer feedback table (submitted by alert owner)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            volunteer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            helpful BOOLEAN NOT NULL DEFAULT 1,
            respectful BOOLEAN NOT NULL DEFAULT 1,
            report_type TEXT NOT NULL DEFAULT 'none',
            comment TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(alert_id, volunteer_id)
        );
    ''')

    # 6e. Central incident events table (seq per alert, UTC ISO ts, actor in user|system|contact|volunteer|safepoint)
    cursor.execute("PRAGMA table_info(incident_events);")
    existing_ie_cols = {col['name'] for col in cursor.fetchall()}
    if existing_ie_cols and 'user_id' not in existing_ie_cols:
        cursor.execute("ALTER TABLE incident_events RENAME TO incident_events_legacy;")
        cursor.execute('''
            CREATE TABLE incident_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                alert_id INTEGER,
                escort_id INTEGER,
                seq INTEGER NOT NULL DEFAULT 1,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,
                actor TEXT NOT NULL CHECK(actor IN ('user', 'system', 'contact', 'volunteer', 'safepoint')),
                detail_json TEXT NOT NULL DEFAULT '{}',
                actor_label TEXT,
                event_type TEXT,
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
            );
        ''')
        try:
            cursor.execute('''
                INSERT INTO incident_events (id, user_id, alert_id, seq, ts, type, actor, detail_json, actor_label, event_type)
                SELECT o.id, COALESCE(a.user_id, 1), o.alert_id, o.id, COALESCE(o.created_at, datetime('now')),
                       COALESCE(o.event_type, 'event'),
                       CASE WHEN o.event_type LIKE '%volunteer%' THEN 'volunteer' ELSE 'system' END,
                       json_object('details', COALESCE(o.details, '')),
                       o.actor_label,
                       o.event_type
                FROM incident_events_legacy o
                LEFT JOIN alerts a ON o.alert_id = a.id;
            ''')
        except Exception:
            pass
        cursor.execute("DROP TABLE incident_events_legacy;")
    else:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS incident_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                alert_id INTEGER,
                escort_id INTEGER,
                seq INTEGER NOT NULL DEFAULT 1,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,
                actor TEXT NOT NULL CHECK(actor IN ('user', 'system', 'contact', 'volunteer', 'safepoint')),
                detail_json TEXT NOT NULL DEFAULT '{}',
                actor_label TEXT,
                event_type TEXT,
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
            );
        ''')
        # If columns missing in existing table
        if existing_ie_cols:
            if 'escort_id' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN escort_id INTEGER;")
            if 'seq' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN seq INTEGER DEFAULT 1;")
            if 'ts' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN ts TEXT;")
            if 'type' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN type TEXT;")
            if 'actor' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN actor TEXT DEFAULT 'system';")
            if 'detail_json' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN detail_json TEXT DEFAULT '{}';")
            if 'details' not in existing_ie_cols:
                cursor.execute("ALTER TABLE incident_events ADD COLUMN details TEXT;")

    # 6f. Volunteer nearby alert query rate limit tracking (max 20 per hour)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteer_query_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            volunteer_id INTEGER NOT NULL,
            query_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
        );
    ''')

    # 7. Timers table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS timers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            contact_id INTEGER,
            deadline TIMESTAMP NOT NULL,
            status TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
        );
    ''')

    # 8. Push subscriptions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT UNIQUE NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 9. Evidence public & wrapped keys table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS evidence_keys (
            user_id TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            wrapped_private_key TEXT,
            salt TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 10. Evidence sessions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS evidence_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            alert_id TEXT,
            kind TEXT DEFAULT 'audio',
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 11. Evidence chunks table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS evidence_chunks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            idx INTEGER NOT NULL,
            mime TEXT,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            prev_hash TEXT NOT NULL,
            chain_hash TEXT NOT NULL,
            file_path TEXT NOT NULL,
            encrypted_key TEXT,
            iv TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id, idx),
            FOREIGN KEY (session_id) REFERENCES evidence_sessions(id) ON DELETE CASCADE
        );
    ''')

    # 12. Escorts table (Escort Mode tracking, deviation, stationary, checkins, alerts)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS escorts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            dest_name TEXT NOT NULL,
            dest_lat REAL NOT NULL,
            dest_lng REAL NOT NULL,
            route_json TEXT NOT NULL,
            route_distance_m REAL NOT NULL DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expected_end TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'arrived', 'ended', 'alerted')),
            checkin_interval_min INTEGER,
            deviation_m REAL NOT NULL DEFAULT 200,
            last_lat REAL,
            last_lng REAL,
            last_update_at TIMESTAMP,
            last_checkin_at TIMESTAMP,
            next_checkin_due TIMESTAMP,
            off_route_since TIMESTAMP,
            stationary_since TIMESTAMP,
            stationary_anchor_lat REAL,
            stationary_anchor_lng REAL,
            stationary_anchor_at TIMESTAMP,
            pauses_used INTEGER NOT NULL DEFAULT 0,
            pause_until TIMESTAMP,
            alert_id INTEGER,
            ended_at TIMESTAMP,
            checkin_requested_at TIMESTAMP,
            checkin_requested_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE SET NULL
        );
    ''')

    cursor.execute("PRAGMA table_info(escorts);")
    existing_escort_cols = {col['name'] for col in cursor.fetchall()}
    if 'checkin_requested_at' not in existing_escort_cols:
        cursor.execute("ALTER TABLE escorts ADD COLUMN checkin_requested_at TIMESTAMP;")
    if 'checkin_requested_by' not in existing_escort_cols:
        cursor.execute("ALTER TABLE escorts ADD COLUMN checkin_requested_by TEXT;")

    # 13. Escort contacts tokens table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS escort_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            escort_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (escort_id) REFERENCES escorts(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')

    # 14. Escort check-in ping requests table (rate limiting: max 3 per hour per contact)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS escort_checkin_pings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            escort_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (escort_id) REFERENCES escorts(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_escort_pings_escort_contact ON escort_checkin_pings(escort_id, contact_id, created_at);')

    # 15. Notifications table (Central notification outbox, status tracking, retry state, and provider message id)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            alert_id INTEGER,
            event_type TEXT NOT NULL,
            event_key TEXT NOT NULL,
            contact_id INTEGER,
            channel TEXT NOT NULL DEFAULT 'email',
            recipient_masked TEXT NOT NULL,
            recipient_email TEXT NOT NULL,
            subject TEXT NOT NULL,
            body_text TEXT NOT NULL,
            body_html TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_attempt_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            sent_at TIMESTAMP,
            delivered_at TIMESTAMP,
            provider_message_id TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE SET NULL,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
            UNIQUE (event_key, contact_id, channel)
        );
    ''')

    # 16. Notification Settings table (user_id, event_type, enabled)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notification_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE (user_id, event_type)
        );
    ''')

    # 17. Share Location sessions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            duration_minutes INTEGER,
            until_stopped INTEGER DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'ended', 'expired')),
            last_lat REAL,
            last_lng REAL,
            last_update_at TIMESTAMP,
            ended_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 18. Share Location contact tokens table (1 unique tracking token per contact)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS share_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            share_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')

    # 19. Ride Safety sessions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS rides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            vehicle_type TEXT NOT NULL,
            vehicle_number TEXT,
            driver_name TEXT,
            driver_phone TEXT,
            app_used TEXT,
            pickup TEXT,
            destination TEXT,
            expected_minutes INTEGER,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expected_end_at TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'ended')),
            last_lat REAL,
            last_lng REAL,
            last_update_at TIMESTAMP,
            ended_at TIMESTAMP,
            late_notified INTEGER DEFAULT 0,
            alert_created INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 20. Ride Safety contact tokens table (1 unique tracking token per contact)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS ride_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ride_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
    ''')


    # Useful indexes for high performance lookups
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(share_token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alert_contacts_token ON alert_contacts(token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alert_contacts_alert ON alert_contacts(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contact_responses_alert ON contact_responses(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contact_responses_contact ON contact_responses(contact_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_references_vol ON volunteer_references(volunteer_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_training_vol ON volunteer_training_attempts(volunteer_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteers_status ON volunteers(status);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_reviews_vol ON volunteer_reviews(volunteer_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_locations_alert ON locations(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteers_available ON volunteers(available);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_sessions_user ON evidence_sessions(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_chunks_session ON evidence_chunks(session_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_chunks_session_idx ON evidence_chunks(session_id, idx);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_view_log_vol ON volunteer_view_log(volunteer_id, alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_feedback_vol ON volunteer_feedback(volunteer_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_incident_events_alert ON incident_events(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_incident_events_user ON incident_events(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_incident_events_ts ON incident_events(ts);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteer_query_log_vol_time ON volunteer_query_log(volunteer_id, query_time);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_escorts_user ON escorts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_escorts_status ON escorts(status);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_escort_contacts_escort ON escort_contacts(escort_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_escort_contacts_token ON escort_contacts(token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notifications_next_attempt ON notifications(next_attempt_at);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notifications_provider_msg ON notifications(provider_message_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notifications_event_contact_channel ON notifications(event_key, contact_id, channel);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_notif_settings_user ON notification_settings(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contacts_optout_token ON contacts(optout_token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_share_contacts_share ON share_contacts(share_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_share_contacts_token ON share_contacts(token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_rides_user ON rides(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ride_contacts_ride ON ride_contacts(ride_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ride_contacts_token ON ride_contacts(token);')


    conn.commit()
    conn.close()
    print("SafeHer SQLite database initialized successfully.")


if __name__ == '__main__':
    init_db()

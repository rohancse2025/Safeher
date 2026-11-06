# backend/db.py – SQLite database connection and table schema creation
import os
import sqlite3
from dotenv import load_dotenv

# Load settings from .env file
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
load_dotenv()

# Database path: resolves relative paths relative to backend directory
db_env = os.getenv('DATABASE_PATH', 'safeher.db')
if not os.path.isabs(db_env):
    DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), db_env)
else:
    DB_PATH = db_env


def get_db():
    """
    Open and return a new SQLite connection.
    Enables dictionary-like column access (sqlite3.Row) and foreign key constraints.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON;')
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

    # 2. Contacts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT,
            relationship TEXT,
            close INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # 3. Alerts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            mode TEXT NOT NULL,
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

    # 5. Volunteers table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS volunteers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE NOT NULL,
            available INTEGER DEFAULT 0,
            lat REAL,
            lng REAL,
            status TEXT DEFAULT 'pending',
            note TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

    # Add columns if migrating existing database
    cursor.execute("PRAGMA table_info(contacts);")
    contact_cols = [col['name'] for col in cursor.fetchall()]
    if 'close' not in contact_cols:
        cursor.execute("ALTER TABLE contacts ADD COLUMN close INTEGER DEFAULT 0;")

    cursor.execute("PRAGMA table_info(alerts);")
    alert_cols = [col['name'] for col in cursor.fetchall()]
    if 'note' not in alert_cols:
        cursor.execute("ALTER TABLE alerts ADD COLUMN note TEXT;")

    cursor.execute("PRAGMA table_info(volunteers);")
    vol_cols = [col['name'] for col in cursor.fetchall()]
    if 'status' not in vol_cols:
        cursor.execute("ALTER TABLE volunteers ADD COLUMN status TEXT DEFAULT 'pending';")
    if 'note' not in vol_cols:
        cursor.execute("ALTER TABLE volunteers ADD COLUMN note TEXT;")

    # 6. Responses table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            volunteer_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
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

    # Useful indexes for high performance lookups
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(share_token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_locations_alert ON locations(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteers_available ON volunteers(available);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_sessions_user ON evidence_sessions(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_chunks_session ON evidence_chunks(session_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_evidence_chunks_session_idx ON evidence_chunks(session_id, idx);')

    conn.commit()
    conn.close()
    print("SafeHer SQLite database initialized successfully.")


if __name__ == '__main__':
    init_db()

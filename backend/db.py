# backend/db.py – SQLite database connection and table schema creation
import os
import sqlite3
from dotenv import load_dotenv

# Load settings from .env file
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
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    ''')

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

    # Useful indexes for high performance lookups
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(share_token);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_locations_alert ON locations(alert_id);')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_volunteers_available ON volunteers(available);')

    conn.commit()
    conn.close()
    print("SafeHer SQLite database initialized successfully.")


if __name__ == '__main__':
    init_db()

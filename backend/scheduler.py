# backend/scheduler.py – Background Maintenance Scheduler (30-day Evidence Expiration)
import os
import time
import shutil
import logging
import threading
from datetime import datetime, timedelta
from db import get_db

logger = logging.getLogger('safeher')

def cleanup_old_evidence_sessions():
    """
    Deletes evidence sessions and all associated chunk files older than 30 days.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        # Query sessions older than 30 days
        cursor.execute('''
            SELECT id, user_id, started_at
            FROM evidence_sessions
            WHERE started_at < datetime('now', '-30 days');
        ''')
        expired_sessions = cursor.fetchall()

        if not expired_sessions:
            conn.close()
            return 0

        evidence_base = os.path.abspath(os.path.join(os.path.dirname(__file__), 'evidence'))
        deleted_count = 0

        for session in expired_sessions:
            session_id = session['id']
            user_id = session['user_id']

            # 1. Delete chunk files from filesystem
            session_dir = os.path.join(evidence_base, str(user_id), str(session_id))
            if os.path.exists(session_dir):
                shutil.rmtree(session_dir, ignore_errors=True)

            # 2. Delete database rows
            cursor.execute('DELETE FROM evidence_chunks WHERE session_id = ?;', (session_id,))
            cursor.execute('DELETE FROM evidence_sessions WHERE id = ?;', (session_id,))
            deleted_count += 1
            print(f"[Scheduler] Purged evidence session {session_id} older than 30 days for user {user_id}")

        conn.commit()
        conn.close()
        return deleted_count

    except Exception as e:
        print(f"[Scheduler Error] cleanup_old_evidence_sessions: {e}")
        return 0


def start_scheduler():
    """
    Starts background maintenance thread running hourly.
    """
    def loop():
        # Run immediately upon server startup
        cleanup_old_evidence_sessions()

        while True:
            # Check every hour (3600 seconds)
            time.sleep(3600)
            try:
                cleanup_old_evidence_sessions()
            except Exception as e:
                print(f"[Scheduler Loop Error] {e}")

    thread = threading.Thread(target=loop, daemon=True, name="EvidenceMaintenanceScheduler")
    thread.start()
    print("[Scheduler] Evidence expiration scheduler running (30-day retention policy)")

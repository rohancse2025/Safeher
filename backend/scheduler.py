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


def cleanup_old_volunteer_id_images():
    """
    Delete the ID image 7 days after any final decision (approved, rejected, revoked, expired).
    Keeps id_last4 and id_type intact.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        # Query volunteers with final decision updated over 7 days ago and id_image_path present
        cursor.execute('''
            SELECT id, user_id, id_image_path, status, updated_at
            FROM volunteers
            WHERE status IN ('approved', 'rejected', 'revoked', 'expired')
              AND id_image_path IS NOT NULL
              AND updated_at < datetime('now', '-7 days');
        ''')
        rows = cursor.fetchall()
        if not rows:
            conn.close()
            return 0

        backend_dir = os.path.dirname(os.path.abspath(__file__))
        deleted_count = 0

        for r in rows:
            rel_path = r['id_image_path']
            full_path = os.path.join(backend_dir, rel_path) if not os.path.isabs(rel_path) else rel_path

            if os.path.exists(full_path):
                try:
                    os.remove(full_path)
                except Exception as fe:
                    print(f"[Scheduler Error] Could not remove ID image {full_path}: {fe}")

            cursor.execute("UPDATE volunteers SET id_image_path = NULL WHERE id = ?;", (r['id'],))
            deleted_count += 1
            print(f"[Scheduler] Purged ID image for volunteer {r['id']} (status was '{r['status']}') after 7-day retention")

        conn.commit()
        conn.close()
        return deleted_count

    except Exception as e:
        print(f"[Scheduler Error] cleanup_old_volunteer_id_images: {e}")
        return 0


def promote_eligible_volunteers_to_trusted():
    """
    Promote a volunteer to "trusted" when:
      - at least 3 completed responses
      - every feedback entry helpful and respectful
      - no reports (report_type == 'none' for all)
      - at least 30 days since approval (approved_at <= 30 days ago)
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            SELECT id, user_id, full_name, approved_at
            FROM volunteers
            WHERE status = 'approved'
              AND level = 'provisional'
              AND approved_at IS NOT NULL
              AND approved_at <= datetime('now', '-30 days');
        ''')
        candidates = cursor.fetchall()
        promoted_count = 0

        for vol in candidates:
            v_id = vol['id']

            # 1. At least 3 completed responses (alert resolved / not active)
            cursor.execute('''
                SELECT COUNT(*) AS cnt
                FROM responses r
                JOIN alerts a ON r.alert_id = a.id
                WHERE r.volunteer_id = ? AND r.status = 'coming' AND a.status != 'active';
            ''', (v_id,))
            comp_row = cursor.fetchone()
            comp_cnt = comp_row['cnt'] if comp_row else 0
            if comp_cnt < 3:
                continue

            # 2. Check feedback: all helpful & respectful, no reports
            cursor.execute('''
                SELECT COUNT(*) AS total_fb,
                       SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS helpful_cnt,
                       SUM(CASE WHEN respectful = 1 THEN 1 ELSE 0 END) AS respectful_cnt,
                       SUM(CASE WHEN report_type != 'none' THEN 1 ELSE 0 END) AS reports_cnt
                FROM volunteer_feedback
                WHERE volunteer_id = ?;
            ''', (v_id,))
            fb = cursor.fetchone()
            total_fb = fb['total_fb'] if fb else 0
            helpful_cnt = fb['helpful_cnt'] if fb else 0
            respectful_cnt = fb['respectful_cnt'] if fb else 0
            reports_cnt = fb['reports_cnt'] if fb else 0

            # Must have no negative reports
            if reports_cnt > 0:
                continue

            # If feedback exists, every entry must be helpful and respectful
            if total_fb > 0:
                if helpful_cnt < total_fb or respectful_cnt < total_fb:
                    continue

            # Promote to trusted
            cursor.execute('''
                UPDATE volunteers
                SET level = 'trusted',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?;
            ''', (v_id,))

            cursor.execute('''
                INSERT INTO volunteer_reviews (volunteer_id, reviewer, action, note)
                VALUES (?, 'scheduler', 'promote', 'Promoted to Trusted: 3+ completed responses, exemplary feedback, 30+ days approved');
            ''', (v_id,))

            promoted_count += 1
            print(f"[Scheduler] Promoted volunteer #{v_id} ({vol['full_name'] or 'Volunteer'}) to 'trusted' level")

        conn.commit()
        conn.close()
        return promoted_count
    except Exception as e:
        print(f"[Scheduler Error] promote_eligible_volunteers_to_trusted: {e}")
        return 0


def expire_outdated_volunteer_validity():
    """
    Mark volunteers whose valid_until has passed as "expired" and send them a push or email to re-verify.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            SELECT v.id, v.user_id, v.full_name, v.valid_until, u.email, u.name
            FROM volunteers v
            JOIN users u ON v.user_id = u.id
            WHERE v.status = 'approved'
              AND v.valid_until IS NOT NULL
              AND v.valid_until <= CURRENT_TIMESTAMP;
        ''')
        expired_vols = cursor.fetchall()
        expired_count = 0

        for vol in expired_vols:
            v_id = vol['id']
            cursor.execute('''
                UPDATE volunteers
                SET status = 'expired',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?;
            ''', (v_id,))

            cursor.execute('''
                INSERT INTO volunteer_reviews (volunteer_id, reviewer, action, note)
                VALUES (?, 'scheduler', 'expire', 'Volunteer approval validity expired. Re-verification required.');
            ''', (v_id,))

            expired_count += 1
            print(f"[Scheduler] Marked volunteer #{v_id} as 'expired' (validity ended {vol['valid_until']})")

            # Send re-verification notification
            try:
                from email_service import send_email
                if vol['email']:
                    subj = "SafeHer – Volunteer Approval Expired (Re-verification Required)"
                    body = (
                        f"Hello {vol['name']},\n\n"
                        "Your volunteer safety verification period has reached its 12-month renewal date.\n"
                        "To continue receiving emergency alerts in your community, please log into SafeHer to re-verify your volunteer profile.\n\n"
                        "SafeHer Team"
                    )
                    send_email(vol['email'], subj, body)
            except Exception:
                pass

        conn.commit()
        conn.close()
        return expired_count
    except Exception as e:
        print(f"[Scheduler Error] expire_outdated_volunteer_validity: {e}")
        return 0


def cleanup_old_incident_events():
    """
    Delete incident_events older than 30 days in the scheduler.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            DELETE FROM incident_events
            WHERE ts < datetime('now', '-30 days')
               OR (created_at IS NOT NULL AND created_at < datetime('now', '-30 days'));
        ''')
        deleted_count = cursor.rowcount
        conn.commit()
        conn.close()
        if deleted_count > 0:
            print(f"[Scheduler] Purged {deleted_count} incident events older than 30 days")
        return deleted_count
    except Exception as e:
        print(f"[Scheduler Error] cleanup_old_incident_events: {e}")
        return 0


def start_scheduler():
    """
    Starts background maintenance thread running hourly.
    """
    def loop():
        # Run immediately upon server startup
        cleanup_old_evidence_sessions()
        cleanup_old_volunteer_id_images()
        promote_eligible_volunteers_to_trusted()
        expire_outdated_volunteer_validity()
        cleanup_old_incident_events()

        while True:
            # Check every hour (3600 seconds)
            time.sleep(3600)
            try:
                cleanup_old_evidence_sessions()
                cleanup_old_volunteer_id_images()
                promote_eligible_volunteers_to_trusted()
                expire_outdated_volunteer_validity()
                cleanup_old_incident_events()
            except Exception as e:
                print(f"[Scheduler Loop Error] {e}")

    thread = threading.Thread(target=loop, daemon=True, name="EvidenceMaintenanceScheduler")
    thread.start()
    print("[Scheduler] Evidence expiration scheduler running (30-day retention policy)")

# backend/scheduler.py – Background Maintenance Scheduler (30-day Evidence Expiration)
import os
import time
import shutil
import logging
import threading
from datetime import datetime, timedelta, timezone
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


def check_expired_shares():
    """
    Find active shares that have expired (until_stopped = 0 and expires_at <= now),
    mark them as 'expired', ended_at = CURRENT_TIMESTAMP, and dispatch 'share_ended'.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT s.id, s.user_id, u.name AS user_name
            FROM shares s
            JOIN users u ON s.user_id = u.id
            WHERE s.status = 'active'
              AND s.until_stopped = 0
              AND s.expires_at IS NOT NULL
              AND s.expires_at <= datetime('now');
        ''')
        expired_rows = cursor.fetchall()
        for r in expired_rows:
            sid = r['id']
            uid = r['user_id']
            uname = r['user_name'] or 'SafeHer User'
            cursor.execute("UPDATE shares SET status = 'expired', ended_at = CURRENT_TIMESTAMP WHERE id = ?;", (sid,))
            cursor.execute("SELECT contact_id FROM share_contacts WHERE share_id = ?;", (sid,))
            c_ids = [cr['contact_id'] for cr in cursor.fetchall()]
            conn.commit()

            try:
                from services.notify import notify
                notify(
                    event_type='share_ended',
                    user_id=uid,
                    context={'user_name': uname, 'share_id': sid},
                    contact_ids=c_ids,
                    event_key=f"share:{sid}:ended"
                )
            except Exception as notif_err:
                print(f"[Scheduler Expire Share Notify Error] {notif_err}")

        conn.commit()
        conn.close()
        return len(expired_rows)
    except Exception as e:
        print(f"[Scheduler Expire Shares Error] {e}")
        return 0


def check_late_rides():
    """
    Monitor active rides:
    (1) If 10 minutes past expected_end_at and late_notified = 0:
        Send 'ride_late' notification and set late_notified = 1.
    (2) If 20 minutes past expected_end_at and alert_created = 0:
        Create a normal alert with reason 'late_arrival' and set alert_created = 1.
    """
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT r.id, r.user_id, r.expected_end_at, r.late_notified, r.alert_created,
                   r.destination, r.vehicle_type, r.vehicle_number, r.last_lat, r.last_lng,
                   u.name AS user_name
            FROM rides r
            JOIN users u ON r.user_id = u.id
            WHERE r.status = 'active' AND r.expected_end_at IS NOT NULL;
        ''')
        rides = cursor.fetchall()
        now_utc = datetime.now(timezone.utc) if hasattr(datetime, 'now') else datetime.utcnow()

        for r in rides:
            rid = r['id']
            uid = r['user_id']
            uname = r['user_name'] or 'SafeHer User'
            end_str = r['expected_end_at']
            try:
                end_dt = datetime.fromisoformat(end_str.replace('Z', '+00:00')) if 'T' in end_str else datetime.strptime(end_str, "%Y-%m-%d %H:%M:%S")
                if end_dt.tzinfo is None:
                    end_dt = end_dt.replace(tzinfo=timedelta(hours=0))
                now_cmp = datetime.now(end_dt.tzinfo)
            except Exception:
                continue

            sec_past = (now_cmp - end_dt).total_seconds()

            # (1) 10 minutes past expected end -> send ride_late
            if sec_past >= 600 and not r['late_notified']:
                cursor.execute("UPDATE rides SET late_notified = 1 WHERE id = ?;", (rid,))
                cursor.execute("SELECT contact_id FROM ride_contacts WHERE ride_id = ?;", (rid,))
                c_ids = [cr['contact_id'] for cr in cursor.fetchall()]
                conn.commit()

                try:
                    from services.notify import notify
                    notify(
                        event_type='ride_late',
                        user_id=uid,
                        context={
                            'user_name': uname,
                            'destination': r['destination'],
                            'vehicle_type': r['vehicle_type'],
                            'vehicle_number': r['vehicle_number'],
                            'ride_id': rid
                        },
                        contact_ids=c_ids,
                        event_key=f"ride:{rid}:late"
                    )
                except Exception as notif_err:
                    print(f"[Scheduler Late Ride Notify Error] {notif_err}")

            # (2) 20 minutes past expected end -> create normal alert with late_arrival
            if sec_past >= 1200 and not r['alert_created']:
                cursor.execute("UPDATE rides SET alert_created = 1 WHERE id = ?;", (rid,))
                conn.commit()

                lat = r['last_lat'] or 12.9716
                lng = r['last_lng'] or 77.5946

                try:
                    from routes.alerts import create_alert_internal
                    create_alert_internal(
                        user_id=uid,
                        user_name=uname,
                        mode='normal',
                        lat=lat,
                        lng=lng,
                        reason='late_arrival',
                        note=f"Automated Ride Alert: Overdue by 20 minutes past expected arrival at {r['destination']}",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    conn.commit()
                except Exception as alert_err:
                    print(f"[Scheduler Late Ride Alert Error] {alert_err}")

        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[Scheduler Check Late Rides Error] {e}")


def check_alert_reminders():
    """
    Periodic check for active alerts (SOS, Uneasy, Escort, Timer, Ride):
    Sends reminder emails at 3 minutes and 10 minutes to the same contacts
    if no contact has responded through the tracking page.
    Event keys: alert:<id>:reminder1 and alert:<id>:reminder2.
    Stops as soon as any contact responds or the alert ends.
    Keeps sending to silent-mode alerts ended with the duress PIN (status='active', duress=1).
    Respects user setting 'alert_reminders' (default on).
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        # 1. Query all active alerts
        cursor.execute('''
            SELECT a.id, a.user_id, a.mode, a.status, a.started_at, a.lat, a.lng,
                   a.share_token, a.duress, u.name as user_name
            FROM alerts a
            JOIN users u ON a.user_id = u.id
            WHERE a.status = 'active';
        ''')
        active_alerts = cursor.fetchall()
        if not active_alerts:
            conn.close()
            return 0

        from services.notify import notify, format_ist_time

        reminders_queued = 0

        for a in active_alerts:
            alert_id = a['id']
            user_id = a['user_id']
            user_name = a['user_name'] or 'SafeHer User'

            # 2. Stop as soon as any contact responds through tracking page
            cursor.execute("SELECT COUNT(*) AS count FROM contact_responses WHERE alert_id = ?;", (alert_id,))
            resp_row = cursor.fetchone()
            if resp_row and resp_row['count'] > 0:
                continue

            # 3. Check if user turned off reminder emails in notification_settings
            cursor.execute('''
                SELECT enabled FROM notification_settings
                WHERE user_id = ? AND event_type IN ('alert_reminders', 'alert_reminder');
            ''', (user_id,))
            setting_row = cursor.fetchone()
            if setting_row and not bool(setting_row['enabled']):
                continue

            # 4. Calculate elapsed seconds since alert started
            started_at_str = a['started_at']
            if not started_at_str:
                continue

            elapsed_sec = 0.0
            try:
                cursor.execute("SELECT (julianday('now') - julianday(?)) * 86400 AS elapsed;", (started_at_str,))
                row_elapsed = cursor.fetchone()
                if row_elapsed and row_elapsed['elapsed'] is not None:
                    elapsed_sec = float(row_elapsed['elapsed'])
            except Exception:
                pass

            if elapsed_sec <= 0.0:
                try:
                    now_utc = datetime.now(timezone.utc)
                    clean = started_at_str.replace('Z', '+00:00')
                    if '+' in clean:
                        parsed = datetime.fromisoformat(clean)
                    else:
                        parsed = datetime.strptime(clean[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                    elapsed_sec = (now_utc - parsed).total_seconds()
                except Exception:
                    elapsed_sec = 0.0

            # Determine alert time in IST (e.g. "9:42 PM")
            alert_time_ist = format_ist_time(started_at_str)
            if " IST" in alert_time_ist:
                time_part = alert_time_ist.split(" IST")[0]
            else:
                time_part = alert_time_ist

            # Get contacts for this alert (from alert_contacts)
            cursor.execute("SELECT contact_id FROM alert_contacts WHERE alert_id = ?;", (alert_id,))
            ac_rows = cursor.fetchall()
            alert_contacts = [r['contact_id'] for r in ac_rows] if ac_rows else None

            context = {
                'user_name': user_name,
                'alert_time_ist': time_part,
                'time_str': format_ist_time(),
                'lat': a['lat'] or 12.9716,
                'lng': a['lng'] or 77.5946
            }

            # 5. Check Reminder 1 at 3 minutes (>= 180 seconds)
            if elapsed_sec >= 180:
                event_key_1 = f"alert:{alert_id}:reminder1"
                cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = ?;", (event_key_1,))
                notif_check = cursor.fetchone()
                if not notif_check or notif_check['count'] == 0:
                    try:
                        notify(
                            event_type="alert_reminder",
                            user_id=user_id,
                            context=context,
                            contact_ids=alert_contacts,
                            alert_id=alert_id,
                            event_key=event_key_1
                        )
                        reminders_queued += 1
                        logger.info(f"[Scheduler] Alert #{alert_id} 3-minute reminder queued (key={event_key_1})")
                    except Exception as e:
                        logger.warning(f"[Scheduler Reminder 1 Error] {e}")

            # 6. Check Reminder 2 at 10 minutes (>= 600 seconds)
            if elapsed_sec >= 600:
                event_key_2 = f"alert:{alert_id}:reminder2"
                cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = ?;", (event_key_2,))
                notif_check = cursor.fetchone()
                if not notif_check or notif_check['count'] == 0:
                    try:
                        notify(
                            event_type="alert_reminder",
                            user_id=user_id,
                            context=context,
                            contact_ids=alert_contacts,
                            alert_id=alert_id,
                            event_key=event_key_2
                        )
                        reminders_queued += 1
                        logger.info(f"[Scheduler] Alert #{alert_id} 10-minute reminder queued (key={event_key_2})")
                    except Exception as e:
                        logger.warning(f"[Scheduler Reminder 2 Error] {e}")

        conn.commit()
        conn.close()
        return reminders_queued
    except Exception as e:
        logger.error(f"[Scheduler check_alert_reminders Error] {e}")
        return 0


def run_tick():
    """
    Periodic tick executed every 10 seconds:
    - Ends expired location shares and dispatches share_ended
    - Monitors late rides (ride_late at +10 min, normal alert at +20 min)
    - Checks 3-minute and 10-minute active alert reminder emails
    - Flushes queued notifications from the outbox
    Returns:
        number of notifications processed.
    """
    try:
        check_expired_shares()
        check_late_rides()
        check_alert_reminders()
        from services.notify import process_outbox
        return process_outbox(limit=25)
    except Exception as e:
        print(f"[Scheduler Tick Error] {e}")
        return 0


def start_scheduler():
    """
    Starts background maintenance thread running hourly and outbox tick running every 10 seconds.
    """
    def tick_loop():
        # Defer 3s to let app bind cleanly
        time.sleep(3)
        while True:
            try:
                run_tick()
            except Exception as e:
                print(f"[Tick Loop Error] {e}")
            time.sleep(10)

    tick_thread = threading.Thread(target=tick_loop, daemon=True, name="OutboxTicker10s")
    tick_thread.start()
    print("[Scheduler] Notification outbox tick scheduler active (10s intervals)")
    def loop():
        # Defer startup DB operations by 5s to let Gunicorn bind immediately to port
        time.sleep(5)
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

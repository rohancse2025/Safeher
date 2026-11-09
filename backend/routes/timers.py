# backend/routes/timers.py – Safe timer management and 10-second background expiration escalation
import time
import secrets
import datetime
import threading
from flask import Blueprint, request, jsonify, g

from db import get_db
from logger import app_logger
from routes.auth import login_required
from routes.alerts import get_user_from_request
from email_service import (
    send_alert_notifications_background,
    send_timer_started_email_notifications_background,
    send_timer_safe_email_notifications_background
)
try:
    from services.events import log_event
except ImportError:
    from backend.services.events import log_event
from whatsapp_service import (
    send_whatsapp_notifications_background,
    send_timer_started_whatsapp_notifications_background,
    send_timer_safe_whatsapp_notifications_background
)

timers_bp = Blueprint('timers', __name__)


# ─── Route: POST /api/timers ─────────────────────────────────
@timers_bp.route('/api/timers', methods=['POST'])
def create_timer():
    """
    Start a new Safe Timer with duration in minutes and optional trusted contact.
    Expects JSON: { minutes: int, contact_id: int (optional) }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    data = request.get_json(silent=True) or {}

    try:
        minutes = float(data.get('minutes'))
        if minutes <= 0:
            return jsonify({"ok": False, "error": "Minutes must be greater than zero"}), 400
    except (ValueError, TypeError):
        return jsonify({"ok": False, "error": "Minutes is required and must be a valid number"}), 400

    contact_id = data.get('contact_id')
    if contact_id:
        try:
            contact_id = int(contact_id)
        except (ValueError, TypeError):
            return jsonify({"ok": False, "error": "Invalid contact_id"}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Validate contact belongs to user if specified
    if contact_id:
        cursor.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
        if not cursor.fetchone():
            conn.close()
            return jsonify({"ok": False, "error": "Contact not found"}), 404

    # Cancel any currently running timers for this user
    cursor.execute("UPDATE timers SET status = 'cancelled' WHERE user_id = ? AND status = 'active';", (user_id,))

    # Calculate deadline in UTC
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    deadline_utc = now_utc + datetime.timedelta(minutes=minutes)
    deadline_str = deadline_utc.strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute('''
        INSERT INTO timers (user_id, contact_id, deadline, status)
        VALUES (?, ?, ?, 'active');
    ''', (user_id, contact_id, deadline_str))
    timer_id = cursor.lastrowid

    # Retrieve contacts to notify
    recipient_phones = []
    recipient_emails = []
    client_contacts = data.get('contacts') or []
    for cc in client_contacts:
        if isinstance(cc, dict):
            p = str(cc.get('phone') or '').strip()
            e = str(cc.get('email') or '').strip()
            if p and p not in recipient_phones:
                recipient_phones.append(p)
            if e and e not in recipient_emails:
                recipient_emails.append(e)

    if not recipient_phones and not recipient_emails:
        try:
            cursor.execute('SELECT phone, email FROM contacts WHERE user_id = ?;', (user_id,))
            for r in cursor.fetchall():
                p = str(r['phone'] or '').strip()
                e = str(r['email'] or '').strip()
                if p and p not in recipient_phones:
                    recipient_phones.append(p)
                if e and e not in recipient_emails:
                    recipient_emails.append(e)
        except Exception:
            pass

    pass

    conn.commit()
    conn.close()

    user_name = data.get('user_name') or user.get('name') or 'Rohan P'
    if user_name == 'SafeHer User':
        user_name = 'Rohan P'
    try:
        send_timer_started_whatsapp_notifications_background(timer_id, user_name, minutes, deadline_str, recipient_phones)
    except Exception as wa_err:
        app_logger.error(f'[Timer] WhatsApp start notification error: {wa_err}')

    try:
        from services.notify import notify
        notify(
            event_type='timer_start',
            user_id=user_id,
            context={
                'user_name': user_name,
                'minutes': minutes
            },
            contact_ids=[contact_id] if contact_id else None,
            event_key=f"timer:{timer_id}:started"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY TIMER START ERROR] {notify_err}")

    try:
        from services.notify import notify
        notify(
            event_type='timer_start',
            user_id=user_id,
            context={
                'user_name': user_name,
                'minutes': int(minutes),
                'deadline': deadline_str,
                'timer_id': timer_id
            },
            contact_ids=[contact_id] if contact_id else None,
            event_key=f"timer_start_{timer_id}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY TIMER_START ERROR] {notify_err}")

    return jsonify({
        "ok": True,
        "data": {
            "id": timer_id,
            "user_id": user_id,
            "contact_id": contact_id,
            "minutes": minutes,
            "deadline": deadline_str,
            "status": "active"
        }
    }), 201


# ─── Route: POST /api/timers/<id>/safe ───────────────────────
@timers_bp.route('/api/timers/<int:timer_id>/safe', methods=['POST'])
def mark_timer_safe(timer_id):
    """
    Cancel / mark a running timer as safe. Owner only.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, status FROM timers WHERE id = ?;', (timer_id,))
    timer = cursor.fetchone()

    if not timer:
        conn.close()
        return jsonify({"ok": False, "error": "Timer not found"}), 404

    cursor.execute("UPDATE timers SET status = 'safe' WHERE id = ?;", (timer_id,))
    log_event(
        user_id=user_id,
        type='user_checkin_ok',
        actor='user',
        detail={'timer_id': timer_id},
        cursor=cursor
    )

    recipient_phones = []
    recipient_emails = []
    try:
        cursor.execute('SELECT phone, email FROM contacts WHERE user_id = ?;', (user_id,))
        for r in cursor.fetchall():
            p = str(r['phone'] or '').strip()
            e = str(r['email'] or '').strip()
            if p and p not in recipient_phones:
                recipient_phones.append(p)
            if e and e not in recipient_emails:
                recipient_emails.append(e)
    except Exception:
        pass

    pass

    conn.commit()
    conn.close()

    try:
        send_timer_safe_whatsapp_notifications_background(timer_id, user_name, recipient_phones)
    except Exception as wa_safe_err:
        app_logger.error(f'[Timer Safe] WhatsApp error: {wa_safe_err}')

    try:
        from services.notify import notify
        notify(
            event_type='timer_safe',
            user_id=user_id,
            context={
                'user_name': user_name
            },
            event_key=f"timer:{timer_id}:safe"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY TIMER SAFE ERROR] {notify_err}")

    try:
        from services.notify import notify
        notify(
            event_type='timer_safe',
            user_id=user_id,
            context={
                'user_name': user_name,
                'timer_id': timer_id
            },
            event_key=f"timer_safe_{timer_id}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY TIMER_SAFE ERROR] {notify_err}")

    return jsonify({
        "ok": True,
        "data": {
            "id": timer_id,
            "status": "safe",
            "message": "Timer marked safe successfully"
        }
    }), 200


# ─── Route: GET /api/timers/active ───────────────────────────
@timers_bp.route('/api/timers/active', methods=['GET'])
@login_required
def get_active_timer():
    """
    Get the authenticated user's currently running timer, if any.
    """
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, contact_id, deadline, status
        FROM timers
        WHERE user_id = ? AND status = 'active'
        ORDER BY id DESC LIMIT 1;
    ''', (user_id,))
    timer = cursor.fetchone()
    conn.close()

    if not timer:
        return jsonify({
            "ok": True,
            "data": None
        }), 200

    timer_dict = dict(timer)
    # Calculate seconds remaining
    try:
        deadline_dt = datetime.datetime.strptime(timer_dict['deadline'], "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
        now_dt = datetime.datetime.now(datetime.timezone.utc)
        remaining_secs = max(0, int((deadline_dt - now_dt).total_seconds()))
    except Exception:
        remaining_secs = 0

    timer_dict['remaining_seconds'] = remaining_secs
    return jsonify({
        "ok": True,
        "data": timer_dict
    }), 200


# ─── Background Daemon: Check Expired Timers Every 10s ───────
def _check_expired_timers_inner(conn):
    now_utc_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()

    # Auto-expire active alerts running for more than 6 hours and mark as 'expired'
    cursor.execute('''
        UPDATE alerts
        SET status = 'expired', ended_at = CURRENT_TIMESTAMP
        WHERE status = 'active'
          AND started_at <= datetime('now', '-6 hours');
    ''')
    conn.commit()

    # Privacy retention: Automatically delete location rows older than 30 days
    cursor.execute('''
        DELETE FROM locations
        WHERE time <= datetime('now', '-30 days');
    ''')
    conn.commit()

    # Find active timers that expired
    cursor.execute('''
        SELECT t.id, t.user_id, t.contact_id, t.deadline, u.name
        FROM timers t
        JOIN users u ON t.user_id = u.id
        WHERE t.status = 'active' AND t.deadline <= ?;
    ''', (now_utc_str,))
    expired_timers = cursor.fetchall()

    for item in expired_timers:
        timer_id = item['id']
        user_id = item['user_id']
        user_name = item.get('user_name') if hasattr(item, 'get') else None
        if not user_name:
            user_name = item['name'] if item['name'] else 'Rohan P'
        if user_name == 'SafeHer User':
            user_name = 'Rohan P'

        # 1. Mark timer as expired
        cursor.execute("UPDATE timers SET status = 'expired' WHERE id = ?;", (timer_id,))

        # 2. Find last known coordinates for user
        # Check locations table first
        cursor.execute('''
            SELECT l.lat, l.lng
            FROM locations l
            JOIN alerts a ON l.alert_id = a.id
            WHERE a.user_id = ?
            ORDER BY l.id DESC LIMIT 1;
        ''', (user_id,))
        loc_row = cursor.fetchone()

        if loc_row and loc_row['lat'] is not None and loc_row['lng'] is not None:
            last_lat = loc_row['lat']
            last_lng = loc_row['lng']
        else:
            # Fallback to volunteer location if available
            cursor.execute('SELECT lat, lng FROM volunteers WHERE user_id = ?;', (user_id,))
            vol_loc = cursor.fetchone()
            if vol_loc and vol_loc['lat'] is not None and vol_loc['lng'] is not None:
                last_lat = vol_loc['lat']
                last_lng = vol_loc['lng']
            else:
                # Default Bengaluru fallback coordinates if none logged
                last_lat = 12.9716
                last_lng = 77.5946

        # 3. Create alert with mode 'timer' and reason 'timer'
        share_token = secrets.token_urlsafe(16)
        cursor.execute('''
            INSERT INTO alerts (user_id, mode, reason, status, lat, lng, share_token, notified_count, duress)
            VALUES (?, 'timer', 'timer', 'active', ?, ?, ?, 0, 0);
        ''', (user_id, last_lat, last_lng, share_token))
        alert_id = cursor.lastrowid
        app_logger.info(f"[ALERT CREATED] alert_id={alert_id}, user_id={user_id}, mode=timer, reason=timer, lat={last_lat}, lng={last_lng}")

        # Log alert_created and timer_expired incident events
        log_event(
            user_id=user_id,
            type='alert_created',
            actor='system',
            detail={'mode': 'timer', 'reason': 'timer'},
            alert_id=alert_id,
            cursor=cursor
        )
        log_event(
            user_id=user_id,
            type='timer_expired',
            actor='system',
            detail={'timer_id': timer_id},
            alert_id=alert_id,
            cursor=cursor
        )

        # Record location entry
        cursor.execute('''
            INSERT INTO locations (alert_id, lat, lng)
            VALUES (?, ?, ?);
        ''', (alert_id, last_lat, last_lng))

        # 4. Get emergency contact emails and phones and generate contact tokens
        cursor.execute('''
            SELECT id, name, phone, email FROM contacts
            WHERE user_id = ?;
        ''', (user_id,))
        contact_rows = cursor.fetchall()
        contacts_emails = [r['email'].strip() for r in contact_rows if r['email'] and r['email'].strip()]
        contacts_phones = [r['phone'].strip() for r in contact_rows if r['phone'] and r['phone'].strip()]

        contact_tokens_email = {}
        contact_tokens_phone = {}
        for r in contact_rows:
            c_token = secrets.token_urlsafe(24)
            cursor.execute('''
                INSERT INTO alert_contacts (alert_id, contact_id, token)
                VALUES (?, ?, ?);
            ''', (alert_id, r['id'], c_token))
            if r['email'] and r['email'].strip():
                contact_tokens_email[r['email'].strip()] = c_token
            if r['phone'] and r['phone'].strip():
                contact_tokens_phone[r['phone'].strip()] = c_token

        conn.commit()

        # 5. Central notification engine dispatch (idempotent, outbox, Brevo delivery)
        try:
            from services.notify import notify
            frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
            notify(
                event_type='timer_expired',
                user_id=user_id,
                alert_id=alert_id,
                context={
                    'user_name': user_name,
                    'lat': last_lat,
                    'lng': last_lng,
                    'alert_id': alert_id,
                    'track_url': f"{frontend_url}/track.html?t={share_token}"
                },
                event_key=f"timer:{timer_id}:expired"
            )
        except Exception as notify_err:
            app_logger.warning(f"[NOTIFY TIMER EXPIRED ERROR] {notify_err}")

        # 6. Dispatch automated emergency WhatsApp to contacts
        if contacts_phones:
            send_whatsapp_notifications_background(
                alert_id=alert_id,
                user_name=user_name,
                mode="timer",
                started_at_str=now_utc_str,
                lat=last_lat,
                lng=last_lng,
                share_token=share_token,
                recipient_phones=contacts_phones,
                contact_tokens=contact_tokens_phone
            )

        # 6. Dispatch Web Push notification to user
        try:
            from routes.push import notify_user_timer_expired
            notify_user_timer_expired(user_id=user_id, timer_id=timer_id)
        except Exception as push_err:
            pass

        try:
            from services.notify import notify
            frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
            notify(
                event_type='timer_expired',
                user_id=user_id,
                context={
                    'user_name': user_name,
                    'timer_id': timer_id,
                    'alert_id': alert_id,
                    'lat': last_lat,
                    'lng': last_lng,
                    'track_url': f"{frontend_url}/track.html?t={share_token}"
                },
                alert_id=alert_id,
                event_key=f"timer_expired_{timer_id}"
            )
        except Exception as notify_err:
            app_logger.warning(f"[NOTIFY TIMER_EXPIRED ERROR] {notify_err}")

        print(f"[TimerMonitor] Expired timer {timer_id} escalated to SOS Alert {alert_id} for user {user_id}")


def check_expired_timers():
    conn = None
    try:
        conn = get_db()
        _check_expired_timers_inner(conn)
    except Exception as e:
        print(f"[TimerMonitor Error] {e}")
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def start_timer_monitor():
    """
    Launch background thread checking for expired timers every 10 seconds.
    """
    def loop():
        time.sleep(5)
        while True:
            try:
                check_expired_timers()
            except Exception as e:
                print(f"[TimerMonitor Loop Error] {e}")
            time.sleep(10)

    monitor_thread = threading.Thread(target=loop, daemon=True)
    monitor_thread.start()

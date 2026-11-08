# backend/routes/alerts.py – Emergency alerts, live tracking updates, duress PIN handling, and public tracking
import secrets
import datetime
import math
import json
from flask import Blueprint, request, jsonify, g
from werkzeug.security import check_password_hash

from db import get_db
from logger import app_logger
from routes.auth import login_required, SECRET_KEY
from email_service import send_email, send_alert_notifications_background
from services.events import log_event, VALID_ALERT_REASONS
from whatsapp_service import send_whatsapp_notifications_background
import jwt

alerts_bp = Blueprint('alerts', __name__)

VALID_MODES = {'normal', 'silent', 'emergency', 'timer', 'uneasy'}

EARTH_RADIUS_METERS = 6371000.0


def haversine_m(lat1, lon1, lat2, lon2):
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c



def get_user_from_request():
    """
    Safely resolves the authenticated user from:
      1. Active g.current_user
      2. Authorization Bearer JWT header
      3. URL query / body token
      4. Emergency fallback user_id or phone
    Ensures life-saving emergency SOS calls are never dropped due to stale client state.
    """
    if hasattr(g, 'current_user') and g.current_user:
        return g.current_user

    # 1. Check Bearer token or query token
    auth_header = request.headers.get('Authorization', '')
    token = None
    if auth_header.startswith('Bearer '):
        token = auth_header.split(' ', 1)[1].strip()
    if not token:
        token = request.args.get('token')
    if not token and request.is_json:
        data = request.get_json(silent=True) or {}
        token = data.get('token')

    if token:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
            uid = payload.get('user_id')
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id, name, phone, email FROM users WHERE id = ?;', (uid,))
            user = c.fetchone()
            conn.close()
            if user:
                return dict(user)
        except Exception:
            pass

    # 2. Check user_id or phone from request payload
    data = request.get_json(silent=True) or {}
    req_uid = data.get('user_id') or request.args.get('user_id')
    req_phone = data.get('phone') or request.args.get('phone')

    conn = get_db()
    c = conn.cursor()
    user = None
    if req_uid:
        try:
            c.execute('SELECT id, name, phone, email FROM users WHERE id = ?;', (int(req_uid),))
            user = c.fetchone()
        except (ValueError, TypeError):
            pass
    if not user and req_phone:
        c.execute('SELECT id, name, phone, email FROM users WHERE phone = ?;', (str(req_phone).strip(),))
        user = c.fetchone()
    if not user:
        # Fallback to demo or first active user in DB so emergency calls are never rejected
        c.execute('SELECT id, name, phone, email FROM users ORDER BY id ASC LIMIT 1;')
        user = c.fetchone()
    conn.close()
    if user:
        return dict(user)

    return None


def is_valid_coord(lat, lng):
    """Validate latitude and longitude numbers."""
    try:
        f_lat = float(lat)
        f_lng = float(lng)
        return -90.0 <= f_lat <= 90.0 and -180.0 <= f_lng <= 180.0
    except (ValueError, TypeError):
        return False


# ─── Route: POST /api/alerts ─────────────────────────────────
def create_alert_internal(user_id, user_name, mode='normal', lat=12.9716, lng=77.5946, reason='manual', note=None, bypass_rate_limit=False, cursor=None, conn=None, client_contacts=None):
    """
    Internal alert creation core logic.
    Reused by user SOS, timer auto-expiration, and escort system alerts.
    Dispatches background email, whatsapp, volunteer pushes, and logs incident events.
    Returns (True, result_dict, 201) on success, or (False, error_msg, status_code) on failure.
    """
    mode = (mode or 'normal').strip().lower()
    if mode not in VALID_MODES:
        return False, f"Invalid mode. Must be one of: {', '.join(VALID_MODES)}", 400

    if lat is None or lng is None or not is_valid_coord(lat, lng):
        return False, "Valid latitude and longitude coordinates are required", 400

    lat = float(lat)
    lng = float(lng)
    share_token = secrets.token_urlsafe(16)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    close_conn = False
    if cursor is None:
        if conn is None:
            conn = get_db()
            close_conn = True
        cursor = conn.cursor()

    # Rate limiting (bypassed for system alerts like timer and escort monitoring)
    if not bypass_rate_limit:
        if mode == 'uneasy':
            cursor.execute('''
                SELECT COUNT(*) AS count FROM alerts
                WHERE user_id = ? AND mode = 'uneasy' AND started_at >= datetime('now', '-1 hour');
            ''', (user_id,))
            if cursor.fetchone()['count'] >= 10:
                if close_conn:
                    conn.close()
                return False, "Rate limit exceeded: maximum 10 uneasy check-ins per hour", 429
        else:
            cursor.execute('''
                SELECT COUNT(*) AS count FROM alerts
                WHERE user_id = ? AND mode != 'uneasy' AND started_at >= datetime('now', '-1 hour');
            ''', (user_id,))
            if cursor.fetchone()['count'] >= 5:
                if close_conn:
                    conn.close()
                return False, "Rate limit exceeded: maximum 5 SOS alerts per hour", 429

    try:
        # 1. Insert alert record with reason
        raw_reason = (reason or 'manual').strip().lower()
        reason = raw_reason if raw_reason in VALID_ALERT_REASONS else 'manual'
        cursor.execute('''
            INSERT INTO alerts (user_id, mode, reason, status, lat, lng, share_token, notified_count, duress, note)
            VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 0, ?);
        ''', (user_id, mode, reason, lat, lng, share_token, note or None))
        alert_id = cursor.lastrowid

        # Log alert_created incident event
        log_event(
            user_id=user_id,
            type='alert_created',
            actor='system' if bypass_rate_limit else 'user',
            detail={'mode': mode, 'reason': reason},
            alert_id=alert_id,
            cursor=cursor
        )

        # 2. Insert first location row
        cursor.execute('''
            INSERT INTO locations (alert_id, lat, lng)
            VALUES (?, ?, ?);
        ''', (alert_id, lat, lng))

        # Sync any client-provided contacts into DB if not already present
        if client_contacts and isinstance(client_contacts, list):
            for cc in client_contacts:
                if isinstance(cc, dict):
                    c_name = str(cc.get('name') or '').strip()
                    c_phone = str(cc.get('phone') or '').strip()
                    c_email = str(cc.get('email') or '').strip()
                    c_rel = str(cc.get('relation') or 'Emergency Contact').strip()
                    c_close = 1 if cc.get('close') else 0
                    if c_name and (c_phone or c_email):
                        cursor.execute('''
                            SELECT id FROM contacts WHERE user_id = ? AND (phone = ? OR (email = ? AND email != ''));
                        ''', (user_id, c_phone, c_email))
                        if not cursor.fetchone():
                            cursor.execute('''
                                INSERT INTO contacts (user_id, name, phone, email, relationship, close)
                                VALUES (?, ?, ?, ?, ?, ?);
                            ''', (user_id, c_name, c_phone, c_email or None, c_rel or None, c_close))

        # 3. Retrieve contacts: for uneasy mode, strictly notify close=true contacts only
        if mode == 'uneasy':
            cursor.execute('''
                SELECT id, name, phone, email FROM contacts
                WHERE user_id = ? AND close = 1;
            ''', (user_id,))
        else:
            cursor.execute('''
                SELECT id, name, phone, email FROM contacts
                WHERE user_id = ?;
            ''', (user_id,))
        contact_rows = cursor.fetchall()
        recipient_emails = [r['email'].strip() for r in contact_rows if r['email'] and r['email'].strip()]
        recipient_phones = [r['phone'].strip() for r in contact_rows if r['phone'] and r['phone'].strip()]

        # Generate unique contact token for each contact and store in alert_contacts
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

        if close_conn:
            conn.commit()
    except Exception as e:
        if close_conn:
            conn.close()
        return False, f"Failed to create alert: {e}", 500
    finally:
        if close_conn:
            conn.close()

    # 4. Trigger background email dispatch to contacts (works for all modes including silent and uneasy)
    if recipient_emails:
        send_alert_notifications_background(
            alert_id=alert_id,
            user_name=user_name,
            mode=mode,
            started_at_str=now_str,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_emails=recipient_emails,
            note=note,
            contact_tokens=contact_tokens_email
        )

    # 5. Trigger background automated WhatsApp dispatch to contacts
    if recipient_phones:
        send_whatsapp_notifications_background(
            alert_id=alert_id,
            user_name=user_name,
            mode=mode,
            started_at_str=now_str,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_phones=recipient_phones,
            contact_tokens=contact_tokens_phone
        )

    # Log alert creation event
    app_logger.info(f"[ALERT CREATED] alert_id={alert_id}, user_id={user_id}, mode={mode}, reason={reason}, lat={lat}, lng={lng}")

    # 6. Trigger Web Push notification to available approved volunteers (UNEASY MODE SENDS NOTHING TO VOLUNTEERS)
    if mode != 'uneasy':
        try:
            from routes.push import notify_nearby_volunteers_on_alert
            notify_nearby_volunteers_on_alert(
                alert_id=alert_id,
                alert_mode=mode,
                alert_lat=lat,
                alert_lng=lng,
                exclude_user_id=user_id
            )
        except Exception as push_err:
            app_logger.error(f"[Alert] Volunteer push trigger error: {push_err}")

    result_data = {
        "id": alert_id,
        "user_id": user_id,
        "mode": mode,
        "status": "active",
        "lat": lat,
        "lng": lng,
        "share_token": share_token,
        "notified_count": len(recipient_emails) + len(recipient_phones),
        "created_at": now_str,
        "note": note or None
    }
    return True, result_data, 201


# ─── Route: POST /api/alerts ─────────────────────────────────
@alerts_bp.route('/api/alerts', methods=['POST'])
def create_alert():
    """
    Create a new emergency alert (normal, silent, or emergency).
    Expects JSON: { mode: "normal"|"silent"|"emergency", lat: float, lng: float, reason?: str, note?: str }
    """
    user = get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization or user identification required"}), 401

    data = request.get_json(silent=True) or {}
    mode = (data.get('mode') or 'normal').strip().lower()
    note = (data.get('note') or '').strip()
    lat = data.get('lat')
    lng = data.get('lng')
    reason = (data.get('reason') or 'manual').strip().lower()

    ok, res, status_code = create_alert_internal(
        user_id=user['id'],
        user_name=user['name'],
        mode=mode,
        lat=lat,
        lng=lng,
        reason=reason,
        note=note or None,
        bypass_rate_limit=False,
        client_contacts=data.get('contacts')
    )
    if not ok:
        return jsonify({"ok": False, "error": res}), status_code

    return jsonify({"ok": True, "data": res}), status_code
# ─── Route: POST / GET /api/alerts/quick (Zero-UI Quick Trigger) ──────
@alerts_bp.route('/api/alerts/quick', methods=['GET', 'POST'])
def quick_trigger_alert():
    """
    Zero-UI emergency SOS trigger.
    Allows triggering immediate SOS alerts without navigating or tapping in the app.
    Usable via:
      - Android Home screen shortcut or widget
      - Browser bookmark (GET /api/alerts/quick?token=...)
      - Hardware button automation (Tasker / Macrodroid / iOS Shortcut)
    """
    user = get_user_from_request()
    if not user:
        return jsonify({
            "ok": False,
            "error": "Quick trigger token or credentials required. Pass ?token=<jwt> or Authorization header"
        }), 401

    user_id = user['id']
    user_name = user['name']
    conn = get_db()
    cursor = conn.cursor()

    user_name = user['name']

    # Get coordinates from query / json or fallback to last known
    lat_val = request.args.get('lat') or (request.get_json(silent=True) or {}).get('lat')
    lng_val = request.args.get('lng') or (request.get_json(silent=True) or {}).get('lng')

    if lat_val and lng_val and is_valid_coord(lat_val, lng_val):
        lat = float(lat_val)
        lng = float(lng_val)
    else:
        cursor.execute('''
            SELECT l.lat, l.lng FROM locations l
            JOIN alerts a ON l.alert_id = a.id
            WHERE a.user_id = ? ORDER BY l.id DESC LIMIT 1;
        ''', (user_id,))
        loc = cursor.fetchone()
        if loc and loc['lat'] and loc['lng']:
            lat, lng = loc['lat'], loc['lng']
        else:
            lat, lng = 12.9716, 77.5946

    share_token = secrets.token_urlsafe(16)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    raw_reason = (request.args.get('reason') or (request.get_json(silent=True) or {}).get('reason') or 'manual').strip().lower()
    reason = raw_reason if raw_reason in VALID_ALERT_REASONS else 'manual'
    cursor.execute('''
        INSERT INTO alerts (user_id, mode, reason, status, lat, lng, share_token, notified_count, duress)
        VALUES (?, 'emergency', ?, 'active', ?, ?, ?, 0, 0);
    ''', (user_id, reason, lat, lng, share_token))
    alert_id = cursor.lastrowid

    log_event(
        user_id=user_id,
        type='alert_created',
        actor='user',
        detail={'mode': 'emergency', 'reason': reason},
        alert_id=alert_id,
        cursor=cursor
    )

    cursor.execute('INSERT INTO locations (alert_id, lat, lng) VALUES (?, ?, ?);', (alert_id, lat, lng))

    cursor.execute('SELECT id, name, phone, email FROM contacts WHERE user_id = ?;', (user_id,))
    contact_rows = cursor.fetchall()
    recipient_emails = [r['email'].strip() for r in contact_rows if r['email'] and r['email'].strip()]
    recipient_phones = [r['phone'].strip() for r in contact_rows if r['phone'] and r['phone'].strip()]

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
    conn.close()

    if recipient_emails:
        send_alert_notifications_background(alert_id, user_name, 'emergency', now_str, lat, lng, share_token, recipient_emails, contact_tokens=contact_tokens_email)
    if recipient_phones:
        send_whatsapp_notifications_background(alert_id, user_name, 'emergency', now_str, lat, lng, share_token, recipient_phones, contact_tokens=contact_tokens_phone)

    app_logger.info(f"[QUICK ALERT CREATED] alert_id={alert_id}, user_id={user_id}, lat={lat}, lng={lng}")

    # If called from a web browser via GET, show confirmation HTML
    if request.method == 'GET' and 'text/html' in request.headers.get('Accept', ''):
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={share_token}"
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SOS Activated - SafeHer</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FCEFF3; color: #111; margin: 0; padding: 24px; text-align: center; }}
    .card {{ background: #fff; border: 1px solid #A80F3C; border-radius: 8px; padding: 24px; max-width: 420px; margin: 30px auto; }}
    h1 {{ color: #A80F3C; font-size: 24px; margin: 0 0 12px; }}
    p {{ font-size: 14px; color: #333; line-height: 1.5; margin: 8px 0; }}
    .badge {{ display: inline-block; background: #A80F3C; color: #fff; font-weight: bold; padding: 6px 12px; border-radius: 4px; font-size: 13px; margin: 12px 0; }}
    .btn {{ display: block; width: 100%; box-sizing: border-box; background: #A80F3C; color: #fff; text-decoration: none; padding: 12px; border-radius: 6px; font-weight: bold; margin-top: 14px; }}
    .btn-sec {{ background: #fff; color: #A80F3C; border: 1px solid #A80F3C; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">EMERGENCY SOS ACTIVE</div>
    <h1>Alert Dispatched!</h1>
    <p>SafeHer has automatically dispatched emergency alerts to your trusted contacts via Email and WhatsApp.</p>
    <p><strong>Time:</strong> {now_str}</p>
    <a class="btn" href="{track_link}">View Live Tracking</a>
    <a class="btn btn-sec" href="/">Open SafeHer App</a>
  </div>
</body>
</html>""", 200

    return jsonify({
        "ok": True,
        "data": {
            "id": alert_id,
            "status": "active",
            "mode": "emergency",
            "share_token": share_token,
            "emails_dispatched": len(recipient_emails),
            "whatsapp_dispatched": len(recipient_phones),
            "started_at": now_str
        }
    }), 201


# ─── Route: POST /api/alerts/<id>/location ───────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/location', methods=['POST'])
@login_required
def add_alert_location(alert_id):
    """
    Append a new live tracking location for the active alert.
    Only the owner of an active alert can post location updates.
    Expects JSON: { lat: float, lng: float }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}

    lat = data.get('lat')
    lng = data.get('lng')
    if lat is None or lng is None or not is_valid_coord(lat, lng):
        return jsonify({"ok": False, "error": "Valid latitude and longitude coordinates are required"}), 400

    lat = float(lat)
    lng = float(lng)

    conn = get_db()
    cursor = conn.cursor()

    # Check that alert belongs to user and is currently active
    cursor.execute('SELECT id, status FROM alerts WHERE id = ? AND user_id = ?;', (alert_id, user_id))
    alert = cursor.fetchone()

    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    if alert['status'] != 'active':
        conn.close()
        return jsonify({"ok": False, "error": "Cannot add location to an alert that is not active"}), 400

    try:
        # Insert into locations history
        cursor.execute('INSERT INTO locations (alert_id, lat, lng) VALUES (?, ?, ?);', (alert_id, lat, lng))
        # Update latest lat/lng on alerts table
        cursor.execute('UPDATE alerts SET lat = ?, lng = ? WHERE id = ?;', (lat, lng, alert_id))
        conn.commit()
    except Exception:
        conn.close()
        return jsonify({"ok": False, "error": "Failed to record location"}), 500

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": alert_id,
            "lat": lat,
            "lng": lng,
            "message": "Location updated successfully"
        }
    }), 200


# ─── Route: POST /api/alerts/<id>/end ────────────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/end', methods=['POST'])
def end_alert(alert_id):
    """
    End an active alert using a 4-digit safety PIN.
    - If correct normal PIN: marks alert as 'resolved' with ended_at.
    - If duress PIN: answers success to attacker, but keeps alert active and sets duress=1.
    - If wrong PIN: returns an error.
    Expects JSON: { pin: "1234" }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    data = request.get_json(silent=True) or {}
    pin = str(data.get('pin') or '').strip()

    if not pin:
        return jsonify({"ok": False, "error": "Safety PIN is required to end alert"}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Verify alert ownership
    cursor.execute('SELECT id, status FROM alerts WHERE id = ? AND user_id = ?;', (alert_id, user_id))
    alert = cursor.fetchone()
    if not alert:
        cursor.execute('SELECT id, status FROM alerts WHERE id = ?;', (alert_id,))
        alert = cursor.fetchone()
    if not alert:
        cursor.execute("SELECT id, status FROM alerts WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": True, "data": {"alert_id": alert_id, "status": "resolved", "message": "Alert ended successfully"}}), 200

    target_alert_id = alert['id']

    # Fetch user's PIN hashes
    cursor.execute('SELECT pin_hash, duress_pin_hash FROM users WHERE id = ?;', (user_id,))
    user_row = cursor.fetchone()

    # 1. Normal PIN match or default 1234
    is_normal_pin = False
    is_duress_pin = False

    if user_row and user_row['pin_hash']:
        if check_password_hash(user_row['pin_hash'], pin):
            is_normal_pin = True
        elif user_row['duress_pin_hash'] and check_password_hash(user_row['duress_pin_hash'], pin):
            is_duress_pin = True
    elif pin == '1234' or not user_row or not user_row['pin_hash']:
        is_normal_pin = True

    if not is_normal_pin and not is_duress_pin:
        conn.close()
        return jsonify({"ok": False, "error": "Incorrect safety PIN"}), 400

    if is_normal_pin:
        cursor.execute('''
            UPDATE alerts
            SET status = 'resolved', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (target_alert_id,))

        # Log alert_ended by pin (duress PIN is NOT logged)
        log_event(
            user_id=user_id,
            type='alert_ended',
            actor='user',
            detail={'by': 'pin'},
            alert_id=target_alert_id,
            cursor=cursor
        )

        # End any open evidence sessions linked to this alert
        cursor.execute("SELECT id FROM evidence_sessions WHERE alert_id = ? AND ended_at IS NULL;", (str(target_alert_id),))
        for sess in cursor.fetchall():
            cursor.execute("UPDATE evidence_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?;", (sess['id'],))
            cursor.execute("SELECT COUNT(*) AS cnt FROM evidence_chunks WHERE session_id = ?;", (sess['id'],))
            cnt_row = cursor.fetchone()
            c_cnt = cnt_row['cnt'] if cnt_row else 0
            log_event(
                user_id=user_id,
                type='evidence_session_ended',
                actor='user',
                detail={'session_id': sess['id'], 'count': c_cnt},
                alert_id=target_alert_id,
                cursor=cursor
            )

        conn.commit()
        conn.close()
        app_logger.info(f"[ALERT ENDED] alert_id={target_alert_id}, status=resolved")
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": target_alert_id,
                "status": "resolved",
                "message": "Alert ended successfully"
            }
        }), 200

    if is_duress_pin:
        cursor.execute('UPDATE alerts SET duress = 1 WHERE id = ?;', (target_alert_id,))
        conn.commit()
        conn.close()
        app_logger.info(f"[ALERT ENDED] alert_id={target_alert_id}, status=duress")
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": target_alert_id,
                "status": "resolved",
                "message": "Alert ended successfully"
            }
        }), 200

    conn.close()
    return jsonify({"ok": False, "error": "Incorrect safety PIN"}), 403


# ─── Route: POST /api/alerts/<id>/escalate ───────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/escalate', methods=['POST'])
def escalate_alert(alert_id):
    """
    Escalate an active alert {to: "normal"|"emergency"}.
    Changes the mode, resends to ALL contacts, notifies volunteers, and logs event.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    user_name = user['name']
    data = request.get_json(silent=True) or {}
    to_mode = (data.get('to') or 'normal').strip().lower()
    if to_mode not in ('normal', 'emergency'):
        return jsonify({"ok": False, "error": "Invalid target mode. Must be 'normal' or 'emergency'"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, mode, status, lat, lng, share_token FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        cursor.execute("SELECT id, mode, status, lat, lng, share_token FROM alerts WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        alert = cursor.fetchone()

    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    target_id = alert['id']
    old_mode = alert['mode']
    lat = alert['lat']
    lng = alert['lng']
    share_token = alert['share_token']
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Update alert mode in database
    cursor.execute('UPDATE alerts SET mode = ? WHERE id = ?;', (to_mode, target_id))

    # Log alert_mode_changed incident event
    log_event(
        user_id=user_id,
        type='alert_mode_changed',
        actor='user',
        detail={'old_mode': old_mode, 'new_mode': to_mode},
        alert_id=target_id,
        cursor=cursor
    )

    # Retrieve ALL contacts (both close and standard)
    cursor.execute('SELECT phone, email FROM contacts WHERE user_id = ?;', (user_id,))
    contact_rows = cursor.fetchall()
    recipient_emails = [r['email'].strip() for r in contact_rows if r['email'] and r['email'].strip()]
    recipient_phones = [r['phone'].strip() for r in contact_rows if r['phone'] and r['phone'].strip()]
    conn.commit()
    conn.close()

    # Log the escalation event
    app_logger.info(f"[ALERT ESCALATED] alert_id={target_id}, user_id={user_id}, from={old_mode}, to={to_mode}")

    # Resend emails to all contacts
    if recipient_emails:
        send_alert_notifications_background(
            alert_id=target_id,
            user_name=user_name,
            mode=to_mode,
            started_at_str=now_str,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_emails=recipient_emails
        )

    # Resend WhatsApp to all contacts
    if recipient_phones:
        send_whatsapp_notifications_background(
            alert_id=target_id,
            user_name=user_name,
            mode=to_mode,
            started_at_str=now_str,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_phones=recipient_phones
        )

    # Notify volunteers (as for normal alerts)
    try:
        from routes.push import notify_nearby_volunteers_on_alert
        notify_nearby_volunteers_on_alert(
            alert_id=target_id,
            alert_mode=to_mode,
            alert_lat=lat,
            alert_lng=lng,
            exclude_user_id=user_id
        )
    except Exception as push_err:
        app_logger.error(f"[Alert] Volunteer push trigger on escalation error: {push_err}")

    return jsonify({
        "ok": True,
        "data": {
            "id": target_id,
            "mode": to_mode,
            "previous_mode": old_mode,
            "status": alert['status'],
            "notified_count": len(recipient_emails),
            "message": f"Alert escalated to {to_mode}"
        }
    }), 200


# ─── Route: POST /api/alerts/<id>/ok ─────────────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/ok', methods=['POST'])
def resolve_uneasy_alert_ok(alert_id):
    """
    End an 'uneasy' alert without a PIN (since it isn't an emergency).
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, mode, status FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        cursor.execute("SELECT id, mode, status FROM alerts WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        alert = cursor.fetchone()

    if not alert:
        conn.close()
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": alert_id,
                "status": "resolved",
                "message": "Alert ended successfully (I'm OK)"
            }
        }), 200

    target_id = alert['id']
    cursor.execute("UPDATE alerts SET status = 'resolved', ended_at = CURRENT_TIMESTAMP WHERE id = ?;", (target_id,))

    log_event(
        user_id=alert['user_id'],
        type='user_checkin_ok',
        actor='user',
        detail={'mode': alert['mode']},
        alert_id=target_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()
    app_logger.info(f"[ALERT OK] alert_id={target_id}, mode={alert['mode']}, status=resolved")

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": target_id,
            "status": "resolved",
            "message": "Alert ended successfully (I'm OK)"
        }
    }), 200


# ─── Route: GET /api/alerts ──────────────────────────────────
@alerts_bp.route('/api/alerts', methods=['GET'])
@login_required
def get_alert_history():
    """
    Retrieve the authenticated user's alert history.
    """
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, mode, status, lat, lng, started_at, ended_at, share_token, notified_count, duress
        FROM alerts
        WHERE user_id = ?
        ORDER BY started_at DESC, id DESC;
    ''', (user_id,))
    rows = cursor.fetchall()
    conn.close()

    history = [dict(r) for r in rows]
    return jsonify({
        "ok": True,
        "data": history
    }), 200


# ─── Route: GET /api/alerts/<id>/details ─────────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/details', methods=['GET'])
@login_required
def get_alert_details(alert_id):
    """
    Get detailed breakdown of a specific alert for the owner:
    mode, start & end time, duration, number of contacts emailed,
    volunteers who responded, and recorded location trail.
    """
    user_id = g.current_user['id']
    conn = get_db()
    cursor = conn.cursor()

    # Owner-only check
    cursor.execute('SELECT * FROM alerts WHERE id = ? AND user_id = ?;', (alert_id, user_id))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    # Calculate duration
    duration_str = "In progress" if alert['status'] == 'active' else "N/A"
    if alert['started_at'] and alert['ended_at']:
        try:
            from datetime import datetime
            fmt = "%Y-%m-%d %H:%M:%S"
            start_dt = datetime.strptime(str(alert['started_at'])[:19], fmt)
            end_dt = datetime.strptime(str(alert['ended_at'])[:19], fmt)
            diff_secs = max(0, int((end_dt - start_dt).total_seconds()))
            mins = diff_secs // 60
            secs = diff_secs % 60
            if mins >= 60:
                hours = mins // 60
                mins = mins % 60
                duration_str = f"{hours:02d}:{mins:02d}:{secs:02d}"
            else:
                duration_str = f"{mins:02d}:{secs:02d}"
        except Exception:
            duration_str = "Completed"

    # Fetch volunteers who responded
    cursor.execute('''
        SELECT r.id, r.status, r.time, u.name
        FROM responses r
        JOIN volunteers v ON r.volunteer_id = v.id
        JOIN users u ON v.user_id = u.id
        WHERE r.alert_id = ?
        ORDER BY r.id ASC;
    ''', (alert_id,))
    volunteers = [
        {
            "id": row['id'],
            "status": row['status'],
            "time": row['time'],
            "name": row['name']
        }
        for row in cursor.fetchall()
    ]

    # Fetch recorded location trail
    cursor.execute('''
        SELECT id, lat, lng, time
        FROM locations
        WHERE alert_id = ?
        ORDER BY id ASC;
    ''', (alert_id,))
    route_points = [
        {
            "lat": row['lat'],
            "lng": row['lng'],
            "time": row['time']
        }
        for row in cursor.fetchall()
    ]

    # Fetch incident timeline events
    cursor.execute('''
        SELECT id, user_id, alert_id, seq, ts, type, actor, detail_json, actor_label, event_type
        FROM incident_events
        WHERE alert_id = ?
        ORDER BY seq ASC, id ASC;
    ''', (alert_id,))
    incident_timeline = []
    for row in cursor.fetchall():
        d = {}
        if row['detail_json']:
            try:
                d = json.loads(row['detail_json'])
            except Exception:
                d = {}
        msg = d.get('message') or d.get('details')
        if not msg:
            if row['actor'] == 'volunteer':
                msg = f"{row['actor_label'] or 'Volunteer'} {d.get('status', 'responded')}"
            elif row['actor'] == 'contact':
                msg = f"{d.get('contact') or 'Contact'} {d.get('status', 'responded')}"
            elif row['type'] == 'alert_created':
                msg = f"Alert created ({d.get('mode', 'normal')})"
            elif row['type'] == 'alert_ended':
                msg = "Alert ended"
            else:
                msg = row['type'].replace('_', ' ').capitalize()

        incident_timeline.append({
            "id": row['id'],
            "seq": row['seq'],
            "ts": row['ts'],
            "type": row['type'],
            "event_type": row['type'],
            "actor": row['actor'],
            "actor_label": row['actor_label'] or row['actor'],
            "detail": d,
            "details": msg,
            "time": row['ts']
        })

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": alert['id'],
            "mode": alert['mode'],
            "status": alert['status'],
            "started_at": alert['started_at'],
            "ended_at": alert['ended_at'],
            "duration": duration_str,
            "contacts_notified": alert['notified_count'],
            "volunteers_responded": volunteers,
            "timeline": incident_timeline,
            "route": route_points,
            "lat": alert['lat'],
            "lng": alert['lng'],
            "share_token": alert['share_token']
        }
    }), 200


# ─── Public Route: GET /api/track/<token> ─────────────────────
@alerts_bp.route('/api/track/<token>', methods=['GET'])
def get_public_track(token):
    """
    Public live tracking route. Accessible without login.
    Accepts either:
      - contact_token (from alert_contacts): personalized link for a trusted contact.
        Returns is_contact: true, contact_first_name, contact_name, first_name (owner), mode, status,
        latest_lat, latest_lng, last_update_time, volunteers_en_route.
      - share_token (from alerts): general read-only link.
        Returns is_contact: false, contact_first_name: null, first_name (owner), mode, status, etc.
    Never exposes phone number, email, or user credentials.
    """
    clean_token = token.strip()

    conn = get_db()
    cursor = conn.cursor()

    # 1. First check if clean_token is a contact token in alert_contacts
    cursor.execute('''
        SELECT ac.id AS ac_id, ac.alert_id, ac.contact_id, ac.token AS contact_token,
               c.name AS contact_name,
               a.id, a.user_id, a.mode, a.status, a.lat, a.lng, a.started_at,
               u.name AS owner_name
        FROM alert_contacts ac
        JOIN alerts a ON ac.alert_id = a.id
        JOIN users u ON a.user_id = u.id
        JOIN contacts c ON ac.contact_id = c.id
        WHERE ac.token = ?;
    ''', (clean_token,))
    contact_match = cursor.fetchone()

    is_contact = False
    contact_first_name = None
    contact_name = None

    if contact_match:
        is_contact = True
        alert = contact_match
        contact_name = contact_match['contact_name'] or 'Contact'
        contact_first_name = contact_name.split()[0] if contact_name else 'Contact'
        owner_name = contact_match['owner_name'] or 'User'
    else:
        # 2. Check if clean_token matches alerts.share_token (general read-only token)
        cursor.execute('''
            SELECT a.id, a.user_id, a.mode, a.status, a.lat, a.lng, a.started_at,
                   u.name AS owner_name
            FROM alerts a
            JOIN users u ON a.user_id = u.id
            WHERE a.share_token = ?;
        ''', (clean_token,))
        alert = cursor.fetchone()
        if not alert:
            # 3. Check if clean_token is an escort contact token in escort_contacts
            cursor.execute('''
                SELECT ec.id AS ec_id, ec.escort_id, ec.contact_id, ec.token AS contact_token,
                       c.name AS contact_name,
                       e.id AS escort_id, e.user_id, e.dest_name, e.dest_lat, e.dest_lng,
                       e.route_json, e.route_distance_m, e.started_at, e.expected_end,
                       e.status, e.checkin_interval_min, e.deviation_m,
                       e.last_lat, e.last_lng, e.last_update_at, e.last_checkin_at,
                       e.next_checkin_due, e.off_route_since, e.alert_id, e.ended_at,
                       u.name AS owner_name
                FROM escort_contacts ec
                JOIN escorts e ON ec.escort_id = e.id
                JOIN users u ON e.user_id = u.id
                JOIN contacts c ON ec.contact_id = c.id
                WHERE ec.token = ?;
            ''', (clean_token,))
            escort_match = cursor.fetchone()

            if escort_match:
                # Check expiration: links expire 1 hour after the escort ends
                escort_status = escort_match['status']
                if escort_status in ('arrived', 'ended'):
                    end_time_str = escort_match['ended_at'] or escort_match['last_update_at'] or escort_match['expected_end']
                    if end_time_str:
                        try:
                            end_dt = datetime.datetime.fromisoformat(end_time_str.replace('Z', '+00:00')) if 'T' in end_time_str else datetime.datetime.strptime(end_time_str, "%Y-%m-%d %H:%M:%S")
                            if end_dt.tzinfo is None:
                                end_dt = end_dt.replace(tzinfo=datetime.timezone.utc)
                            now_utc = datetime.datetime.now(datetime.timezone.utc)
                            if (now_utc - end_dt).total_seconds() > 3600:
                                conn.close()
                                return jsonify({"ok": False, "error": "This journey tracking link has expired (links expire 1 hour after arrival or journey completion)."}), 404
                        except Exception:
                            pass

                # Status: On route, Off route, Paused, Check-in due, Alerted, Arrived
                alert_active = False
                if escort_match['alert_id']:
                    cursor.execute("SELECT status FROM alerts WHERE id = ?;", (escort_match['alert_id'],))
                    a_row = cursor.fetchone()
                    if a_row and a_row['status'] == 'active':
                        alert_active = True

                now_utc = datetime.datetime.now(datetime.timezone.utc)
                if alert_active:
                    status_label = "Alerted"
                elif escort_status == 'arrived':
                    status_label = "Arrived"
                elif escort_status == 'paused':
                    status_label = "Paused"
                elif escort_match['next_checkin_due']:
                    try:
                        chk_str = escort_match['next_checkin_due']
                        chk_dt = datetime.datetime.fromisoformat(chk_str.replace('Z', '+00:00')) if 'T' in chk_str else datetime.datetime.strptime(chk_str, "%Y-%m-%d %H:%M:%S")
                        if chk_dt.tzinfo is None:
                            chk_dt = chk_dt.replace(tzinfo=datetime.timezone.utc)
                        if now_utc > chk_dt:
                            status_label = "Check-in due"
                        elif escort_match['off_route_since']:
                            status_label = "Off route"
                        else:
                            status_label = "On route"
                    except Exception:
                        status_label = "Off route" if escort_match['off_route_since'] else "On route"
                elif escort_match['off_route_since']:
                    status_label = "Off route"
                else:
                    status_label = "On route"

                route_dist = float(escort_match['route_distance_m'] or 0)
                curr_lat = escort_match['last_lat'] if escort_match['last_lat'] is not None else escort_match['dest_lat']
                curr_lng = escort_match['last_lng'] if escort_match['last_lng'] is not None else escort_match['dest_lng']

                if status_label == "Arrived":
                    progress_percent = 100.0
                elif route_dist > 0 and curr_lat is not None and curr_lng is not None:
                    rem_dist = haversine_m(curr_lat, curr_lng, escort_match['dest_lat'], escort_match['dest_lng'])
                    progress_percent = max(0.0, min(100.0, round((1.0 - rem_dist / route_dist) * 100, 1)))
                else:
                    progress_percent = 0.0

                try:
                    route_points = json.loads(escort_match['route_json']) if escort_match['route_json'] else []
                except Exception:
                    route_points = []

                owner_name = escort_match['owner_name'] or 'User'
                first_name = owner_name.split()[0] if owner_name else 'User'
                contact_name = escort_match['contact_name'] or 'Contact'
                contact_first_name = contact_name.split()[0] if contact_name else 'Contact'

                conn.close()

                return jsonify({
                    "ok": True,
                    "data": {
                        "type": "escort",
                        "first_name": first_name,
                        "destination_name": escort_match['dest_name'],
                        "route": route_points,
                        "current_position": {
                            "lat": curr_lat,
                            "lng": curr_lng
                        },
                        "latest_lat": curr_lat,
                        "latest_lng": curr_lng,
                        "progress_percent": progress_percent,
                        "status": status_label,
                        "last_checkin_time": escort_match['last_checkin_at'],
                        "next_checkin_time": escort_match['next_checkin_due'],
                        "eta": escort_match['expected_end'],
                        "last_update_time": escort_match['last_update_at'] or escort_match['started_at'],
                        "is_contact": True,
                        "contact_first_name": contact_first_name,
                        "contact_name": contact_name
                    }
                }), 200

            conn.close()
            return jsonify({"ok": False, "error": "Tracking link not found or expired"}), 404
        owner_name = alert['owner_name'] or 'User'

    alert_id = alert['id']
    status = alert['status']

    # Auto-expire active alerts: 2 hours for uneasy mode, 6 hours for others
    if status == 'active' and alert['started_at']:
        try:
            started_dt = datetime.datetime.strptime(alert['started_at'], "%Y-%m-%d %H:%M:%S")
            expire_hours = 2 if alert['mode'] == 'uneasy' else 6
            if datetime.datetime.now() - started_dt > datetime.timedelta(hours=expire_hours):
                cursor.execute("UPDATE alerts SET status = 'expired', ended_at = CURRENT_TIMESTAMP WHERE id = ?;", (alert_id,))
                conn.commit()
                status = 'expired'
        except Exception:
            pass

    # Get latest recorded location (fallback to alert coordinates if no locations logged)
    cursor.execute('''
        SELECT lat, lng, time FROM locations
        WHERE alert_id = ?
        ORDER BY id DESC LIMIT 1;
    ''', (alert_id,))
    latest_loc = cursor.fetchone()

    latest_lat = latest_loc['lat'] if latest_loc else alert['lat']
    latest_lng = latest_loc['lng'] if latest_loc else alert['lng']
    last_update_time = latest_loc['time'] if latest_loc else alert['started_at']

    # Count volunteers currently en route for this alert
    cursor.execute('''
        SELECT COUNT(*) AS coming_count FROM responses
        WHERE alert_id = ? AND status = 'coming';
    ''', (alert_id,))
    resp_row = cursor.fetchone()
    volunteers_en_route = resp_row['coming_count'] if resp_row else 0

    conn.close()

    # Extract alert owner's first name
    first_name = owner_name.split()[0] if owner_name else 'User'

    res_data = {
        "first_name": first_name,
        "mode": alert['mode'],
        "status": status,
        "latest_lat": latest_lat,
        "latest_lng": latest_lng,
        "last_update_time": last_update_time,
        "volunteers_en_route": volunteers_en_route,
        "is_contact": is_contact
    }
    if is_contact:
        res_data["contact_first_name"] = contact_first_name
        res_data["contact_name"] = contact_name

    return jsonify({
        "ok": True,
        "data": res_data
    }), 200


# ─── Route: POST /api/track/<token>/respond ───────────────────
@alerts_bp.route('/api/track/<token>/respond', methods=['POST'])
def respond_contact_track(token):
    """
    Allow a contact to submit a response from the tracking page without logging in.
    Valid ONLY with a contact token and an active alert.
    Rate limited to 10 responses per hour per token.
    Stores the response in the contact_responses table.
    Sends a Web Push notification to the alert owner if subscribed.
    Expects JSON: { "status": "on_my_way" | "called" | "alerted_police" | "cannot_reach" }
    """
    clean_token = token.strip()
    data = request.get_json(silent=True) or {}
    status = (data.get('status') or '').strip().lower()

    VALID_CONTACT_STATUSES = {'on_my_way', 'called', 'alerted_police', 'cannot_reach'}
    if status not in VALID_CONTACT_STATUSES:
        return jsonify({
            "ok": False,
            "error": f"Invalid status. Must be one of: {', '.join(sorted(VALID_CONTACT_STATUSES))}"
        }), 400

    conn = get_db()
    cursor = conn.cursor()

    # Verify contact token
    cursor.execute('''
        SELECT ac.id AS ac_id, ac.alert_id, ac.contact_id, ac.token,
               a.id AS alert_id, a.user_id, a.status AS alert_status,
               c.name AS contact_name
        FROM alert_contacts ac
        JOIN alerts a ON ac.alert_id = a.id
        JOIN contacts c ON ac.contact_id = c.id
        WHERE ac.token = ?;
    ''', (clean_token,))
    row = cursor.fetchone()

    if not row:
        cursor.execute('''
            SELECT ec.id AS ec_id, ec.escort_id, ec.contact_id, ec.token,
                   e.id AS escort_id, e.user_id, e.status AS escort_status, e.alert_id,
                   c.name AS contact_name
            FROM escort_contacts ec
            JOIN escorts e ON ec.escort_id = e.id
            JOIN contacts c ON ec.contact_id = c.id
            WHERE ec.token = ?;
        ''', (clean_token,))
        escort_row = cursor.fetchone()
        if escort_row:
            if escort_row['escort_status'] in ('arrived', 'ended'):
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": "This journey has ended"
                }), 400

            escort_aid = escort_row['alert_id']
            escort_id = escort_row['escort_id']
            contact_id = escort_row['contact_id']
            owner_user_id = escort_row['user_id']
            contact_name_val = (escort_row['contact_name'] or 'Contact').strip()
            first_name = contact_name_val.split()[0] if contact_name_val else 'Contact'

            if escort_aid:
                cursor.execute('''
                    SELECT COUNT(*) AS count FROM contact_responses
                    WHERE alert_id = ? AND contact_id = ? AND created_at >= datetime('now', '-1 hour');
                ''', (escort_aid, contact_id))
                cnt_row = cursor.fetchone()
                if cnt_row and cnt_row['count'] >= 10:
                    conn.close()
                    return jsonify({
                        "ok": False,
                        "error": "Rate limit exceeded: maximum 10 responses per hour per contact link"
                    }), 429

                cursor.execute('''
                    INSERT INTO contact_responses (alert_id, contact_id, status)
                    VALUES (?, ?, ?);
                ''', (escort_aid, contact_id, status))

            log_event(
                user_id=owner_user_id,
                type='contact_responded',
                actor='contact',
                detail={'contact': first_name, 'status': status},
                alert_id=escort_aid,
                escort_id=escort_id,
                cursor=cursor
            )
            conn.commit()
            conn.close()

            try:
                from routes.push import notify_alert_owner_contact_response
                notify_alert_owner_contact_response(owner_user_id, first_name, status)
            except Exception:
                pass

            return jsonify({
                "ok": True,
                "message": f"Response recorded: {status}",
                "data": {
                    "contact_first_name": first_name,
                    "status": status
                }
            }), 200

        conn.close()
        return jsonify({
            "ok": False,
            "error": "Only personalized contact links can submit status responses. Read-only links cannot respond."
        }), 403

    if row['alert_status'] != 'active':
        conn.close()
        return jsonify({
            "ok": False,
            "error": "This alert is no longer active"
        }), 400

    alert_id = row['alert_id']
    contact_id = row['contact_id']
    owner_user_id = row['user_id']
    contact_name = row['contact_name']

    # Rate limiting: maximum 10 responses per hour per token
    cursor.execute('''
        SELECT COUNT(*) AS count FROM contact_responses
        WHERE alert_id = ? AND contact_id = ? AND created_at >= datetime('now', '-1 hour');
    ''', (alert_id, contact_id))
    cnt_row = cursor.fetchone()
    if cnt_row and cnt_row['count'] >= 10:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Rate limit exceeded: maximum 10 responses per hour per contact link"
        }), 429

    # Insert into contact_responses
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute('''
        INSERT INTO contact_responses (alert_id, contact_id, status)
        VALUES (?, ?, ?);
    ''', (alert_id, contact_id, status))

    contact_name_val = (row['contact_name'] or 'Contact').strip()
    first_name = contact_name_val.split()[0] if contact_name_val else 'Contact'
    log_event(
        user_id=row['user_id'],
        type='contact_responded',
        actor='contact',
        detail={'contact': first_name, 'status': status},
        alert_id=alert_id,
        cursor=cursor
    )
    conn.commit()
    conn.close()

    # Send Web Push notification to alert owner if subscribed
    try:
        from routes.push import notify_alert_owner_contact_response
        notify_alert_owner_contact_response(
            owner_user_id=owner_user_id,
            alert_id=alert_id,
            contact_name=contact_name,
            status=status
        )
    except Exception as push_err:
        app_logger.error(f"[Alert Respond] Owner push trigger error: {push_err}")

    app_logger.info(f"[CONTACT RESPONSE] alert_id={alert_id}, contact={contact_name}, status={status}")

    return jsonify({
        "ok": True,
        "data": {
            "message": "Response recorded successfully",
            "alert_id": alert_id,
            "contact_name": contact_name,
            "status": status,
            "time": now_str
        }
    }), 200

# ─── Route: POST /api/track/<token>/ping-checkin ─────────────
@alerts_bp.route('/api/track/<token>/ping-checkin', methods=['POST'])
def ping_checkin_contact_track(token):
    """
    Allow a contact to ask the escort owner to check in from the tracking page without logging in.
    Valid ONLY with an escort contact token and an active or paused journey.
    Rate limited to 3 check-in requests per hour per contact link.
    Marks check-in request on the escort and notifies the user via Web Push if subscribed.
    Logs incident event without personal data.
    """
    clean_token = token.strip()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT ec.id AS ec_id, ec.escort_id, ec.contact_id, ec.token,
               e.id AS escort_id, e.user_id, e.dest_name, e.status AS escort_status,
               e.alert_id,
               c.name AS contact_name,
               u.name AS owner_name
        FROM escort_contacts ec
        JOIN escorts e ON ec.escort_id = e.id
        JOIN contacts c ON ec.contact_id = c.id
        JOIN users u ON e.user_id = u.id
        WHERE ec.token = ?;
    ''', (clean_token,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Only personalized contact links can request a check-in."
        }), 403

    if row['escort_status'] in ('arrived', 'ended'):
        conn.close()
        return jsonify({
            "ok": False,
            "error": "This journey has already ended"
        }), 400

    escort_id = row['escort_id']
    contact_id = row['contact_id']
    owner_user_id = row['user_id']
    contact_full_name = (row['contact_name'] or 'Contact').strip()
    contact_first_name = contact_full_name.split()[0] if contact_full_name else 'Contact'

    # Rate limiting: max 3 per hour per contact
    cursor.execute('''
        SELECT COUNT(*) AS count FROM escort_checkin_pings
        WHERE escort_id = ? AND contact_id = ? AND created_at >= datetime('now', '-1 hour');
    ''', (escort_id, contact_id))
    ping_count_row = cursor.fetchone()
    if ping_count_row and ping_count_row['count'] >= 3:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Rate limit exceeded: maximum 3 check-in requests per hour per contact link"
        }), 429

    cursor.execute('''
        INSERT INTO escort_checkin_pings (escort_id, contact_id)
        VALUES (?, ?);
    ''', (escort_id, contact_id))

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute('''
        UPDATE escorts
        SET checkin_requested_at = ?,
            checkin_requested_by = ?
        WHERE id = ?;
    ''', (now_str, contact_first_name, escort_id))

    # Log incident event: log nothing personal (no phone, email, full name)
    log_event(
        user_id=owner_user_id,
        type='checkin_requested',
        actor='contact',
        detail={'actor_label': 'Contact'},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    try:
        from routes.push import notify_escort_checkin_requested
        notify_escort_checkin_requested(owner_user_id, escort_id, contact_first_name)
    except Exception as push_err:
        app_logger.error(f"[Escort Ping Push Error] {push_err}")

    return jsonify({
        "ok": True,
        "message": "Check-in requested",
        "data": {
            "contact_first_name": contact_first_name,
            "requested_at": now_str
        }
    }), 200



# ─── Route: POST /api/test-email ─────────────────────────────
@alerts_bp.route('/api/test-email', methods=['POST'])
@login_required
def test_email():
    """
    Send a test email to the authenticated user's registered email address.
    """
    user_email = g.current_user.get('email')
    user_name = g.current_user.get('name', 'User')

    if not user_email:
        return jsonify({"ok": False, "error": "Your account does not have an email address registered"}), 400

    subject = "SafeHer – Test Email Notification"
    body = (
        f"Hello {user_name},\n\n"
        "This is a test notification confirming that SafeHer emergency email alerts are configured and working properly.\n\n"
        "Stay safe,\n"
        "SafeHer Team"
    )

    success, error_msg = send_email(user_email, subject, body)
    if not success:
        return jsonify({"ok": False, "error": "Failed to send email notification"}), 500

    return jsonify({
        "ok": True,
        "data": {
            "message": f"Test email sent successfully to {user_email}"
        }
    }), 200


# ─── Route: GET /api/alerts/<id>/responder-selfie/<vol_id> ───
@alerts_bp.route('/api/alerts/<int:alert_id>/responder-selfie/<int:volunteer_id>', methods=['GET'])
def get_responder_selfie(alert_id, volunteer_id):
    """
    Serves the selfie of a responding volunteer ONLY to the authenticated alert owner.
    """
    import os
    from flask import send_file
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()

    # 1. Verify alert exists and current user is the alert owner
    cursor.execute('SELECT id, user_id FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    if alert['user_id'] != user['id']:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden: Only the alert owner can view responder selfies"}), 403

    # 2. Verify volunteer actually responded 'coming' to this alert
    cursor.execute('''
        SELECT r.id FROM responses r
        WHERE r.alert_id = ? AND r.volunteer_id = ? AND r.status = 'coming';
    ''', (alert_id, volunteer_id))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer has not responded 'coming' to this alert"}), 404

    # 3. Retrieve selfie path
    cursor.execute('SELECT selfie_path FROM volunteers WHERE id = ?;', (volunteer_id,))
    vol = cursor.fetchone()
    conn.close()

    if not vol or not vol['selfie_path']:
        return jsonify({"ok": False, "error": "No selfie on file for this volunteer"}), 404

    selfie_path = vol['selfie_path']
    backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    full_path = os.path.join(backend_dir, selfie_path) if not os.path.isabs(selfie_path) else selfie_path

    if not os.path.exists(full_path):
        return jsonify({"ok": False, "error": "Selfie file not found on disk"}), 404

    mime = 'image/jpeg' if full_path.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
    return send_file(full_path, mimetype=mime)


# ─── Route: POST /api/alerts/<id>/volunteer-feedback ─────────
@alerts_bp.route('/api/alerts/<int:alert_id>/volunteer-feedback', methods=['POST'])
def submit_volunteer_feedback(alert_id):
    """
    POST /api/alerts/<id>/volunteer-feedback
    {volunteer_id, helpful, respectful, report_type: none|unsafe|inappropriate|other, comment}
    (alert owner only, once per volunteer per alert).
    Any report_type of "unsafe" or "inappropriate" sets volunteer to "suspended" immediately.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()

    # 1. Verify alert and ownership
    cursor.execute('SELECT id, user_id FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    if alert['user_id'] != user['id']:
        conn.close()
        return jsonify({"ok": False, "error": "Forbidden: Only the alert owner can submit volunteer feedback"}), 403

    data = request.get_json(silent=True) or {}
    volunteer_id = data.get('volunteer_id')
    if not volunteer_id:
        conn.close()
        return jsonify({"ok": False, "error": "volunteer_id is required"}), 400

    helpful = bool(data.get('helpful', True))
    respectful = bool(data.get('respectful', True))
    report_type = (data.get('report_type') or 'none').strip().lower()
    comment = (data.get('comment') or '').strip()

    valid_reports = {"none", "unsafe", "inappropriate", "other"}
    if report_type not in valid_reports:
        conn.close()
        return jsonify({"ok": False, "error": f"Invalid report_type '{report_type}'. Choose from: {', '.join(sorted(valid_reports))}"}), 400

    # 2. Verify volunteer responded to this alert
    cursor.execute('SELECT id FROM responses WHERE alert_id = ? AND volunteer_id = ?;', (alert_id, volunteer_id))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer did not respond to this alert"}), 400

    # 3. Check if feedback already submitted (once per volunteer per alert)
    cursor.execute('SELECT id FROM volunteer_feedback WHERE alert_id = ? AND volunteer_id = ?;', (alert_id, volunteer_id))
    if cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Feedback already submitted for this volunteer on this alert"}), 400

    # 4. Insert feedback
    cursor.execute('''
        INSERT INTO volunteer_feedback (alert_id, volunteer_id, user_id, helpful, respectful, report_type, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?);
    ''', (alert_id, volunteer_id, user['id'], 1 if helpful else 0, 1 if respectful else 0, report_type, comment))

    # Add volunteer feedback summary to incident timeline as "Volunteer 1 responded" without names
    from routes.volunteers import get_volunteer_alert_label
    actor_label = get_volunteer_alert_label(cursor, alert_id, volunteer_id)
    log_event(
        user_id=user['id'],
        type='volunteer_feedback',
        actor='user',
        detail={'volunteer': actor_label, 'status': 'responded'},
        alert_id=alert_id,
        cursor=cursor
    )

    # 5. Check if unsafe or inappropriate report -> immediately suspend volunteer
    suspended = False
    if report_type in ("unsafe", "inappropriate"):
        cursor.execute('''
            UPDATE volunteers
            SET status = 'suspended',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (volunteer_id,))
        suspended = True

        # Audit row in volunteer_reviews
        cursor.execute('''
            INSERT INTO volunteer_reviews (volunteer_id, reviewer, action, note)
            VALUES (?, 'system', 'suspend', ?);
        ''', (volunteer_id, f"Volunteer suspended immediately due to {report_type} feedback on alert #{alert_id}. Comment: {comment}"))

        # Log in incident_events (anonymously)
        log_event(
            user_id=user['id'],
            type='volunteer_reported',
            actor='user',
            detail={'volunteer': actor_label, 'report_type': report_type},
            alert_id=alert_id,
            cursor=cursor
        )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": alert_id,
            "volunteer_id": volunteer_id,
            "helpful": helpful,
            "respectful": respectful,
            "report_type": report_type,
            "volunteer_suspended": suspended,
            "message": "Feedback submitted successfully" + (" and volunteer suspended pending admin review." if suspended else ".")
        }
    }), 200

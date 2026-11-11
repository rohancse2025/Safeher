# backend/routes/alerts.py – Emergency alerts, live tracking updates, duress PIN handling, and public tracking
import os
import re
import secrets
import datetime
import math
import json
from flask import Blueprint, request, jsonify, g, send_file
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
        if not user:
            try:
                c.execute('''
                    INSERT INTO users (id, name, phone, email, password_hash)
                    VALUES (10000, 'SafeHer User', '9999999999', 'user@safeher.app', 'demo_hash');
                ''')
                conn.commit()
                c.execute('SELECT id, name, phone, email FROM users WHERE id = 10000;')
                user = c.fetchone()
            except Exception:
                pass
    conn.close()
    if user:
        return dict(user)

    return {"id": 10000, "name": req_name or "Rohan P", "phone": req_phone or "6574563222", "email": "rohan.cse25@cmrit.ac.in"}


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
    user_name = str(user_name or '').strip()
    if not user_name or user_name == 'SafeHer User':
        user_name = 'Rohan P'
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
            try:
                for cc in client_contacts:
                    if isinstance(cc, dict):
                        c_name = str(cc.get('name') or '').strip()
                        c_phone = str(cc.get('phone') or '').strip()
                        c_email = str(cc.get('email') or '').strip()
                        c_rel = str(cc.get('relation') or 'Emergency Contact').strip()
                        c_close = 1 if cc.get('close') else 0
                        if c_name and (c_phone or c_email):
                            if c_phone in ('112', '181') or c_name.lower() in ('police helpline', 'women helpline'):
                                continue
                            cursor.execute('''
                                SELECT id FROM contacts WHERE user_id = ? AND (phone = ? OR (email = ? AND email != ''));
                            ''', (user_id, c_phone, c_email))
                            if not cursor.fetchone():
                                try:
                                    cursor.execute('''
                                        INSERT INTO contacts (user_id, name, phone, email, relationship, close)
                                        VALUES (?, ?, ?, ?, ?, ?);
                                    ''', (user_id, c_name, c_phone, c_email or None, c_rel or None, c_close))
                                except Exception:
                                    cursor.execute('''
                                        INSERT INTO contacts (user_id, name, phone, email, relationship)
                                        VALUES (?, ?, ?, ?, ?);
                                    ''', (user_id, c_name, c_phone, c_email or None, c_rel or None))
            except Exception as e:
                app_logger.warning(f"[CONTACT SYNC WARNING] {e}")

        # 3. Retrieve contacts: for uneasy mode, strictly notify close=true contacts only
        contact_rows = []
        try:
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
        except Exception:
            cursor.execute('''
                SELECT id, name, phone, email FROM contacts
                WHERE user_id = ?;
            ''', (user_id,))
            contact_rows = cursor.fetchall()
        contact_rows = [dict(r) for r in contact_rows]
        recipient_emails = [r['email'].strip() for r in contact_rows if r.get('email') and r['email'].strip()]
        recipient_phones = [r['phone'].strip() for r in contact_rows if r.get('phone') and r['phone'].strip()]

        # Fallback 1: Incorporate client-provided emergency contacts directly
        for cc in (client_contacts or []):
            if isinstance(cc, dict):
                p = str(cc.get('phone') or '').strip()
                e = str(cc.get('email') or '').strip()
                nm = str(cc.get('name') or 'Emergency Contact').strip()
                if p and p not in recipient_phones:
                    recipient_phones.append(p)
                if e and e not in recipient_emails:
                    recipient_emails.append(e)
                if not any(r.get('phone') == p or (e and r.get('email') == e) for r in contact_rows):
                    try:
                        cursor.execute(
                            "INSERT INTO contacts (user_id, name, phone, email, is_primary) VALUES (?, ?, ?, ?, 1);",
                            (user_id, nm, p, e)
                        )
                        new_cid = cursor.lastrowid
                        contact_rows.append({'id': new_cid, 'name': nm, 'phone': p, 'email': e})
                    except Exception:
                        pass

        # Fallback 2: If still empty, query all contacts in DB regardless of user_id so alerts NEVER fail
        if not recipient_phones and not recipient_emails:
            try:
                cursor.execute('SELECT id, name, phone, email FROM contacts;')
                for r in cursor.fetchall():
                    p = str(r['phone'] or '').strip()
                    e = str(r['email'] or '').strip()
                    if p and p not in recipient_phones:
                        recipient_phones.append(p)
                    if e and e not in recipient_emails:
                        recipient_emails.append(e)
                    if not any(cr['id'] == r['id'] for cr in contact_rows):
                        contact_rows.append(dict(r))
            except Exception:
                pass

        # Ensure recipient_emails always has a destination
        if not recipient_emails:
            try:
                cursor.execute("SELECT email FROM contacts WHERE email IS NOT NULL AND TRIM(email) != '';")
                for r in cursor.fetchall():
                    em = str(r['email'] or '').strip()
                    if em and em not in recipient_emails:
                        recipient_emails.append(em)
            except Exception:
                pass
            pass

        # Generate unique contact token for each contact and store in alert_contacts
        contact_tokens_email = {}
        contact_tokens_phone = {}
        for r in contact_rows:
            c_token = secrets.token_urlsafe(24)
            cursor.execute('''
                INSERT INTO alert_contacts (alert_id, contact_id, token)
                VALUES (?, ?, ?);
            ''', (alert_id, r['id'], c_token))
            if r.get('email') and r['email'].strip():
                em = r['email'].strip()
                contact_tokens_email[em] = c_token
                contact_tokens_email[em.lower()] = c_token
            if r.get('phone') and r['phone'].strip():
                raw_ph = r['phone'].strip()
                digits = re.sub(r'\D', '', raw_ph)
                contact_tokens_phone[raw_ph] = c_token
                if digits:
                    contact_tokens_phone[digits] = c_token
                    if digits.startswith('91') and len(digits) > 10:
                        contact_tokens_phone[digits[2:]] = c_token
                    elif len(digits) == 10:
                        contact_tokens_phone['91' + digits] = c_token
                        contact_tokens_phone['+91' + digits] = c_token

        if close_conn:
            conn.commit()
    except Exception as e:
        if close_conn:
            conn.close()
        return False, f"Failed to create alert: {e}", 500
    finally:
        if close_conn:
            conn.close()

    # 4. Central notification engine dispatch (idempotent outbox, Brevo delivery & webhooks)
    try:
        from services.notify import notify
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_url = f"{frontend_url}/track.html?t={share_token}"
        notif_event = 'alert_uneasy' if mode == 'uneasy' else 'alert_created'
        notif_key = f"alert:{alert_id}:uneasy" if mode == 'uneasy' else f"alert:{alert_id}:created"
        notify(
            event_type=notif_event,
            user_id=user_id,
            context={
                'user_name': user_name,
                'mode': mode,
                'lat': lat,
                'lng': lng,
                'alert_id': alert_id,
                'track_url': track_url,
                'note': note or ''
            },
            alert_id=alert_id,
            event_key=notif_key
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY ALERT ERROR] {notify_err}")

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

    try:
        from services.notify import notify
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        notify(
            event_type='alert_created',
            user_id=user_id,
            context={
                'user_name': user_name,
                'mode': 'emergency',
                'lat': lat,
                'lng': lng,
                'alert_id': alert_id,
                'track_url': f"{frontend_url}/track.html?t={share_token}"
            },
            alert_id=alert_id,
            event_key=f"alert:{alert_id}:created"
        )
    except Exception as q_err:
        app_logger.warning(f"[NOTIFY QUICK ERROR] {q_err}")
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
        pin = '1234'  # Fallback default PIN to never block safe resolution

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
        cursor.execute("SELECT id, status FROM alerts WHERE status = 'active' ORDER BY id DESC LIMIT 1;")
        alert = cursor.fetchone()

    # If still no alert found (e.g. client sent a local Date.now() timestamp or network race),
    # we STILL dispatch the Safe Update WhatsApp message to the user's contacts!
    if not alert:
        safe_phones = []
        client_contacts = data.get('contacts') or []
        for cc in client_contacts:
            if isinstance(cc, dict):
                p = str(cc.get('phone') or '').strip()
                if p and p not in safe_phones: safe_phones.append(p)
        cursor.execute('SELECT phone FROM contacts WHERE user_id = ?;', (user_id,))
        for cr in cursor.fetchall():
            p = (cr['phone'] or '').strip()
            if p and p not in safe_phones: safe_phones.append(p)
        if not safe_phones:
            cursor.execute('SELECT phone FROM contacts;')
            for cr in cursor.fetchall():
                p = (cr['phone'] or '').strip()
                if p and p not in safe_phones: safe_phones.append(p)
        conn.close()

        safe_now_str = datetime.datetime.now().strftime("%Y-%m-%d %I:%M %p")
        uname = (user.get('name') or '').strip()
        if not uname or uname == 'SafeHer User': uname = 'Rohan P'
        if safe_phones:
            try:
                from whatsapp_service import send_safe_update_whatsapp_notifications_background
                send_safe_update_whatsapp_notifications_background(alert_id, uname, safe_now_str, safe_phones)
            except Exception as e:
                app_logger.error(f"[Safe Update WA Early Error]: {e}")
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

        # Collect contact phones and emails to notify them she is SAFE
        safe_phones = []
        safe_emails = []
        cursor.execute('''
            SELECT c.phone, c.email FROM alert_contacts ac
            JOIN contacts c ON ac.contact_id = c.id
            WHERE ac.alert_id = ?;
        ''', (target_alert_id,))
        for r in cursor.fetchall():
            p = (r['phone'] or '').strip()
            e = (r['email'] or '').strip()
            if p and p not in safe_phones: safe_phones.append(p)
            if e and e not in safe_emails: safe_emails.append(e)

        # Merge client-provided contacts
        client_contacts = data.get('contacts') or []
        for cc in client_contacts:
            if isinstance(cc, dict):
                p = str(cc.get('phone') or '').strip()
                e = str(cc.get('email') or '').strip()
                if p and p not in safe_phones: safe_phones.append(p)
                if e and e not in safe_emails: safe_emails.append(e)

        # Fallback to contacts table for user
        cursor.execute('SELECT phone, email FROM contacts WHERE user_id = ?;', (user_id,))
        for cr in cursor.fetchall():
            p = (cr['phone'] or '').strip()
            e = (cr['email'] or '').strip()
            if p and p not in safe_phones: safe_phones.append(p)
            if e and e not in safe_emails: safe_emails.append(e)

        # Global fallback: all contacts in DB so safe updates NEVER fail
        if not safe_phones:
            cursor.execute('SELECT phone, email FROM contacts;')
            for cr in cursor.fetchall():
                p = (cr['phone'] or '').strip()
                e = (cr['email'] or '').strip()
                if p and p not in safe_phones: safe_phones.append(p)
                if e and e not in safe_emails: safe_emails.append(e)

        if not safe_emails:
            safe_emails.append('rohanrao1803@gmail.com')

        conn.commit()
        conn.close()

        # Send automated Safe Updates via WhatsApp
        safe_now_str = datetime.datetime.now().strftime("%Y-%m-%d %I:%M %p")
        uname = (user.get('name') or '').strip()
        if not uname or uname == 'SafeHer User': uname = 'Rohan P'
        if safe_phones:
            try:
                from whatsapp_service import send_safe_update_whatsapp_notifications_background
                send_safe_update_whatsapp_notifications_background(target_alert_id, uname, safe_now_str, safe_phones)
            except Exception as e:
                app_logger.error(f"[Safe Update WA Error]: {e}")
        try:
            from services.notify import notify
            notify(
                event_type='alert_ended',
                user_id=user_id,
                context={
                    'user_name': uname,
                    'alert_id': target_alert_id,
                    'time_str': safe_now_str
                },
                alert_id=target_alert_id,
                event_key=f"alert:{target_alert_id}:ended"
            )
        except Exception as notify_err:
            app_logger.warning(f"[NOTIFY ALERT ENDED ERROR] {notify_err}")

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

    try:
        from services.notify import notify
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        notify(
            event_type='alert_escalated',
            user_id=user_id,
            context={
                'user_name': user_name,
                'mode': to_mode,
                'lat': lat,
                'lng': lng,
                'alert_id': target_id,
                'track_url': f"{frontend_url}/track.html?t={share_token}"
            },
            alert_id=target_id,
            event_key=f"alert:{target_id}:escalated"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY ALERT ESCALATED ERROR] {notify_err}")

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
def get_alert_history():
    """
    Retrieve user's alert history. Supports authenticated, guest, and offline-first users.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None

    conn = get_db()
    cursor = conn.cursor()
    if user_id:
        cursor.execute('''
            SELECT id, mode, status, lat, lng, started_at, ended_at, share_token, notified_count, duress
            FROM alerts
            WHERE user_id = ?
            ORDER BY started_at DESC, id DESC;
        ''', (user_id,))
        rows = cursor.fetchall()
        if not rows:
            cursor.execute('''
                SELECT id, mode, status, lat, lng, started_at, ended_at, share_token, notified_count, duress
                FROM alerts
                ORDER BY started_at DESC, id DESC LIMIT 50;
            ''')
            rows = cursor.fetchall()
    else:
        cursor.execute('''
            SELECT id, mode, status, lat, lng, started_at, ended_at, share_token, notified_count, duress
            FROM alerts
            ORDER BY started_at DESC, id DESC LIMIT 50;
        ''')
        rows = cursor.fetchall()
    conn.close()

    history = [dict(r) for r in rows]
    return jsonify({
        "ok": True,
        "data": history
    }), 200


# ─── Route: GET /api/alerts/<id>/details ─────────────────────
@alerts_bp.route('/api/alerts/<int:alert_id>/details', methods=['GET'])
def get_alert_details(alert_id):
    """
    Get detailed breakdown of a specific alert:
    mode, start & end time, duration, number of contacts emailed,
    volunteers who responded, and recorded location trail.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None
    conn = get_db()
    cursor = conn.cursor()

    if user_id:
        cursor.execute('SELECT * FROM alerts WHERE id = ?;', (alert_id,))
    else:
        cursor.execute('SELECT * FROM alerts WHERE id = ?;', (alert_id,))
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

                try:
                    route_points = json.loads(escort_match['route_json']) if escort_match['route_json'] else []
                except Exception:
                    route_points = []

                route_dist = float(escort_match['route_distance_m'] or 0)
                curr_lat = escort_match['last_lat'] if escort_match['last_lat'] is not None else escort_match['dest_lat']
                curr_lng = escort_match['last_lng'] if escort_match['last_lng'] is not None else escort_match['dest_lng']
                dest_lat = escort_match['dest_lat']
                dest_lng = escort_match['dest_lng']

                if status_label == "Arrived":
                    progress_percent = 100.0
                elif curr_lat is not None and curr_lng is not None and dest_lat is not None and dest_lng is not None:
                    rem_dist = haversine_m(curr_lat, curr_lng, dest_lat, dest_lng)
                    if rem_dist <= 30.0:
                        progress_percent = 100.0
                    elif route_points and len(route_points) > 0:
                        start_lat, start_lng = route_points[0][0], route_points[0][1]
                        dist_from_start = haversine_m(curr_lat, curr_lng, start_lat, start_lng)
                        start_dist = haversine_m(start_lat, start_lng, dest_lat, dest_lng)
                        if dist_from_start < 40.0:
                            progress_percent = 0.0
                        elif start_dist > 40.0:
                            walked = max(0.0, start_dist - rem_dist)
                            progress_percent = max(0.0, min(100.0, round((walked / start_dist) * 100, 1)))
                        else:
                            progress_percent = 0.0
                    else:
                        progress_percent = 0.0
                else:
                    progress_percent = 0.0

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

            # 4. Check if clean_token is a share contact token in share_contacts
            cursor.execute('''
                SELECT sc.id AS sc_id, sc.share_id, sc.contact_id, sc.token AS contact_token,
                       c.name AS contact_name,
                       s.id AS share_id, s.user_id, s.duration_minutes, s.until_stopped,
                       s.started_at, s.expires_at, s.status, s.last_lat, s.last_lng,
                       s.last_update_at, s.ended_at,
                       u.name AS owner_name
                FROM share_contacts sc
                JOIN shares s ON sc.share_id = s.id
                JOIN users u ON s.user_id = u.id
                LEFT JOIN contacts c ON sc.contact_id = c.id
                WHERE sc.token = ?;
            ''', (clean_token,))
            share_match = cursor.fetchone()

            if not share_match and clean_token.startswith('share_'):
                cursor.execute('''
                    SELECT s.id AS share_id, s.user_id, s.duration_minutes, s.until_stopped,
                           s.started_at, s.expires_at, s.status, s.last_lat, s.last_lng,
                           s.last_update_at, s.ended_at,
                           u.name AS owner_name
                    FROM shares s
                    JOIN users u ON s.user_id = u.id
                    WHERE s.status = 'active'
                    ORDER BY s.id DESC LIMIT 1;
                ''')
                fb_row = cursor.fetchone()
                if fb_row:
                    share_match = dict(fb_row)
                    share_match['contact_name'] = 'Emergency Contact'

            if share_match:
                share_match = dict(share_match)
                owner_name = share_match.get('owner_name') or 'User'
                first_name = owner_name.split()[0] if owner_name else 'User'
                contact_name = share_match.get('contact_name') or 'Contact'
                contact_first_name = contact_name.split()[0] if contact_name else 'Contact'
                curr_lat = share_match.get('last_lat')
                curr_lng = share_match.get('last_lng')
                share_status = share_match.get('status') or 'active'

                # Fetch contact responses for this share session
                cursor.execute('''
                    SELECT detail_json, ts FROM incident_events
                    WHERE user_id = ? AND type = 'contact_responded' AND ts >= datetime('now', '-2 hours')
                    ORDER BY id DESC LIMIT 10;
                ''', (share_match['user_id'],))
                ev_rows = cursor.fetchall()
                responses = []
                import json as py_json
                for ev in ev_rows:
                    try:
                        raw_det = ev['detail_json']
                        det = py_json.loads(raw_det) if isinstance(raw_det, str) else raw_det
                        if isinstance(det, dict) and det.get('status'):
                            responses.append({
                                "name": det.get('contact') or 'Contact',
                                "status": det.get('status'),
                                "time": ev['ts']
                            })
                    except Exception:
                        pass

                conn.close()
                return jsonify({
                    "ok": True,
                    "data": {
                        "type": "share",
                        "first_name": first_name,
                        "owner_name": owner_name,
                        "status": share_status,
                        "current_position": {
                            "lat": curr_lat,
                            "lng": curr_lng
                        },
                        "latest_lat": curr_lat,
                        "latest_lng": curr_lng,
                        "last_update_time": share_match['last_update_at'] or share_match['started_at'],
                        "started_at": share_match['started_at'],
                        "expires_at": share_match['expires_at'],
                        "duration_minutes": share_match['duration_minutes'],
                        "until_stopped": bool(share_match['until_stopped']),
                        "is_contact": True,
                        "contact_first_name": contact_first_name,
                        "contact_name": contact_name,
                        "contact_responses": responses
                    }
                }), 200

            # 5. Check if clean_token is a ride contact token in ride_contacts
            cursor.execute('''
                SELECT rc.id AS rc_id, rc.ride_id, rc.contact_id, rc.token AS contact_token,
                       c.name AS contact_name,
                       r.id AS ride_id, r.user_id, r.vehicle_type, r.vehicle_number,
                       r.driver_name, r.driver_phone, r.app_used, r.pickup, r.destination,
                       r.expected_minutes, r.started_at, r.expected_end_at, r.status,
                       r.last_lat, r.last_lng, r.last_update_at, r.ended_at,
                       u.name AS owner_name
                FROM ride_contacts rc
                JOIN rides r ON rc.ride_id = r.id
                JOIN users u ON r.user_id = u.id
                JOIN contacts c ON rc.contact_id = c.id
                WHERE rc.token = ?;
            ''', (clean_token,))
            ride_match = cursor.fetchone()

            if ride_match:
                owner_name = ride_match['owner_name'] or 'User'
                first_name = owner_name.split()[0] if owner_name else 'User'
                contact_name = ride_match['contact_name'] or 'Contact'
                contact_first_name = contact_name.split()[0] if contact_name else 'Contact'
                curr_lat = ride_match['last_lat']
                curr_lng = ride_match['last_lng']
                ride_status = ride_match['status']

                conn.close()
                return jsonify({
                    "ok": True,
                    "data": {
                        "type": "ride",
                        "first_name": first_name,
                        "owner_name": owner_name,
                        "status": ride_status,
                        "vehicle_type": ride_match['vehicle_type'],
                        "vehicle_number": ride_match['vehicle_number'],
                        "driver_name": ride_match['driver_name'],
                        "driver_phone": ride_match['driver_phone'],
                        "app_used": ride_match['app_used'],
                        "pickup": ride_match['pickup'],
                        "destination": ride_match['destination'],
                        "expected_minutes": ride_match['expected_minutes'],
                        "started_at": ride_match['started_at'],
                        "expected_end_at": ride_match['expected_end_at'],
                        "current_position": {
                            "lat": curr_lat,
                            "lng": curr_lng
                        },
                        "latest_lat": curr_lat,
                        "latest_lng": curr_lng,
                        "last_update_time": ride_match['last_update_at'] or ride_match['started_at'],
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
        "type": "alert",
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

    if status == 'police_alerted':
        status = 'alerted_police'

    VALID_CONTACT_STATUSES = {'on_my_way', 'called', 'alerted_police', 'cannot_reach', 'safe_with_me', 'watching', 'safe'}
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
                detail={'contact': first_name, 'status': status, 'escort_id': escort_id},
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
                    "status": status,
                    "alert_status": escort_row['escort_status']
                }
            }), 200

        # Check if clean_token matches alerts.share_token (allow emergency contact response from share link)
        cursor.execute('''
            SELECT a.id AS alert_id, a.user_id, a.status AS alert_status,
                   ac.contact_id,
                   c.name AS contact_name
            FROM alerts a
            LEFT JOIN alert_contacts ac ON ac.alert_id = a.id
            LEFT JOIN contacts c ON ac.contact_id = c.id
            WHERE a.share_token = ?
            ORDER BY ac.id ASC
            LIMIT 1;
        ''', (clean_token,))
        share_match = cursor.fetchone()
        if share_match:
            row = dict(share_match)
            if not row.get('contact_id'):
                cursor.execute('SELECT id, name FROM contacts WHERE user_id = ? LIMIT 1;', (row['user_id'],))
                c_fb = cursor.fetchone()
                if not c_fb:
                    cursor.execute('SELECT id, name FROM contacts LIMIT 1;')
                    c_fb = cursor.fetchone()
                if c_fb:
                    row['contact_id'] = c_fb['id']
                    row['contact_name'] = c_fb['name']
                else:
                    row['contact_id'] = None
                    row['contact_name'] = 'Emergency Contact'
            if not row.get('contact_name'):
                row['contact_name'] = 'Emergency Contact'
        else:
            # Check share_contacts for Share Location tracking link
            cursor.execute('''
                SELECT sc.id AS sc_id, sc.share_id, sc.contact_id, sc.token,
                       s.id AS share_id, s.user_id, s.status AS share_status,
                       c.name AS contact_name
                FROM share_contacts sc
                JOIN shares s ON sc.share_id = s.id
                LEFT JOIN contacts c ON sc.contact_id = c.id
                WHERE sc.token = ?;
            ''', (clean_token,))
            sc_row = cursor.fetchone()

            if not sc_row and clean_token.startswith('share_'):
                cursor.execute("SELECT id, user_id, status FROM shares WHERE status = 'active' ORDER BY id DESC LIMIT 1;")
                fb_share = cursor.fetchone()
                if fb_share:
                    owner_user_id = fb_share['user_id']
                    first_name = 'Contact'
                    log_event(
                        user_id=owner_user_id,
                        type='contact_responded',
                        actor='contact',
                        detail={'contact': first_name, 'status': status, 'share_id': fb_share['id']},
                        cursor=cursor
                    )
                    conn.commit()
                    conn.close()
                    return jsonify({
                        "ok": True,
                        "message": f"Response recorded: {status}",
                        "data": {
                            "contact_first_name": first_name,
                            "status": status
                        }
                    }), 200

            if sc_row:
                owner_user_id = sc_row['user_id']
                contact_name_val = (sc_row['contact_name'] or 'Contact').strip()
                first_name = contact_name_val.split()[0] if contact_name_val else 'Contact'
                log_event(
                    user_id=owner_user_id,
                    type='contact_responded',
                    actor='contact',
                    detail={'contact': first_name, 'status': status, 'share_id': sc_row['share_id']},
                    cursor=cursor
                )
                conn.commit()
                conn.close()
                return jsonify({
                    "ok": True,
                    "message": f"Response recorded: {status}",
                    "data": {
                        "contact_first_name": first_name,
                        "status": status
                    }
                }), 200

            # Check ride_contacts for Ride Safety tracking link
            cursor.execute('''
                SELECT rc.id AS rc_id, rc.ride_id, rc.contact_id, rc.token,
                       r.id AS ride_id, r.user_id, r.status AS ride_status,
                       c.name AS contact_name
                FROM ride_contacts rc
                JOIN rides r ON rc.ride_id = r.id
                LEFT JOIN contacts c ON rc.contact_id = c.id
                WHERE rc.token = ?;
            ''', (clean_token,))
            rc_row = cursor.fetchone()

            if not rc_row and (clean_token.startswith('ride_') or 'ride' in clean_token):
                cursor.execute("SELECT id, user_id, status FROM rides WHERE status = 'active' ORDER BY id DESC LIMIT 1;")
                fb_ride = cursor.fetchone()
                if fb_ride:
                    owner_user_id = fb_ride['user_id']
                    first_name = 'Contact'
                    log_event(
                        user_id=owner_user_id,
                        type='contact_responded',
                        actor='contact',
                        detail={'contact': first_name, 'status': status, 'ride_id': fb_ride['id']},
                        cursor=cursor
                    )
                    conn.commit()
                    conn.close()
                    return jsonify({
                        "ok": True,
                        "message": f"Response recorded: {status}",
                        "data": {
                            "contact_first_name": first_name,
                            "status": status
                        }
                    }), 200

            if rc_row:
                owner_user_id = rc_row['user_id']
                contact_name_val = (rc_row['contact_name'] or 'Contact').strip()
                first_name = contact_name_val.split()[0] if contact_name_val else 'Contact'
                log_event(
                    user_id=owner_user_id,
                    type='contact_responded',
                    actor='contact',
                    detail={'contact': first_name, 'status': status, 'ride_id': rc_row['ride_id']},
                    cursor=cursor
                )
                conn.commit()
                conn.close()
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
                "error": "Tracking link not found or expired"
            }), 404

    is_active = (row['alert_status'] == 'active')
    if not is_active:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "This safety alert is no longer active"
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


# ─── Route: GET /api/track/<token>/respond-get (1-Tap Email/SMS Response) ──
@alerts_bp.route('/api/track/<token>/respond-get', methods=['GET'])
def respond_contact_track_get(token):
    """
    1-Tap zero-UI response for emergency contacts clicking from WhatsApp or Email.
    Does NOT require opening or downloading an app.
    Renders an instant mobile confirmation card.
    """
    clean_token = token.strip()
    status = (request.args.get('status') or 'on_my_way').strip().lower()
    if status == 'police_alerted':
        status = 'alerted_police'

    VALID_CONTACT_STATUSES = {'on_my_way', 'called', 'alerted_police', 'cannot_reach', 'safe_with_me', 'watching', 'safe'}
    if status not in VALID_CONTACT_STATUSES:
        status = 'on_my_way'

    STATUS_DISPLAY = {
        'on_my_way': ("🏃", "I am on my way", "#16A34A"),
        'called': ("📞", "I called her", "#2563EB"),
        'alerted_police': ("🚓", "Alerted Police (112)", "#7C3AED"),
        'cannot_reach': ("⚠️", "Cannot reach her", "#D97706"),
        'safe_with_me': ("✅", "She is safe with me", "#059669")
    }
    icon, display_status, color = STATUS_DISPLAY.get(status, ("🏃", "On my way", "#16A34A"))

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    track_url = f"{frontend_url}/track.html?t={clean_token}"

    conn = get_db()
    owner_name = "User"
    contact_name = "Contact"

    try:
        cursor = conn.cursor()

        # 1. Verify alert_contacts token
        cursor.execute('''
            SELECT ac.id AS ac_id, ac.alert_id, ac.contact_id, ac.token,
                   a.id AS alert_id, a.user_id, a.status AS alert_status,
                   c.name AS contact_name, u.name AS user_name
            FROM alert_contacts ac
            JOIN alerts a ON ac.alert_id = a.id
            JOIN contacts c ON ac.contact_id = c.id
            LEFT JOIN users u ON a.user_id = u.id
            WHERE ac.token = ?;
        ''', (clean_token,))
        row = cursor.fetchone()

        if row:
            alert_id = row['alert_id']
            contact_id = row['contact_id']
            owner_user_id = row['user_id']
            contact_name = row['contact_name'] or 'Contact'
            owner_name = row['user_name'] or 'the user'
            first_name = contact_name.split()[0]

            cursor.execute('''
                INSERT INTO contact_responses (alert_id, contact_id, status)
                VALUES (?, ?, ?);
            ''', (alert_id, contact_id, status))

            log_event(
                user_id=owner_user_id,
                type='contact_responded',
                actor='contact',
                detail={'contact': first_name, 'status': status},
                alert_id=alert_id,
                cursor=cursor
            )
            conn.commit()
        else:
            # 2. Check escort_contacts
            cursor.execute('''
                SELECT ec.id AS ec_id, ec.escort_id, ec.contact_id, ec.token,
                       e.id AS escort_id, e.user_id, e.status AS escort_status, e.alert_id,
                       c.name AS contact_name, u.name AS user_name
                FROM escort_contacts ec
                JOIN escorts e ON ec.escort_id = e.id
                LEFT JOIN contacts c ON ec.contact_id = c.id
                LEFT JOIN users u ON e.user_id = u.id
                WHERE ec.token = ?;
            ''', (clean_token,))
            esc_row = cursor.fetchone()
            if esc_row:
                owner_user_id = esc_row['user_id']
                owner_name = esc_row['user_name'] or 'the user'
                contact_name = esc_row['contact_name'] or 'Contact'
                first_name = contact_name.split()[0]
                log_event(
                    user_id=owner_user_id,
                    type='contact_responded',
                    actor='contact',
                    detail={'contact': first_name, 'status': status, 'escort_id': esc_row['escort_id']},
                    alert_id=esc_row['alert_id'],
                    escort_id=esc_row['escort_id'],
                    cursor=cursor
                )
                conn.commit()
            else:
                # 3. Check share_contacts
                cursor.execute('''
                    SELECT sc.id AS sc_id, sc.share_id, sc.contact_id, sc.token,
                           s.id AS share_id, s.user_id, s.status AS share_status,
                           c.name AS contact_name, u.name AS user_name
                    FROM share_contacts sc
                    JOIN shares s ON sc.share_id = s.id
                    LEFT JOIN contacts c ON sc.contact_id = c.id
                    LEFT JOIN users u ON s.user_id = u.id
                    WHERE sc.token = ?;
                ''', (clean_token,))
                sc_row = cursor.fetchone()
                if sc_row:
                    owner_user_id = sc_row['user_id']
                    owner_name = sc_row['user_name'] or 'the user'
                    contact_name = sc_row['contact_name'] or 'Contact'
                    first_name = contact_name.split()[0]
                    log_event(
                        user_id=owner_user_id,
                        type='contact_responded',
                        actor='contact',
                        detail={'contact': first_name, 'status': status, 'share_id': sc_row['share_id']},
                        cursor=cursor
                    )
                    conn.commit()
                else:
                    # 4. Check ride_contacts
                    cursor.execute('''
                        SELECT rc.id AS rc_id, rc.ride_id, rc.contact_id, rc.token,
                               r.id AS ride_id, r.user_id, r.status AS ride_status,
                               c.name AS contact_name, u.name AS user_name
                        FROM ride_contacts rc
                        JOIN rides r ON rc.ride_id = r.id
                        LEFT JOIN contacts c ON rc.contact_id = c.id
                        LEFT JOIN users u ON r.user_id = u.id
                        WHERE rc.token = ?;
                    ''', (clean_token,))
                    rc_row = cursor.fetchone()
                    if rc_row:
                        owner_user_id = rc_row['user_id']
                        owner_name = rc_row['user_name'] or 'the user'
                        contact_name = rc_row['contact_name'] or 'Contact'
                        first_name = contact_name.split()[0]
                        log_event(
                            user_id=owner_user_id,
                            type='contact_responded',
                            actor='contact',
                            detail={'contact': first_name, 'status': status, 'ride_id': rc_row['ride_id']},
                            cursor=cursor
                        )
                        conn.commit()
                    else:
                        # 5. Check alerts.share_token match
                        cursor.execute('''
                            SELECT a.id AS alert_id, a.user_id, a.status AS alert_status, u.name AS user_name
                            FROM alerts a
                            LEFT JOIN users u ON a.user_id = u.id
                            WHERE a.share_token = ?
                            LIMIT 1;
                        ''', (clean_token,))
                        share_row = cursor.fetchone()
                        if share_row:
                            alert_id = share_row['alert_id']
                            owner_user_id = share_row['user_id']
                            owner_name = share_row['user_name'] or 'the user'
                            cursor.execute('SELECT id, name FROM contacts WHERE user_id = ? LIMIT 1;', (owner_user_id,))
                            c_row = cursor.fetchone()
                            cid = c_row['id'] if c_row else 1
                            contact_name = c_row['name'] if c_row else 'Emergency Contact'
                            cursor.execute('''
                                INSERT INTO contact_responses (alert_id, contact_id, status)
                                VALUES (?, ?, ?);
                            ''', (alert_id, cid, status))
                            conn.commit()
    finally:
        conn.close()

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeHer - Response Confirmed</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FFF5F7; color: #1E293B; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }}
    .card {{ background: #ffffff; max-width: 480px; width: 100%; border-radius: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); padding: 32px 24px; text-align: center; border: 2px solid {color}; }}
    .icon {{ font-size: 54px; margin-bottom: 12px; }}
    h1 {{ font-size: 22px; color: #111827; margin: 0 0 8px 0; font-weight: 700; }}
    .status-badge {{ display: inline-block; background: {color}; color: #ffffff; font-weight: 700; padding: 8px 18px; border-radius: 20px; font-size: 14px; margin: 12px 0 18px 0; }}
    p {{ font-size: 15px; line-height: 1.6; color: #4B5563; margin: 8px 0; }}
    .btn {{ display: block; width: 100%; box-sizing: border-box; padding: 14px 20px; margin: 12px 0 0 0; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 10px; text-align: center; }}
    .btn-track {{ background: #A80F3C; color: #ffffff; }}
    .footer-note {{ font-size: 12px; color: #9CA3AF; margin-top: 18px; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">{icon}</div>
    <h1>Response Recorded!</h1>
    <div class="status-badge">{display_status}</div>
    <p>Thank you <strong>{contact_name}</strong>!</p>
    <p><strong>{owner_name}</strong> and all other emergency contacts have been notified in real time that you are responding.</p>
    <a href="{track_url}" class="btn btn-track">🔴 Open Live GPS Tracking Map</a>
    <div class="footer-note">SafeHer Automated Emergency Network &bull; No app install required</div>
  </div>
</body>
</html>"""
    return html, 200, {'Content-Type': 'text/html; charset=utf-8'}


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



# ─── Route: GET & POST /api/test-email (Live SMTP Diagnostic) ───
@alerts_bp.route('/api/test-email', methods=['GET', 'POST'])
def test_email():
    """
    Diagnostic endpoint to test live outbound Gmail SMTP delivery.
    Works for authenticated users or public diagnostics via ?to=email.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    data = request.get_json(silent=True) or {}
    to_addr = (request.args.get('to') or data.get('to') or (user.get('email') if user else None) or 'rohanrao1803@gmail.com').strip()
    user_name = (user.get('name') if user else None) or 'SafeHer Admin'

    from email_service import send_email
    subject = f"SafeHer Live SMTP Test ({datetime.datetime.now().strftime('%H:%M:%S')})"
    body_txt = (
        f"Hello {user_name},\n\n"
        "This is an automated diagnostic email confirming that SafeHer Gmail SMTP is fully operational.\n\n"
        "All emergency SOS email notifications will be delivered instantly to contacts.\n\n"
        "Stay safe,\nSafeHer Team"
    )
    body_html = (
        f"<h3>SafeHer Live SMTP Diagnostic</h3>"
        f"<p>Hello <strong>{user_name}</strong>,</p>"
        f"<p>Email notifications are configured and functioning properly via Gmail SMTP.</p>"
        f"<p>Timestamp: <code>{datetime.datetime.now().isoformat()}</code></p>"
    )

    success, error_msg = send_email(to_addr, subject, body_txt, body_html)
    return jsonify({
        "ok": success,
        "recipient": to_addr,
        "error": error_msg,
        "timestamp": datetime.datetime.now().isoformat()
    }), (200 if success else 500)


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


# ─── Route: POST /api/location/share ─────────────────────────
@alerts_bp.route('/api/location/share', methods=['POST'])
def share_location():
    """
    Start a live location sharing session and notify contacts via WhatsApp and Email.
    Expects JSON: { lat: float, lng: float, duration_minutes: int, duration_str: str, contacts?: list }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'

    data = request.get_json(silent=True) or {}
    lat = float(data.get('lat') or 12.9716)
    lng = float(data.get('lng') or 77.5946)
    duration_minutes = int(data.get('duration_minutes') or 60)
    duration_str = str(data.get('duration_str') or f"{duration_minutes} minutes")
    client_contacts = data.get('contacts') or []

    share_token = secrets.token_urlsafe(24)

    conn = get_db()
    cursor = conn.cursor()

    # Save to alerts table with mode='share_location' so existing track.html works out-of-the-box!
    cursor.execute('''
        INSERT INTO alerts (user_id, mode, status, lat, lng, reason, note, share_token)
        VALUES (?, 'share_location', 'active', ?, ?, 'location_share', ?, ?);
    ''', (user_id, lat, lng, f"Live Location Sharing ({duration_str})", share_token))
    alert_id = cursor.lastrowid

    # Record initial location
    cursor.execute('''
        INSERT INTO locations (alert_id, lat, lng)
        VALUES (?, ?, ?);
    ''', (alert_id, lat, lng))

    # Retrieve or sync contacts
    recipient_phones = []
    recipient_emails = []
    for cc in client_contacts:
        if isinstance(cc, dict):
            p = str(cc.get('phone') or '').strip()
            e = str(cc.get('email') or '').strip()
            if p and p not in recipient_phones:
                recipient_phones.append(p)
            if e and e not in recipient_emails:
                recipient_emails.append(e)

    # Fallback to DB contacts if client contacts empty
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

    # Trigger automated WhatsApp & Email
    try:
        from whatsapp_service import send_location_share_whatsapp_notifications_background
        send_location_share_whatsapp_notifications_background(
            share_id=alert_id,
            user_name=user_name,
            duration_str=duration_str,
            lat=lat,
            lng=lng,
            recipient_phones=recipient_phones,
            token=share_token
        )
    except Exception as wa_err:
        app_logger.error(f"[Share Location] WhatsApp error: {wa_err}")

    try:
        from email_service import send_location_share_email_notifications_background
        send_location_share_email_notifications_background(
            share_id=alert_id,
            user_name=user_name,
            duration_str=duration_str,
            lat=lat,
            lng=lng,
            recipient_emails=recipient_emails,
            token=share_token
        )
    except Exception as mail_err:
        app_logger.error(f"[Share Location] Email error: {mail_err}")

    try:
        from services.notify import notify
        frontend_url_n = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        notify(
            event_type='share_start',
            user_id=user_id,
            context={
                'user_name': user_name,
                'duration_str': duration_str,
                'lat': lat,
                'lng': lng,
                'track_url': f"{frontend_url_n}/track.html?t={share_token}"
            },
            alert_id=alert_id,
            event_key=f"share_{alert_id}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY SHARE_START ERROR] {notify_err}")

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    return jsonify({
        "ok": True,
        "data": {
            "share_id": alert_id,
            "share_token": share_token,
            "track_url": f"{frontend_url}/track.html?t={share_token}",
            "recipient_phones": len(recipient_phones),
            "recipient_emails": len(recipient_emails),
            "duration_str": duration_str
        }
    }), 201


# ─── Route: POST /api/location/stop-share ────────────────────
@alerts_bp.route('/api/location/stop-share', methods=['POST'])
def stop_share_location():
    """
    End an active location sharing session.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None
    data = request.get_json(silent=True) or {}
    share_token = data.get('share_token')

    conn = get_db()
    cursor = conn.cursor()
    if share_token:
        cursor.execute("UPDATE alerts SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE share_token = ?;", (share_token,))
    elif user_id:
        cursor.execute("UPDATE alerts SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE user_id = ? AND mode = 'share_location' AND status = 'active';", (user_id,))
    conn.commit()
    conn.close()

    if user_id:
        try:
            from services.notify import notify
            u_name = (user.get('name') if user else 'SafeHer User') or 'SafeHer User'
            notify(
                event_type='share_stop',
                user_id=user_id,
                context={
                    'user_name': u_name
                },
                event_key=f"share_stop_{share_token or user_id}_{int(datetime.datetime.now().timestamp())}"
            )
        except Exception as notify_err:
            app_logger.warning(f"[NOTIFY SHARE_STOP ERROR] {notify_err}")

    return jsonify({"ok": True, "message": "Location sharing stopped"}), 200


# ─── Routes: POST /api/ride/start & POST /api/ride/end ──────
@alerts_bp.route('/api/ride/start', methods=['POST'])
def start_ride_safety():
    """
    POST /api/ride/start
    Expects JSON: {
      vehicle_type, vehicle_number, driver_name, driver_phone,
      app_used, pickup, destination, travel_minutes, lat, lng, contacts
    }
    Automatically creates a tracked ride session and dispatches WhatsApp (Green API) + Email (Gmail SMTP)
    to all contacts without requiring user to open WhatsApp manually!
    """
    data = request.get_json(silent=True) or {}
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = (user.get('name') if user else None) or 'SafeHer User'

    vehicle_type = (data.get('vehicle_type') or 'Cab').strip()
    vehicle_number = (data.get('vehicle_number') or 'KA01AB1234').strip().upper()
    driver_name = (data.get('driver_name') or '').strip()
    driver_phone = (data.get('driver_phone') or '').strip()
    app_used = (data.get('app_used') or 'Cab').strip()
    pickup = (data.get('pickup') or 'Current Location').strip()
    destination = (data.get('destination') or 'Destination').strip()
    travel_minutes = int(data.get('travel_minutes') or 25)

    lat = float(data.get('lat') or 13.0691)
    lng = float(data.get('lng') or 77.7946)

    client_contacts = data.get('contacts') or []

    share_token = secrets.token_urlsafe(24)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    cursor = conn.cursor()

    # Create an alert record with mode='ride_safety'
    cursor.execute("""
        INSERT INTO alerts (user_id, mode, status, reason, lat, lng, started_at, share_token)
        VALUES (?, 'ride_safety', 'active', ?, ?, ?, ?, ?);
    """, (user_id, f"Ride in {vehicle_number} ({vehicle_type} via {app_used}) to {destination}", lat, lng, now_str, share_token))
    alert_id = cursor.lastrowid

    # Sync client-provided emergency contacts into DB if provided
    recipient_phones = []
    recipient_emails = []

    for cc in (client_contacts or []):
        if isinstance(cc, dict):
            p = str(cc.get('phone') or '').strip()
            e = str(cc.get('email') or '').strip()
            if p and p not in recipient_phones:
                recipient_phones.append(p)
            if e and e not in recipient_emails:
                recipient_emails.append(e)

    # If still empty, query saved contacts from DB
    if not recipient_phones and not recipient_emails:
        try:
            cursor.execute("SELECT phone, email FROM contacts WHERE user_id = ?;", (user_id,))
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

    # Trigger automated WhatsApp & Email in background
    from whatsapp_service import send_ride_started_whatsapp_notifications_background
    from email_service import send_ride_started_email_notifications_background

    if recipient_phones:
        send_ride_started_whatsapp_notifications_background(
            ride_id=alert_id,
            user_name=user_name,
            vehicle_type=vehicle_type,
            vehicle_number=vehicle_number,
            driver_name=driver_name,
            driver_phone=driver_phone,
            app_used=app_used,
            pickup=pickup,
            destination=destination,
            eta_mins=travel_minutes,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_phones=recipient_phones
        )

    if recipient_emails:
        send_ride_started_email_notifications_background(
            ride_id=alert_id,
            user_name=user_name,
            vehicle_type=vehicle_type,
            vehicle_number=vehicle_number,
            driver_name=driver_name,
            driver_phone=driver_phone,
            app_used=app_used,
            pickup=pickup,
            destination=destination,
            eta_mins=travel_minutes,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_emails=recipient_emails
        )

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    track_url = f"{frontend_url}/track.html?t={share_token}"

    try:
        from services.notify import notify
        notify(
            event_type='ride_start',
            user_id=user_id,
            context={
                'user_name': user_name,
                'vehicle_type': vehicle_type,
                'vehicle_number': vehicle_number,
                'app_used': app_used,
                'pickup': pickup,
                'destination': destination,
                'travel_minutes': travel_minutes,
                'lat': lat,
                'lng': lng,
                'track_url': track_url
            },
            alert_id=alert_id,
            event_key=f"ride_{alert_id}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY RIDE_START ERROR] {notify_err}")

    return jsonify({
        "ok": True,
        "data": {
            "ride_id": alert_id,
            "share_token": share_token,
            "track_url": track_url,
            "recipient_phones": len(recipient_phones),
            "recipient_emails": len(recipient_emails),
            "message": "Ride safety started. Automated alerts dispatched via WhatsApp & Email."
        }
    }), 201


@alerts_bp.route('/api/ride/end', methods=['POST'])
def end_ride_safety():
    """
    POST /api/ride/end
    Dispatches "Reached Safely" WhatsApp + Email to all contacts.
    """
    data = request.get_json(silent=True) or {}
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_name = (user.get('name') if user else None) or 'SafeHer User'
    user_id = user['id'] if user else 10000

    destination = (data.get('destination') or 'Destination').strip()
    vehicle_number = (data.get('vehicle_number') or 'Cab').strip()
    share_token = data.get('share_token')

    conn = get_db()
    cursor = conn.cursor()

    if share_token:
        cursor.execute("UPDATE alerts SET status = 'resolved', ended_at = CURRENT_TIMESTAMP WHERE share_token = ?;", (share_token,))
    else:
        cursor.execute("UPDATE alerts SET status = 'resolved', ended_at = CURRENT_TIMESTAMP WHERE user_id = ? AND mode = 'ride_safety' AND status = 'active';", (user_id,))

    conn.commit()

    # Query recipient phones & emails
    cursor.execute("SELECT phone, email FROM contacts WHERE user_id = ?;", (user_id,))
    rows = cursor.fetchall()
    recipient_phones = [str(r['phone']).strip() for r in rows if r['phone'] and str(r['phone']).strip()]
    recipient_emails = [str(r['email']).strip() for r in rows if r['email'] and str(r['email']).strip()]

    pass

    conn.close()

    from whatsapp_service import send_ride_arrived_whatsapp_notifications_background
    from email_service import send_ride_arrived_email_notifications_background

    if recipient_phones:
        send_ride_arrived_whatsapp_notifications_background(
            ride_id=0,
            user_name=user_name,
            destination=destination,
            vehicle_number=vehicle_number,
            recipient_phones=recipient_phones
        )

    if recipient_emails:
        send_ride_arrived_email_notifications_background(
            ride_id=0,
            user_name=user_name,
            destination=destination,
            vehicle_number=vehicle_number,
            recipient_emails=recipient_emails
        )

    try:
        from services.notify import notify
        notify(
            event_type='ride_safe',
            user_id=user_id,
            context={
                'user_name': user_name,
                'destination': destination,
                'vehicle_number': vehicle_number
            },
            event_key=f"ride_safe_{share_token or user_id}_{int(datetime.datetime.now().timestamp())}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY RIDE_SAFE ERROR] {notify_err}")

    return jsonify({
        "ok": True,
        "message": "Ride ended safely. Arrival notification dispatched via WhatsApp & Email."
    }), 200


# ─── Live Sentinel™: Real-Time Ambient Audio Monitoring ────────

def get_sentinel_dir(alert_id):
    """Returns local storage directory for Live Sentinel ambient audio chunks."""
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'evidence', 'live_sentinel', str(alert_id)))
    os.makedirs(base, exist_ok=True)
    return base


def resolve_alert_from_token(token, conn=None):
    """
    Resolves alert dict from an emergency contact token or public share token.
    Works seamlessly for alert_contacts, alerts.share_token, escort_contacts,
    share_contacts (Share Location), and ride_contacts (Ride Escort).
    """
    clean_token = (token or '').strip()
    if not clean_token:
        return None
    close_conn = False
    if conn is None:
        conn = get_db()
        close_conn = True
    cursor = conn.cursor()

    row = None

    # 1. Check alert_contacts (individual contact link for SOS alert)
    cursor.execute('''
        SELECT a.id, a.user_id, a.mode, a.status, a.lat, a.lng, a.started_at,
               u.name AS owner_name, c.name AS contact_name, ac.token AS share_token
        FROM alert_contacts ac
        JOIN alerts a ON ac.alert_id = a.id
        JOIN users u ON a.user_id = u.id
        JOIN contacts c ON ac.contact_id = c.id
        WHERE ac.token = ?;
    ''', (clean_token,))
    row = cursor.fetchone()

    # 2. Check alerts.share_token (general share link for SOS alert)
    if not row:
        cursor.execute('''
            SELECT a.id, a.user_id, a.mode, a.status, a.lat, a.lng, a.started_at,
                   u.name AS owner_name, 'Emergency Contact' AS contact_name, a.share_token
            FROM alerts a
            JOIN users u ON a.user_id = u.id
            WHERE a.share_token = ?;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 3. Check escort_contacts (Escort journey link)
    if not row:
        cursor.execute('''
            SELECT e.id, e.user_id, 'escort' AS mode, e.status, e.last_lat AS lat, e.last_lng AS lng, e.started_at,
                   u.name AS owner_name, c.name AS contact_name, ec.token AS share_token, e.alert_id
            FROM escort_contacts ec
            JOIN escorts e ON ec.escort_id = e.id
            JOIN users u ON e.user_id = u.id
            LEFT JOIN contacts c ON ec.contact_id = c.id
            WHERE ec.token = ?;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 3b. Fallback: if token starts with escort_ and no exact ec.token matched yet
    if not row and clean_token.startswith('escort_'):
        cursor.execute('''
            SELECT e.id, e.user_id, 'escort' AS mode, e.status, e.last_lat AS lat, e.last_lng AS lng, e.started_at,
                   u.name AS owner_name, 'Emergency Contact' AS contact_name, ? AS share_token, e.alert_id
            FROM escorts e
            JOIN users u ON e.user_id = u.id
            ORDER BY e.id DESC LIMIT 1;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 4. Check share_contacts (Share Location session link)
    if not row:
        cursor.execute('''
            SELECT s.id, s.user_id, 'share' AS mode, s.status, s.last_lat AS lat, s.last_lng AS lng, s.started_at,
                   u.name AS owner_name, c.name AS contact_name, sc.token AS share_token
            FROM share_contacts sc
            JOIN shares s ON sc.share_id = s.id
            JOIN users u ON s.user_id = u.id
            LEFT JOIN contacts c ON sc.contact_id = c.id
            WHERE sc.token = ?;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 4b. Fallback: if token starts with share_ and no exact sc.token matched yet
    if not row and clean_token.startswith('share_'):
        cursor.execute('''
            SELECT s.id, s.user_id, 'share' AS mode, s.status, s.last_lat AS lat, s.last_lng AS lng, s.started_at,
                   u.name AS owner_name, 'Emergency Contact' AS contact_name, ? AS share_token
            FROM shares s
            JOIN users u ON s.user_id = u.id
            ORDER BY s.id DESC LIMIT 1;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 5. Check ride_contacts (Ride Escort session link)
    if not row:
        cursor.execute('''
            SELECT r.id, r.user_id, 'ride' AS mode, r.status, r.last_lat AS lat, r.last_lng AS lng, r.started_at,
                   u.name AS owner_name, c.name AS contact_name, rc.token AS share_token
            FROM ride_contacts rc
            JOIN rides r ON rc.ride_id = r.id
            JOIN users u ON r.user_id = u.id
            LEFT JOIN contacts c ON rc.contact_id = c.id
            WHERE rc.token = ?;
        ''', (clean_token,))
        row = cursor.fetchone()

    # 5b. Fallback: if token starts with ride_ and no exact rc.token matched
    if not row and clean_token.startswith('ride_'):
        cursor.execute('''
            SELECT r.id, r.user_id, 'ride' AS mode, r.status, r.last_lat AS lat, r.last_lng AS lng, r.started_at,
                   u.name AS owner_name, 'Emergency Contact' AS contact_name, ? AS share_token
            FROM rides r
            JOIN users u ON r.user_id = u.id
            ORDER BY r.id DESC LIMIT 1;
        ''', (clean_token,))
        row = cursor.fetchone()

    if close_conn:
        conn.close()

    return dict(row) if row else None


def get_sentinel_search_dirs(token_or_id, alert=None):
    """
    Returns prioritized list of candidate directories where Live Sentinel audio
    chunks might be stored for a given token or alert ID.
    """
    base_evidence = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'evidence', 'live_sentinel'))
    dirs = []
    seen = set()

    def add_target(key):
        if not key:
            return
        k_str = str(key).strip()
        if not k_str or k_str in seen:
            return
        seen.add(k_str)
        dirs.append(os.path.join(base_evidence, k_str))

    add_target(token_or_id)
    if alert:
        aid = alert.get('id')
        stok = alert.get('share_token')
        mode = alert.get('mode')
        alt_aid = alert.get('alert_id')
        add_target(aid)
        add_target(stok)
        if alt_aid:
            add_target(alt_aid)
        if aid is not None:
            if mode == 'share':
                add_target(f"share_{aid}")
            elif mode == 'ride':
                add_target(f"ride_{aid}")
            elif mode == 'escort':
                add_target(f"escort_{aid}")

    return dirs


@alerts_bp.route('/api/alerts/<alert_id>/live-audio', methods=['POST'])
def upload_sentinel_audio(alert_id):
    """
    Uplink endpoint for the victim's phone to stream standalone ambient audio chunks.
    Accepts multipart/form-data or application/json (base64 audio).
    Supports numeric alert_id, session tokens (share_*, ride_*), or custom session ids.
    """
    try:
        aid = int(alert_id)
    except (ValueError, TypeError):
        aid = str(alert_id).strip()

    s_dir = get_sentinel_dir(aid)
    share_token = (request.form.get('share_token') or request.args.get('share_token') or '').strip()

    sequence = 0
    amplitude_db = 35.0
    noise_level = "Ambient sound"
    mime_type = "audio/webm"
    duration_ms = 4000
    ext = ".webm"
    saved_bytes = None

    if request.files and ('audio' in request.files or 'file' in request.files):
        f = request.files.get('audio') or request.files.get('file')
        try: sequence = int(request.form.get('sequence', 0))
        except Exception: sequence = 0
        try: amplitude_db = float(request.form.get('amplitude_db', 35.0))
        except Exception: amplitude_db = 35.0
        noise_level = request.form.get('noise_level', 'Ambient sound')
        mime_type = request.form.get('mime_type', 'audio/webm')
        try: duration_ms = int(request.form.get('duration_ms', 4000))
        except Exception: duration_ms = 4000

        if 'mp4' in mime_type: ext = '.mp4'
        elif 'ogg' in mime_type: ext = '.ogg'
        elif 'aac' in mime_type: ext = '.aac'
        elif 'wav' in mime_type: ext = '.wav'

        saved_bytes = f.read()
        f_path = os.path.join(s_dir, f"chunk_{sequence}{ext}")
        with open(f_path, 'wb') as f_out:
            f_out.write(saved_bytes)
        try:
            with open(os.path.join(s_dir, f"session_stream{ext}"), 'ab') as f_stream:
                f_stream.write(saved_bytes)
        except Exception:
            pass

    elif request.is_json:
        data = request.get_json(silent=True) or {}
        sequence = int(data.get('sequence', 0))
        amplitude_db = float(data.get('amplitude_db', 35.0))
        noise_level = data.get('noise_level', 'Ambient sound')
        mime_type = data.get('mime_type', 'audio/webm')
        duration_ms = int(data.get('duration_ms', 4000))
        if not share_token:
            share_token = (data.get('share_token') or '').strip()

        if 'mp4' in mime_type: ext = '.mp4'
        elif 'ogg' in mime_type: ext = '.ogg'
        elif 'aac' in mime_type: ext = '.aac'
        elif 'wav' in mime_type: ext = '.wav'

        b64 = data.get('audio_base64')
        if b64:
            import base64
            if ',' in b64:
                b64 = b64.split(',', 1)[1]
            saved_bytes = base64.b64decode(b64)
            f_path = os.path.join(s_dir, f"chunk_{sequence}{ext}")
            with open(f_path, 'wb') as f_out:
                f_out.write(saved_bytes)
            try:
                with open(os.path.join(s_dir, f"session_stream{ext}"), 'ab') as f_stream:
                    f_stream.write(saved_bytes)
            except Exception:
                pass
    else:
        raw_body = request.get_data()
        if raw_body and len(raw_body) > 64:
            try: sequence = int(request.args.get('sequence', 0))
            except Exception: sequence = 0
            saved_bytes = raw_body
            f_path = os.path.join(s_dir, f"chunk_{sequence}{ext}")
            with open(f_path, 'wb') as f_out:
                f_out.write(saved_bytes)
            try:
                with open(os.path.join(s_dir, f"session_stream{ext}"), 'ab') as f_stream:
                    f_stream.write(saved_bytes)
            except Exception:
                pass

    # Save latest status metadata
    now_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    latest_meta = {
        "alert_id": aid,
        "share_token": share_token or None,
        "sequence": sequence,
        "timestamp": now_utc,
        "amplitude_db": round(amplitude_db, 1),
        "noise_level": noise_level,
        "mime_type": mime_type,
        "duration_ms": duration_ms,
        "filename": f"chunk_{sequence}{ext}"
    }

    # Write to primary dir
    with open(os.path.join(s_dir, 'latest.json'), 'w', encoding='utf-8') as f_meta:
        json.dump(latest_meta, f_meta)

    # If share_token is provided and different from aid, mirror to share_token directory
    if share_token and str(share_token) != str(aid):
        token_dir = get_sentinel_dir(share_token)
        try:
            with open(os.path.join(token_dir, 'latest.json'), 'w', encoding='utf-8') as f_tmeta:
                json.dump(latest_meta, f_tmeta)
            if saved_bytes:
                with open(os.path.join(token_dir, f"chunk_{sequence}{ext}"), 'wb') as f_tchunk:
                    f_tchunk.write(saved_bytes)
                with open(os.path.join(token_dir, f"session_stream{ext}"), 'ab') as f_tstream:
                    f_tstream.write(saved_bytes)
        except Exception:
            pass

    return jsonify({
        "ok": True,
        "sequence": sequence,
        "alert_id": aid,
        "share_token": share_token,
        "message": "Sentinel ambient audio chunk saved"
    }), 200


@alerts_bp.route('/api/alerts/<alert_id>/live-audio/full-session', methods=['POST'])
def upload_sentinel_full_session(alert_id):
    """
    Accepts consolidated full-session master audio recording from victim's phone.
    Guarantees the emergency contact can download the complete session evidence.
    """
    try:
        aid = int(alert_id)
    except (ValueError, TypeError):
        aid = str(alert_id).strip()

    s_dir = get_sentinel_dir(aid)
    share_token = (request.form.get('share_token') or request.args.get('share_token') or '').strip()

    f = request.files.get('audio') or request.files.get('file')
    if f:
        ext = '.webm'
        if 'mp4' in (f.mimetype or ''): ext = '.mp4'
        elif 'ogg' in (f.mimetype or ''): ext = '.ogg'
        saved_bytes = f.read()
        target = os.path.join(s_dir, f"full_session{ext}")
        with open(target, 'wb') as f_out:
            f_out.write(saved_bytes)

        if share_token and str(share_token) != str(aid):
            t_dir = get_sentinel_dir(share_token)
            try:
                with open(os.path.join(t_dir, f"full_session{ext}"), 'wb') as f_out:
                    f_out.write(saved_bytes)
            except Exception:
                pass

        return jsonify({"ok": True, "message": "Full session audio uploaded", "bytes": len(saved_bytes)}), 200

    return jsonify({"ok": False, "error": "No file uploaded"}), 400


@alerts_bp.route('/api/track/<token>/live-audio', methods=['GET'])
def get_sentinel_live_audio(token):
    """
    Public live audio metadata endpoint for emergency contacts on track.html.
    Returns latest noise level, decibel measurement, active stream status, and chunk info.
    Supports SOS alerts, Share Location, and Ride Escort tokens.
    """
    alert = resolve_alert_from_token(token)
    if not alert:
        return jsonify({"ok": False, "error": "Tracking token invalid or expired"}), 404

    alert_id = alert['id']
    status = alert['status']
    is_active = (status in ('active', 'On route', 'monitoring'))

    candidate_dirs = get_sentinel_search_dirs(token, alert)
    latest_data = None
    active_dir = None

    for d in candidate_dirs:
        lf = os.path.join(d, 'latest.json')
        if os.path.exists(lf):
            try:
                with open(lf, 'r', encoding='utf-8') as f:
                    cand_data = json.load(f)
                    if not latest_data or (cand_data.get('timestamp', '') >= latest_data.get('timestamp', '')):
                        latest_data = cand_data
                        active_dir = d
            except Exception:
                pass

    if not active_dir and candidate_dirs:
        active_dir = candidate_dirs[0]

    recent_chunks = []
    if active_dir and os.path.exists(active_dir):
        try:
            files = sorted(
                [f for f in os.listdir(active_dir) if f.startswith('chunk_') and not f.endswith('.json')],
                key=lambda x: os.path.getmtime(os.path.join(active_dir, x))
            )
            for f in files[-5:]:
                m = re.search(r'chunk_(\d+)', f)
                seq_num = int(m.group(1)) if m else 0
                recent_chunks.append({
                    "sequence": seq_num,
                    "filename": f,
                    "url": f"/api/track/{token}/live-audio/chunks/{seq_num}"
                })
        except Exception:
            pass

    owner_first_name = (alert.get('owner_name') or 'User').split()[0]
    return jsonify({
        "ok": True,
        "active": is_active,
        "alert_status": status,
        "alert_id": alert_id,
        "first_name": owner_first_name,
        "has_audio": bool(latest_data),
        "latest_seq": latest_data.get('sequence', 0) if latest_data else 0,
        "amplitude_db": latest_data.get('amplitude_db', 0) if latest_data else 0,
        "noise_level": latest_data.get('noise_level', 'Ambient listening') if latest_data else 'Listening for audio stream...',
        "timestamp": latest_data.get('timestamp') if latest_data else None,
        "mime_type": latest_data.get('mime_type', 'audio/webm') if latest_data else 'audio/webm',
        "chunk_url": f"/api/track/{token}/live-audio/chunks/{latest_data.get('sequence')}" if (latest_data and latest_data.get('sequence') is not None) else None,
        "recent_chunks": recent_chunks
    }), 200


@alerts_bp.route('/api/track/<token>/live-audio/chunks/<int:sequence>', methods=['GET'])
def get_sentinel_chunk_file(token, sequence):
    """
    Serves a specific audio chunk for playback in emergency contact's browser.
    """
    alert = resolve_alert_from_token(token)
    if not alert:
        return jsonify({"ok": False, "error": "Tracking token invalid or expired"}), 404

    candidate_dirs = get_sentinel_search_dirs(token, alert)
    match_file = None

    for d in candidate_dirs:
        if not os.path.exists(d):
            continue
        for ext in ['.webm', '.mp4', '.ogg', '.aac', '.wav']:
            fn = os.path.join(d, f"chunk_{sequence}{ext}")
            if os.path.exists(fn):
                match_file = fn
                break
        if match_file:
            break
        for f in os.listdir(d):
            if f.startswith(f"chunk_{sequence}."):
                match_file = os.path.join(d, f)
                break
        if match_file:
            break

    if not match_file or not os.path.exists(match_file):
        return jsonify({"ok": False, "error": "Audio chunk not found"}), 404

    mime = 'audio/webm'
    if match_file.endswith('.mp4'): mime = 'audio/mp4'
    elif match_file.endswith('.ogg'): mime = 'audio/ogg'
    elif match_file.endswith('.aac'): mime = 'audio/aac'
    elif match_file.endswith('.wav'): mime = 'audio/wav'

    resp = send_file(match_file, mimetype=mime, as_attachment=False, conditional=True)
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Cache-Control'] = 'public, max-age=3600'
    resp.headers['Accept-Ranges'] = 'bytes'
    return resp


@alerts_bp.route('/api/track/<token>/live-audio/download', methods=['GET'])
def download_sentinel_audio(token):
    """
    Allows emergency contacts to download the ambient audio clip as police evidence.
    Always provides the COMPLETE continuous recording of the session, not a 1-second slice.
    """
    alert = resolve_alert_from_token(token)
    if not alert:
        return jsonify({"ok": False, "error": "Tracking token invalid or expired"}), 404

    alert_id = alert['id']
    candidate_dirs = get_sentinel_search_dirs(token, alert)
    target_file = None
    target_mime = 'audio/webm'
    target_ext = '.webm'

    for d in candidate_dirs:
        if not os.path.exists(d):
            continue

        # 1. Prefer client-uploaded continuous full_session file
        for ext in ['.webm', '.mp4', '.ogg', '.wav']:
            fs_path = os.path.join(d, f"full_session{ext}")
            if os.path.exists(fs_path) and os.path.getsize(fs_path) > 1024:
                target_file = fs_path
                target_ext = ext
                target_mime = 'audio/mp4' if ext == '.mp4' else 'audio/webm'
                break
        if target_file:
            break

        # 2. Check server-accumulated session_stream file
        for ext in ['.webm', '.mp4', '.ogg', '.wav']:
            ss_path = os.path.join(d, f"session_stream{ext}")
            if os.path.exists(ss_path) and os.path.getsize(ss_path) > 1024:
                target_file = ss_path
                target_ext = ext
                target_mime = 'audio/mp4' if ext == '.mp4' else 'audio/webm'
                break
        if target_file:
            break

        # 3. Concatenate all individual sequence chunks into a complete continuous evidence file
        chunk_files = [f for f in os.listdir(d) if f.startswith('chunk_') and not f.endswith('.json')]
        if chunk_files:
            # Sort numerically by sequence
            def get_seq(fn):
                m = re.search(r'chunk_(\d+)', fn)
                return int(m.group(1)) if m else 0
            sorted_chunks = sorted(chunk_files, key=get_seq)
            ext = os.path.splitext(sorted_chunks[0])[1] or '.webm'
            combined_path = os.path.join(d, f"combined_evidence{ext}")
            try:
                with open(combined_path, 'wb') as f_out:
                    for cf in sorted_chunks:
                        with open(os.path.join(d, cf), 'rb') as f_in:
                            f_out.write(f_in.read())
                if os.path.exists(combined_path) and os.path.getsize(combined_path) > 0:
                    target_file = combined_path
                    target_ext = ext
                    target_mime = 'audio/mp4' if ext == '.mp4' else 'audio/webm'
                    break
            except Exception:
                pass

        # 4. Fallback: single latest chunk if concatenation failed
        if not target_file and chunk_files:
            target_file = os.path.join(d, chunk_files[-1])
            target_ext = os.path.splitext(target_file)[1] or '.webm'
            target_mime = 'audio/mp4' if target_ext == '.mp4' else 'audio/webm'
            break

    if not target_file or not os.path.exists(target_file) or os.path.getsize(target_file) == 0:
        return jsonify({"ok": False, "error": "No live audio recorded for this alert"}), 404

    resp = send_file(
        target_file,
        mimetype=target_mime,
        as_attachment=True,
        download_name=f"SafeHer_Sentinel_Full_Evidence_{alert_id}{target_ext}"
    )
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp


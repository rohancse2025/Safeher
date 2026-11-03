# backend/routes/alerts.py – Emergency alerts, live tracking updates, duress PIN handling, and public tracking
import secrets
import datetime
from flask import Blueprint, request, jsonify, g
from werkzeug.security import check_password_hash

from db import get_db
from logger import app_logger
from routes.auth import login_required
from email_service import send_email, send_alert_notifications_background

alerts_bp = Blueprint('alerts', __name__)

VALID_MODES = {'normal', 'silent', 'emergency', 'timer'}


def is_valid_coord(lat, lng):
    """Validate latitude and longitude numbers."""
    try:
        f_lat = float(lat)
        f_lng = float(lng)
        return -90.0 <= f_lat <= 90.0 and -180.0 <= f_lng <= 180.0
    except (ValueError, TypeError):
        return False


# ─── Route: POST /api/alerts ─────────────────────────────────
@alerts_bp.route('/api/alerts', methods=['POST'])
@login_required
def create_alert():
    """
    Create a new emergency alert (normal, silent, or emergency).
    Creates an active alert record, a unique share_token, a first location point,
    and dispatches background emergency emails to contacts.
    Expects JSON: { mode: "normal"|"silent"|"emergency", lat: float, lng: float }
    """
    user_id = g.current_user['id']
    user_name = g.current_user['name']
    data = request.get_json(silent=True) or {}

    mode = (data.get('mode') or 'normal').strip().lower()
    if mode not in VALID_MODES:
        return jsonify({"ok": False, "error": f"Invalid mode. Must be one of: {', '.join(VALID_MODES)}"}), 400

    lat = data.get('lat')
    lng = data.get('lng')
    if lat is None or lng is None or not is_valid_coord(lat, lng):
        return jsonify({"ok": False, "error": "Valid latitude and longitude coordinates are required"}), 400

    lat = float(lat)
    lng = float(lng)
    share_token = secrets.token_urlsafe(16)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    cursor = conn.cursor()

    # Abuse limit: normal and silent SOS alerts are limited to 5 per user per hour (emergency mode is never limited)
    if mode in ('normal', 'silent'):
        cursor.execute('''
            SELECT COUNT(*) AS alert_count
            FROM alerts
            WHERE user_id = ?
              AND mode IN ('normal', 'silent')
              AND started_at >= datetime('now', '-1 hour');
        ''', (user_id,))
        count_row = cursor.fetchone()
        if count_row and count_row['alert_count'] >= 5:
            conn.close()
            return jsonify({
                "ok": False,
                "error": "Too many alerts, call 112 directly",
                "call_112": True
            }), 429

    try:
        # 1. Insert alert record
        cursor.execute('''
            INSERT INTO alerts (user_id, mode, status, lat, lng, share_token, notified_count, duress)
            VALUES (?, ?, 'active', ?, ?, ?, 0, 0);
        ''', (user_id, mode, lat, lng, share_token))
        alert_id = cursor.lastrowid

        # 2. Insert first location row
        cursor.execute('''
            INSERT INTO locations (alert_id, lat, lng)
            VALUES (?, ?, ?);
        ''', (alert_id, lat, lng))

        # 3. Retrieve contacts with email addresses
        cursor.execute('''
            SELECT email FROM contacts
            WHERE user_id = ? AND email IS NOT NULL AND TRIM(email) != '';
        ''', (user_id,))
        email_rows = cursor.fetchall()
        recipient_emails = [r['email'].strip() for r in email_rows if r['email']]

        conn.commit()
    except Exception:
        conn.close()
        return jsonify({"ok": False, "error": "Failed to create alert"}), 500

    conn.close()

    # 4. Trigger background email dispatch to contacts (works for all modes including silent)
    if recipient_emails:
        send_alert_notifications_background(
            alert_id=alert_id,
            user_name=user_name,
            mode=mode,
            started_at_str=now_str,
            lat=lat,
            lng=lng,
            share_token=share_token,
            recipient_emails=recipient_emails
        )

    # Log alert creation event (without tokens or raw phone numbers)
    app_logger.info(f"[ALERT CREATED] alert_id={alert_id}, user_id={user_id}, mode={mode}, lat={lat}, lng={lng}")

    # 5. Trigger Web Push notification to available approved volunteers within 2 km
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

    return jsonify({
        "ok": True,
        "data": {
            "id": alert_id,
            "user_id": user_id,
            "mode": mode,
            "status": "active",
            "lat": lat,
            "lng": lng,
            "share_token": share_token,
            "notified_count": len(recipient_emails),
            "duress": 0,
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
@login_required
def end_alert(alert_id):
    """
    End an active alert using a 4-digit safety PIN.
    - If correct normal PIN: marks alert as 'resolved' with ended_at.
    - If duress PIN: answers success to attacker, but keeps alert active and sets duress=1.
    - If wrong PIN: returns an error.
    Expects JSON: { pin: "1234" }
    """
    user_id = g.current_user['id']
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
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    # Fetch user's PIN hashes
    cursor.execute('SELECT pin_hash, duress_pin_hash FROM users WHERE id = ?;', (user_id,))
    user = cursor.fetchone()

    if not user or not user['pin_hash']:
        conn.close()
        return jsonify({"ok": False, "error": "No safety PIN configured for this account"}), 400

    # 1. Normal PIN match: legitimately end the alert
    if check_password_hash(user['pin_hash'], pin):
        cursor.execute('''
            UPDATE alerts
            SET status = 'resolved', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (alert_id,))
        conn.commit()
        conn.close()
        app_logger.info(f"[ALERT ENDED] alert_id={alert_id}, status=resolved")
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": alert_id,
                "status": "resolved",
                "message": "Alert ended successfully"
            }
        }), 200

    # 2. Duress PIN match: answer success to deceive attacker, but keep alert active and mark duress=1
    if user['duress_pin_hash'] and check_password_hash(user['duress_pin_hash'], pin):
        cursor.execute('UPDATE alerts SET duress = 1 WHERE id = ?;', (alert_id,))
        conn.commit()
        conn.close()
        app_logger.info(f"[ALERT ENDED] alert_id={alert_id}, status=duress")
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": alert_id,
                "status": "resolved",
                "message": "Alert ended successfully"
            }
        }), 200

    # 3. Wrong PIN
    conn.close()
    return jsonify({"ok": False, "error": "Incorrect safety PIN"}), 403


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
            "route": route_points,
            "lat": alert['lat'],
            "lng": alert['lng'],
            "share_token": alert['share_token']
        }
    }), 200


# ─── Public Route: GET /api/track/<share_token> ──────────────
@alerts_bp.route('/api/track/<share_token>', methods=['GET'])
def get_public_track(share_token):
    """
    Public live tracking route. Accessible without login.
    Returns ONLY:
      - first_name
      - mode
      - status
      - latest_lat
      - latest_lng
      - last_update_time
      - volunteers_en_route
    Never exposes full name, phone number, email, or user credentials.
    """
    clean_token = share_token.strip()

    conn = get_db()
    cursor = conn.cursor()

    # Find alert and user's full name
    cursor.execute('''
        SELECT a.id, a.mode, a.status, a.lat, a.lng, a.started_at, u.name
        FROM alerts a
        JOIN users u ON a.user_id = u.id
        WHERE a.share_token = ?;
    ''', (clean_token,))
    alert = cursor.fetchone()

    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Tracking link not found or expired"}), 404

    alert_id = alert['id']
    status = alert['status']

    # Auto-expire active alerts running for more than 6 hours
    if status == 'active' and alert['started_at']:
        try:
            started_dt = datetime.datetime.strptime(alert['started_at'], "%Y-%m-%d %H:%M:%S")
            if datetime.datetime.now() - started_dt > datetime.timedelta(hours=6):
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

    # Extract first name only
    full_name = alert['name'] or ''
    first_name = full_name.split()[0] if full_name else 'User'

    return jsonify({
        "ok": True,
        "data": {
            "first_name": first_name,
            "mode": alert['mode'],
            "status": status,
            "latest_lat": latest_lat,
            "latest_lng": latest_lng,
            "last_update_time": last_update_time,
            "volunteers_en_route": volunteers_en_route
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

# backend/routes/volunteers.py – Community volunteer network, nearby active alerts, and response dispatch
import math
from flask import Blueprint, request, jsonify, g

from db import get_db
from routes.auth import login_required
from routes.alerts import is_valid_coord

volunteers_bp = Blueprint('volunteers', __name__)


def haversine_km(lat1, lon1, lat2, lon2):
    """
    Calculate the great-circle distance between two points on Earth in kilometers.
    """
    R = 6371.0  # Earth radius in kilometers
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2.0) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


# ─── Route: POST /api/volunteers/status ──────────────────────
@volunteers_bp.route('/api/volunteers/status', methods=['POST'])
@login_required
def update_volunteer_status():
    """
    Set volunteer availability status, save their latest GPS position, and register with optional note.
    New volunteers start as 'pending' until approved by an administrator.
    Expects JSON: { available: bool, lat: float (optional), lng: float (optional), note: str (optional) }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}

    available = 1 if data.get('available') in (True, 1, 'true', '1') else 0
    lat = data.get('lat')
    lng = data.get('lng')
    note = (data.get('note') or '').strip()

    if available and (lat is not None and lng is not None):
        if not is_valid_coord(lat, lng):
            return jsonify({"ok": False, "error": "Invalid latitude or longitude coordinates"}), 400
        lat = float(lat)
        lng = float(lng)
    else:
        lat = float(lat) if lat is not None and is_valid_coord(lat, lng) else None
        lng = float(lng) if lng is not None and is_valid_coord(lat, lng) else None

    conn = get_db()
    cursor = conn.cursor()

    # Insert or update volunteer record (new records default to 'pending')
    cursor.execute('''
        INSERT INTO volunteers (user_id, available, lat, lng, status, note, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            available = excluded.available,
            lat = COALESCE(excluded.lat, volunteers.lat),
            lng = COALESCE(excluded.lng, volunteers.lng),
            note = COALESCE(excluded.note, volunteers.note),
            updated_at = CURRENT_TIMESTAMP;
    ''', (user_id, available, lat, lng, note or None))

    conn.commit()

    cursor.execute('SELECT id, user_id, available, lat, lng, status, note, updated_at FROM volunteers WHERE user_id = ?;', (user_id,))
    vol = dict(cursor.fetchone())
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "volunteer_id": vol['id'],
            "available": bool(vol['available']),
            "status": vol['status'] or 'pending',
            "note": vol['note'] or '',
            "lat": vol['lat'],
            "lng": vol['lng'],
            "updated_at": vol['updated_at']
        }
    }), 200


# ─── Route: GET /api/volunteers/profile ──────────────────────
@volunteers_bp.route('/api/volunteers/profile', methods=['GET'])
@login_required
def get_volunteer_profile():
    """
    Get the authenticated user's volunteer status and verification state.
    """
    user_id = g.current_user['id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, available, lat, lng, status, note, updated_at FROM volunteers WHERE user_id = ?;', (user_id,))
    vol = cursor.fetchone()
    conn.close()

    if not vol:
        return jsonify({
            "ok": True,
            "data": {
                "registered": False,
                "status": "pending",
                "available": False,
                "note": ""
            }
        }), 200

    return jsonify({
        "ok": True,
        "data": {
            "registered": True,
            "volunteer_id": vol['id'],
            "status": vol['status'] or 'pending',
            "available": bool(vol['available']),
            "lat": vol['lat'],
            "lng": vol['lng'],
            "note": vol['note'] or '',
            "updated_at": vol['updated_at']
        }
    }), 200


# ─── Route: GET /api/volunteers/nearby-alerts ────────────────
@volunteers_bp.route('/api/volunteers/nearby-alerts', methods=['GET'])
@login_required
def get_nearby_alerts():
    """
    Find active alerts within 2 km of the volunteer's latest position.
    Excludes alerts created by the volunteer themselves.
    Only approved volunteers can receive nearby alerts.
    For silent alerts, returns no user name.
    """
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    # Get volunteer's location and approval status
    cursor.execute('SELECT lat, lng, available, status FROM volunteers WHERE user_id = ?;', (user_id,))
    volunteer = cursor.fetchone()

    if not volunteer:
        conn.close()
        return jsonify({
            "ok": True,
            "data": [],
            "approval_status": "not_registered",
            "message": "Volunteer registration required"
        }), 200

    # Verification check: only approved volunteers appear in nearby-alert matching
    if volunteer['status'] != 'approved':
        conn.close()
        return jsonify({
            "ok": True,
            "data": [],
            "approval_status": volunteer['status'] or 'pending',
            "message": "Pending approval: Only approved volunteers receive nearby emergency alerts"
        }), 200

    if volunteer['lat'] is None or volunteer['lng'] is None:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Volunteer location not recorded. Please send location with /api/volunteers/status"
        }), 400

    v_lat = volunteer['lat']
    v_lng = volunteer['lng']

    # Retrieve all active alerts not created by this user
    cursor.execute('''
        SELECT a.id, a.user_id, a.mode, a.status, a.lat, a.lng, a.started_at, a.share_token, u.name
        FROM alerts a
        JOIN users u ON a.user_id = u.id
        WHERE a.status = 'active' AND a.user_id != ?;
    ''', (user_id,))
    active_alerts = cursor.fetchall()
    conn.close()

    nearby = []
    for alert in active_alerts:
        a_lat = alert['lat']
        a_lng = alert['lng']
        if a_lat is None or a_lng is None:
            continue

        dist_km = haversine_km(v_lat, v_lng, a_lat, a_lng)
        # 2 km proximity filter
        if dist_km <= 2.0:
            is_silent = alert['mode'] == 'silent'
            nearby.append({
                "id": alert['id'],
                "alert_id": alert['id'],
                "mode": alert['mode'],
                "status": alert['status'],
                "distance_km": round(dist_km, 2),
                "time": alert['started_at'],
                "maps_link": f"https://www.google.com/maps?q={a_lat},{a_lng}",
                "name": None if is_silent else alert['name'],
                "share_token": alert['share_token']
            })

    # Sort alerts by closest distance
    nearby.sort(key=lambda x: x['distance_km'])

    return jsonify({
        "ok": True,
        "data": nearby,
        "approval_status": "approved"
    }), 200


# ─── Route: POST /api/alerts/<id>/respond ─────────────────────
@volunteers_bp.route('/api/alerts/<int:alert_id>/respond', methods=['POST'])
@login_required
def respond_to_alert(alert_id):
    """
    Volunteer responds to an alert with status "coming" or "cannot".
    Expects JSON: { status: "coming"|"cannot" }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    status = (data.get('status') or '').strip().lower()

    if status not in ('coming', 'cannot'):
        return jsonify({"ok": False, "error": "Status must be either 'coming' or 'cannot'"}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Verify alert exists
    cursor.execute('SELECT id, status, user_id, mode FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    # Ensure volunteer record exists for current user
    cursor.execute('SELECT id FROM volunteers WHERE user_id = ?;', (user_id,))
    vol_row = cursor.fetchone()
    if not vol_row:
        cursor.execute('INSERT INTO volunteers (user_id, available) VALUES (?, 1);', (user_id,))
        volunteer_id = cursor.lastrowid
    else:
        volunteer_id = vol_row['id']

    # Check if volunteer has already responded to this alert (a volunteer can't respond to the same alert twice)
    cursor.execute('SELECT id FROM responses WHERE alert_id = ? AND volunteer_id = ?;', (alert_id, volunteer_id))
    if cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "You have already responded to this alert"}), 400

    # Insert response
    cursor.execute('''
        INSERT INTO responses (alert_id, volunteer_id, status, time)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP);
    ''', (alert_id, volunteer_id, status))

    conn.commit()
    conn.close()

    # Trigger push notification to victim when volunteer taps "I'm coming" (unless alert is silent)
    if status == 'coming':
        try:
            from routes.push import notify_victim_volunteer_coming
            notify_victim_volunteer_coming(alert['user_id'], alert_id, alert['mode'])
        except Exception as push_err:
            pass

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": alert_id,
            "volunteer_id": volunteer_id,
            "status": status,
            "message": "Response recorded successfully"
        }
    }), 200


# ─── Route: GET /api/alerts/<id>/status ──────────────────────
@volunteers_bp.route('/api/alerts/<int:alert_id>/status', methods=['GET'])
@login_required
def get_alert_volunteer_status(alert_id):
    """
    Get how many volunteers are on the way for an alert. Owner only.
    """
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    # Check alert owner
    cursor.execute('SELECT id, status FROM alerts WHERE id = ? AND user_id = ?;', (alert_id, user_id))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    # Count volunteers who responded 'coming'
    cursor.execute('''
        SELECT COUNT(DISTINCT volunteer_id) AS volunteers_coming
        FROM responses
        WHERE alert_id = ? AND status = 'coming';
    ''', (alert_id,))
    row = cursor.fetchone()
    volunteers_coming = row['volunteers_coming'] if row else 0

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": alert_id,
            "status": alert['status'],
            "volunteers_coming": volunteers_coming
        }
    }), 200


# ─── Route: GET /api/volunteers/count ────────────────────────
@volunteers_bp.route('/api/volunteers/count', methods=['GET'])
def get_available_volunteers_count():
    """
    Returns the total number of volunteers currently marked available.
    Public endpoint.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) AS total FROM volunteers WHERE available = 1 AND status = 'approved';")
    row = cursor.fetchone()
    count = row['total'] if row else 0
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "available_volunteers": count
        }
    }), 200

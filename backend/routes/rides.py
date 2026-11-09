# backend/routes/rides.py – Monitored Ride Safety sessions with per-contact tracking tokens & Brevo notifications
import os
import secrets
import datetime
from flask import Blueprint, request, jsonify, g

from db import get_db
from logger import app_logger
from routes.alerts import get_user_from_request
from services.notify import notify

rides_bp = Blueprint('rides', __name__)


# ─── Route: POST /api/rides ───────────────────────────────────
@rides_bp.route('/api/rides', methods=['POST'])
def create_ride():
    """
    Start a new Ride Safety session.
    Payload:
      {
        "vehicle_type": "Cab" | "Auto" | "Bus" | "Metro",
        "vehicle_number": "KA-01-AB-1234",
        "driver_name": "Ramesh",
        "driver_phone": "9876543210",
        "app_used": "Uber" | "Ola" | "Rapido" | "Auto Hail",
        "pickup": "Majestic Station",
        "destination": "Whitefield",
        "expected_minutes": 30,
        "contact_ids": [1, 2],
        "lat": 12.9716,
        "lng": 77.5946
      }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    user_name = (user.get('name') or 'SafeHer User').strip()
    data = request.get_json(silent=True) or {}

    vehicle_type = (data.get('vehicle_type') or 'Cab').strip()
    vehicle_number = (data.get('vehicle_number') or '').strip().upper()
    driver_name = (data.get('driver_name') or '').strip()
    driver_phone = (data.get('driver_phone') or '').strip()
    app_used = (data.get('app_used') or '').strip()
    pickup = (data.get('pickup') or '').strip()
    destination = (data.get('destination') or '').strip()

    try:
        expected_minutes = max(1, min(1440, int(data.get('expected_minutes') or 30)))
    except Exception:
        expected_minutes = 30

    lat = data.get('lat')
    lng = data.get('lng')

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    expected_end_at = (now_utc + datetime.timedelta(minutes=expected_minutes)).strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    cursor = conn.cursor()

    # Cancel previous active rides for this user
    cursor.execute('''
        UPDATE rides
        SET status = 'ended', ended_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'active';
    ''', (user_id,))

    cursor.execute('''
        INSERT INTO rides (
            user_id, vehicle_type, vehicle_number, driver_name, driver_phone,
            app_used, pickup, destination, expected_minutes, started_at, expected_end_at,
            status, last_lat, last_lng, last_update_at, late_notified, alert_created
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'active', ?, ?, CURRENT_TIMESTAMP, 0, 0);
    ''', (
        user_id, vehicle_type, vehicle_number, driver_name, driver_phone,
        app_used, pickup, destination, expected_minutes, expected_end_at,
        lat, lng
    ))
    ride_id = cursor.lastrowid

    # Resolve contacts: either specified or all user contacts
    contact_ids = data.get('contact_ids')
    if contact_ids and isinstance(contact_ids, list):
        contact_ids = [int(cid) for cid in contact_ids if str(cid).isdigit()]
    else:
        cursor.execute("SELECT id FROM contacts WHERE user_id = ?;", (user_id,))
        contact_ids = [r['id'] for r in cursor.fetchall()]

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens_list = []

    for cid in contact_ids:
        tok = secrets.token_urlsafe(32)
        cursor.execute('''
            INSERT INTO ride_contacts (ride_id, contact_id, token, created_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP);
        ''', (ride_id, cid, tok))
        tokens_list.append({
            "contact_id": cid,
            "token": tok,
            "track_url": f"{frontend_url}/track.html?t={tok}"
        })

    conn.commit()
    conn.close()

    primary_tok = tokens_list[0]['token'] if tokens_list else secrets.token_urlsafe(32)
    vehicle_desc = f"{vehicle_type} {vehicle_number}".strip()

    # Dispatch ride_started notification via central engine
    notify(
        event_type='ride_started',
        user_id=user_id,
        context={
            'user_name': user_name,
            'vehicle_type': vehicle_type,
            'vehicle_number': vehicle_number,
            'driver_name': driver_name,
            'destination': destination,
            'expected_minutes': expected_minutes,
            'lat': lat,
            'lng': lng,
            'ride_id': ride_id,
            'track_url': f"{frontend_url}/track.html?t={primary_tok}"
        },
        contact_ids=contact_ids,
        event_key=f"ride:{ride_id}:started"
    )

    app_logger.info(f"[RIDE STARTED] ride_id={ride_id}, user_id={user_id}, vehicle={vehicle_desc}, eta={expected_minutes}m, contacts={len(contact_ids)}")

    return jsonify({
        "ok": True,
        "message": f"Ride monitoring started ({vehicle_desc})",
        "data": {
            "id": ride_id,
            "status": "active",
            "vehicle_type": vehicle_type,
            "vehicle_number": vehicle_number,
            "destination": destination,
            "expected_minutes": expected_minutes,
            "expected_end_at": expected_end_at,
            "contacts_count": len(contact_ids),
            "tokens": tokens_list
        }
    }), 201


# ─── Route: POST /api/rides/<id>/position ──────────────────────
@rides_bp.route('/api/rides/<int:ride_id>/position', methods=['POST'])
def update_ride_position(ride_id):
    """
    Update position for an active monitored ride.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    data = request.get_json(silent=True) or {}
    lat = data.get('lat')
    lng = data.get('lng')

    if lat is None or lng is None:
        return jsonify({"ok": False, "error": "Coordinates lat and lng are required"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, user_id, status FROM rides
        WHERE id = ? AND user_id = ?;
    ''', (ride_id, user['id']))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Ride session not found"}), 404

    if row['status'] != 'active':
        conn.close()
        return jsonify({"ok": False, "error": f"Ride session is {row['status']}"}), 400

    cursor.execute('''
        UPDATE rides
        SET last_lat = ?, last_lng = ?, last_update_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (lat, lng, ride_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "ride_id": ride_id,
            "lat": lat,
            "lng": lng
        }
    }), 200


# ─── Route: POST /api/rides/<id>/end ───────────────────────────
@rides_bp.route('/api/rides/<int:ride_id>/end', methods=['POST'])
def end_ride(ride_id):
    """
    End an active ride safety session.
    Dispatches 'ride_ended' notification to contacts.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT r.id, r.user_id, r.status, r.destination, u.name AS user_name
        FROM rides r
        JOIN users u ON r.user_id = u.id
        WHERE r.id = ? AND r.user_id = ?;
    ''', (ride_id, user['id']))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Ride session not found"}), 404

    if row['status'] != 'ended':
        cursor.execute('''
            UPDATE rides
            SET status = 'ended', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (ride_id,))
        conn.commit()

    cursor.execute("SELECT contact_id FROM ride_contacts WHERE ride_id = ?;", (ride_id,))
    c_rows = cursor.fetchall()
    c_ids = [r['contact_id'] for r in c_rows]
    conn.close()

    user_name = row['user_name'] or 'SafeHer User'

    notify(
        event_type='ride_ended',
        user_id=row['user_id'],
        context={
            'user_name': user_name,
            'destination': row['destination'],
            'ride_id': ride_id
        },
        contact_ids=c_ids,
        event_key=f"ride:{ride_id}:ended"
    )

    app_logger.info(f"[RIDE ENDED] ride_id={ride_id}, user_id={row['user_id']}")

    return jsonify({
        "ok": True,
        "message": "Ride completed safely",
        "data": {
            "ride_id": ride_id,
            "status": "ended"
        }
    }), 200


# ─── Route: GET /api/rides/active ──────────────────────────────
@rides_bp.route('/api/rides/active', methods=['GET'])
def get_active_ride():
    """
    Return currently active ride session for authenticated user.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, vehicle_type, vehicle_number, driver_name, driver_phone,
               app_used, pickup, destination, expected_minutes, started_at, expected_end_at,
               status, last_lat, last_lng, last_update_at
        FROM rides
        WHERE user_id = ? AND status = 'active'
        ORDER BY id DESC LIMIT 1;
    ''', (user['id'],))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": True, "data": None}), 200

    cursor.execute('''
        SELECT contact_id, token FROM ride_contacts WHERE ride_id = ?;
    ''', (row['id'],))
    c_rows = cursor.fetchall()
    conn.close()

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens = [{"contact_id": r['contact_id'], "track_url": f"{frontend_url}/track.html?t={r['token']}"} for r in c_rows]

    ride_dict = dict(row)
    ride_dict['tokens'] = tokens

    return jsonify({
        "ok": True,
        "data": ride_dict
    }), 200

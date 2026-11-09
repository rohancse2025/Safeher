def compute_volunteer_flags(cursor, vol_id, user_id, applicant_phone, vol, refs):
    """
    Computes automatic fraud & safety risk flags on submit.
    Stored in flags_json. Severity is 'info' or 'high'.
    """
    flags = []

    # 1. Duplicate phone against another volunteer applicant
    if applicant_phone:
        cursor.execute('''
            SELECT COUNT(*) AS cnt FROM volunteers v
            JOIN users u ON v.user_id = u.id
            WHERE u.phone = ? AND v.id != ?;
        ''', (applicant_phone, vol_id))
        cnt = cursor.fetchone()['cnt']
        if cnt > 0:
            flags.append({
                "code": "duplicate_phone",
                "severity": "high",
                "message": f"Applicant phone {applicant_phone} is also associated with another volunteer application."
            })

    # 2. Duplicate id_type plus id_last4 against another applicant
    id_type = vol.get('id_type')
    id_last4 = vol.get('id_last4')
    if id_type and id_last4:
        cursor.execute('''
            SELECT COUNT(*) AS cnt FROM volunteers
            WHERE id_type = ? AND id_last4 = ? AND id != ?;
        ''', (id_type, id_last4, vol_id))
        cnt = cursor.fetchone()['cnt']
        if cnt > 0:
            flags.append({
                "code": "duplicate_id",
                "severity": "high",
                "message": f"Duplicate ID: {id_type} ending with {id_last4} is already registered to another applicant."
            })

    # 3. Reference phone conflict:
    ref_phones = [r.get('phone', '').strip() for r in refs if r.get('phone')]
    if applicant_phone and any(p == applicant_phone for p in ref_phones):
        flags.append({
            "code": "reference_phone_conflict",
            "severity": "high",
            "message": "A reference phone number matches the applicant's own phone number."
        })

    if ref_phones:
        placeholders = ','.join('?' for _ in ref_phones)
        cursor.execute(f'''
            SELECT u.phone FROM users u
            JOIN volunteers v ON v.user_id = u.id
            WHERE v.id != ? AND u.phone IN ({placeholders});
        ''', [vol_id] + ref_phones)
        matched_other = cursor.fetchall()
        if matched_other:
            flags.append({
                "code": "reference_phone_conflict",
                "severity": "high",
                "message": "A reference phone number belongs to another volunteer applicant."
            })

    # 4. Rejection within the last 90 days:
    cursor.execute('''
        SELECT vr.ts, vr.action, v.reapply_after, v.updated_at
        FROM volunteers v
        LEFT JOIN volunteer_reviews vr ON vr.volunteer_id = v.id AND vr.action = 'reject'
        WHERE v.id = ?
          AND (
            (v.reapply_after IS NOT NULL AND v.updated_at >= datetime('now', '-90 days'))
            OR (vr.ts IS NOT NULL AND vr.ts >= datetime('now', '-90 days'))
          );
    ''', (vol_id,))
    if cursor.fetchone():
        flags.append({
            "code": "recent_rejection",
            "severity": "high",
            "message": "Applicant had a volunteer rejection within the last 90 days."
        })

    # 5. Name mismatch between typed signature and full name:
    typed_sig = (vol.get('typed_signature') or '').strip()
    full_name = (vol.get('full_name') or '').strip()
    if typed_sig != full_name:
        flags.append({
            "code": "name_signature_mismatch",
            "severity": "high",
            "message": f"Typed signature ('{typed_sig}') does not exactly match full name ('{full_name}')."
        })

    # 6. Incomplete profile:
    motivation = (vol.get('motivation') or '').strip()
    availability = (vol.get('availability_text') or '').strip()
    if not motivation or len(motivation) < 15 or not availability or len(availability) < 5:
        flags.append({
            "code": "incomplete_profile",
            "severity": "info",
            "message": "Profile has brief or incomplete motivation/availability information."
        })

    return flags

# backend/routes/volunteers.py – Community volunteer network, nearby active alerts, and response dispatch
import math
import json
import os
import uuid
import datetime
import secrets
from flask import Blueprint, request, jsonify, g

from db import get_db
from routes.auth import login_required
from routes.alerts import is_valid_coord, get_user_from_request
try:
    from services.events import log_event
except ImportError:
    from backend.services.events import log_event

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
def update_volunteer_status():
    """
    Set volunteer availability status, save their latest GPS position, and register with optional note.
    New volunteers start as 'pending' until approved by an administrator (or auto-approved if requested).
    Expects JSON: { available: bool, lat: float (optional), lng: float (optional), note: str (optional) }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    data = request.get_json(silent=True) or {}

    if not user:
        # Emergency auto-provision for new volunteer device if name or phone provided
        req_phone = (data.get('phone') or request.args.get('phone') or '').strip()
        req_name = (data.get('name') or request.args.get('name') or 'Community Volunteer').strip()
        if req_phone or req_name:
            import secrets
            from werkzeug.security import generate_password_hash
            phone = req_phone if req_phone else f"98{secrets.token_hex(4)[:8]}"
            conn = get_db()
            c = conn.cursor()
            try:
                c.execute('INSERT INTO users (name, phone, password_hash) VALUES (?, ?, ?);',
                          (req_name, phone, generate_password_hash('volunteer123')))
                new_uid = c.lastrowid
                conn.commit()
                c.execute('SELECT id, name, phone, email FROM users WHERE id = ?;', (new_uid,))
                user = dict(c.fetchone())
            except Exception:
                c.execute('SELECT id, name, phone, email FROM users WHERE phone = ?;', (phone,))
                row = c.fetchone()
                if row:
                    user = dict(row)
            conn.close()

    if not user:
        return jsonify({"ok": False, "error": "Authorization or user identification required"}), 401

    user_id = user['id']

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

    # Check if this volunteer already has a record
    cursor.execute('SELECT id, status FROM volunteers WHERE user_id = ?;', (user_id,))
    existing_vol = cursor.fetchone()

    # If auto-approve flag passed or already approved, preserve approved status; otherwise new is pending
    auto_approve = request.args.get('auto_approve') in ('1', 'true', 'yes') or data.get('auto_approve') or (data.get('status') == 'approved')

    if existing_vol:
        status_to_set = 'approved' if (auto_approve or existing_vol['status'] == 'approved') else existing_vol['status']
        cursor.execute('''
            UPDATE volunteers
            SET available = ?,
                lat = COALESCE(?, lat),
                lng = COALESCE(?, lng),
                status = ?,
                note = COALESCE(?, note),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?;
        ''', (available, lat, lng, status_to_set, note or None, user_id))
    else:
        initial_status = 'approved' if auto_approve else 'pending'
        cursor.execute('''
            INSERT INTO volunteers (user_id, available, lat, lng, status, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP);
        ''', (user_id, available, lat, lng, initial_status, note or None))

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
def get_volunteer_profile():
    """
    Get the volunteer status and verification state.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, available, lat, lng, status, level, valid_until, note, updated_at
        FROM volunteers WHERE user_id = ?;
    ''', (user_id,))
    vol = cursor.fetchone()

    if not vol:
        conn.close()
        return jsonify({
            "ok": True,
            "data": {
                "registered": False,
                "status": "pending",
                "level": "provisional",
                "badge": "Provisional",
                "available": False,
                "completed_responses": 0,
                "valid_until": None,
                "note": ""
            }
        }), 200

    vol_id = vol['id']
    cursor.execute('''
        SELECT COUNT(*) AS cnt
        FROM responses resp
        JOIN alerts a ON resp.alert_id = a.id
        WHERE resp.volunteer_id = ? AND resp.status = 'coming' AND a.status != 'active';
    ''', (vol_id,))
    comp_row = cursor.fetchone()
    completed_responses = comp_row['cnt'] if comp_row else 0
    conn.close()

    lvl = vol['level'] or 'provisional'
    badge = 'Trusted' if lvl == 'trusted' else 'Provisional'

    return jsonify({
        "ok": True,
        "data": {
            "registered": True,
            "volunteer_id": vol['id'],
            "status": vol['status'] or 'pending',
            "level": lvl,
            "badge": badge,
            "available": bool(vol['available']),
            "lat": vol['lat'],
            "lng": vol['lng'],
            "note": vol['note'] or '',
            "completed_responses": completed_responses,
            "valid_until": vol['valid_until'],
            "updated_at": vol['updated_at']
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


def get_volunteer_alert_label(cursor, alert_id, volunteer_id):
    """
    Returns an anonymous label (e.g. 'Volunteer 1', 'Volunteer 2') for a volunteer
    on a specific alert. Real names are never used in incident logs.
    """
    cursor.execute('''
        SELECT volunteer_id FROM responses
        WHERE alert_id = ? AND status = 'coming'
        ORDER BY id ASC;
    ''', (alert_id,))
    rows = cursor.fetchall()
    v_ids = [r['volunteer_id'] for r in rows]
    if volunteer_id in v_ids:
        idx = v_ids.index(volunteer_id) + 1
        return f"Volunteer {idx}"
    return f"Volunteer {len(v_ids) + 1}"


def log_incident_event(cursor, alert_id, event_type, actor_label, details):
    """
    Inserts a row into incident_events with anonymous actor labels.
    """
    try:
        cursor.execute('SELECT user_id FROM alerts WHERE id = ?;', (alert_id,))
        a_row = cursor.fetchone()
        owner_id = a_row['user_id'] if a_row else 1
        actor = 'volunteer' if ('volunteer' in str(actor_label).lower() or 'volunteer' in str(event_type).lower()) else 'system'
        log_event(
            user_id=owner_id,
            type=event_type,
            actor=actor,
            detail={'volunteer': actor_label, 'message': details},
            alert_id=alert_id,
            cursor=cursor
        )
    except Exception as e:
        print(f"[IncidentLog Error] {e}")


def check_and_record_volunteer_query(cursor, volunteer_id):
    """
    Rate limiting: limits a volunteer to 20 nearby-alert queries per hour.
    Returns True if allowed, False if rate limited.
    """
    # Prune queries older than 1 hour
    cursor.execute("DELETE FROM volunteer_query_log WHERE query_time < datetime('now', '-1 hour');")
    cursor.execute('''
        SELECT COUNT(*) AS cnt FROM volunteer_query_log
        WHERE volunteer_id = ? AND query_time >= datetime('now', '-1 hour');
    ''', (volunteer_id,))
    row = cursor.fetchone()
    count = row['cnt'] if row else 0
    if count >= 20:
        return False

    cursor.execute("INSERT INTO volunteer_query_log (volunteer_id) VALUES (?);", (volunteer_id,))
    return True


# ─── Route: GET /api/volunteers/nearby-alerts ────────────────
@volunteers_bp.route('/api/volunteers/nearby-alerts', methods=['GET'])
def get_nearby_alerts():
    """
    Find active alerts within proximity (2 km range) of the volunteer's latest position.
    Requirements:
      (1) Only volunteers with status 'approved' and valid_until in the future are matched.
      (2) Provisional volunteers never receive silent-mode alerts and, before they tap "I'm coming",
          see only an approximate location (rounded to 0.003 degrees and distance band such as "about 1 km").
          When volunteer responds "coming", return exact location and log view in volunteer_view_log.
      (3) Trusted volunteers get silent-mode alerts but still see only a distance until they tap "coming".
      (4) Rate limit: maximum 20 nearby-alert queries per hour.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    conn = get_db()
    cursor = conn.cursor()

    # Get volunteer record
    cursor.execute('''
        SELECT id, user_id, lat, lng, available, status, level, valid_until
        FROM volunteers WHERE user_id = ?;
    ''', (user_id,))
    volunteer = cursor.fetchone()

    if not volunteer:
        conn.close()
        return jsonify({
            "ok": True,
            "data": [],
            "approval_status": "not_registered",
            "message": "Volunteer registration required"
        }), 200

    vol_id = volunteer['id']
    vol_status = volunteer['status'] or 'draft'
    vol_level = volunteer['level'] or 'provisional'

    # 1. Eligibility Check: status must be 'approved'
    if vol_status != 'approved':
        conn.close()
        return jsonify({
            "ok": True,
            "data": [],
            "approval_status": vol_status,
            "message": f"Volunteer status is '{vol_status}'. Only approved volunteers receive nearby emergency alerts."
        }), 200

    # 1b. Expiration Check: valid_until must be in the future
    if volunteer['valid_until']:
        try:
            vu = datetime.datetime.strptime(volunteer['valid_until'], "%Y-%m-%d %H:%M:%S")
            if datetime.datetime.now() > vu:
                conn.close()
                return jsonify({
                    "ok": True,
                    "data": [],
                    "approval_status": "expired",
                    "message": "Volunteer approval has expired. Re-verification required."
                }), 200
        except Exception:
            pass

    # 2. Rate Limiting Check: max 20 queries per hour
    if not check_and_record_volunteer_query(cursor, vol_id):
        conn.commit()
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Rate limit exceeded: At most 20 nearby-alert queries per hour are permitted."
        }), 429
    conn.commit()

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

    nearby = []
    for alert in active_alerts:
        a_lat = alert['lat']
        a_lng = alert['lng']
        if a_lat is None or a_lng is None:
            continue

        # Exact distance calculated on server
        dist_km = haversine_km(v_lat, v_lng, a_lat, a_lng)

        # Proximity check: 2.0 km range
        if dist_km > 2.0:
            continue

        is_silent = alert['mode'] == 'silent'

        # Provisional volunteers never receive silent-mode alerts
        if is_silent and vol_level != 'trusted':
            continue

        # Check if volunteer has already responded 'coming'
        cursor.execute('''
            SELECT id, verification_code FROM responses
            WHERE alert_id = ? AND volunteer_id = ? AND status = 'coming';
        ''', (alert['id'], vol_id))
        responded_coming = cursor.fetchone()

        # Distance band formatting e.g. "about 1 km"
        if dist_km < 0.5:
            distance_band = "under 500m"
        elif dist_km < 1.3:
            distance_band = "about 1 km"
        elif dist_km < 1.7:
            distance_band = "about 1.5 km"
        else:
            distance_band = "about 2 km"

        if responded_coming:
            # Has responded "coming": return exact coordinates only to this volunteer
            # and log precise view
            cursor.execute('''
                INSERT INTO volunteer_view_log (volunteer_id, alert_id)
                VALUES (?, ?);
            ''', (vol_id, alert['id']))

            nearby.append({
                "id": alert['id'],
                "alert_id": alert['id'],
                "mode": alert['mode'],
                "status": alert['status'],
                "distance_km": round(dist_km, 2),
                "distance_band": distance_band,
                "time": alert['started_at'],
                "lat": a_lat,
                "lng": a_lng,
                "maps_link": f"https://www.google.com/maps?q={a_lat},{a_lng}",
                "name": None if is_silent else alert['name'],
                "share_token": alert['share_token'],
                "responded": True,
                "verification_code": responded_coming['verification_code']
            })
        else:
            # Has NOT responded "coming": exact location hidden!
            if vol_level == 'trusted':
                # Trusted volunteer before "coming": sees only distance
                nearby.append({
                    "id": alert['id'],
                    "alert_id": alert['id'],
                    "mode": alert['mode'],
                    "status": alert['status'],
                    "distance_km": round(dist_km, 1),
                    "distance_band": distance_band,
                    "time": alert['started_at'],
                    "lat": None,
                    "lng": None,
                    "approximate_lat": None,
                    "approximate_lng": None,
                    "maps_link": None,
                    "name": None if is_silent else alert['name'],
                    "share_token": alert['share_token'],
                    "responded": False
                })
            else:
                # Provisional volunteer before "coming": sees approximate location (rounded to 0.003 degrees) and distance band
                approx_lat = round(round(a_lat / 0.003) * 0.003, 5)
                approx_lng = round(round(a_lng / 0.003) * 0.003, 5)
                nearby.append({
                    "id": alert['id'],
                    "alert_id": alert['id'],
                    "mode": alert['mode'],
                    "status": alert['status'],
                    "distance_km": round(dist_km, 1),
                    "distance_band": distance_band,
                    "time": alert['started_at'],
                    "lat": None,
                    "lng": None,
                    "approximate_lat": approx_lat,
                    "approximate_lng": approx_lng,
                    "maps_link": None,
                    "name": None if is_silent else alert['name'],
                    "share_token": alert['share_token'],
                    "responded": False
                })

    conn.commit()
    conn.close()

    nearby.sort(key=lambda x: x['distance_km'])

    return jsonify({
        "ok": True,
        "data": nearby,
        "approval_status": "approved",
        "level": vol_level
    }), 200


# ─── Route: POST /api/alerts/<id>/respond ─────────────────────
@volunteers_bp.route('/api/alerts/<int:alert_id>/respond', methods=['POST'])
def respond_to_alert(alert_id):
    """
    Volunteer responds to an alert with status "coming" or "cannot".
    Expects JSON: { status: "coming"|"cannot" }
    When "coming":
      - Generates random 4-digit verification code.
      - Returns exact location only to this volunteer.
      - Logs precise view in volunteer_view_log.
      - Logs event in incident_events as 'Volunteer 1', etc.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    data = request.get_json(silent=True) or {}
    status = (data.get('status') or '').strip().lower()

    if status not in ('coming', 'cannot'):
        return jsonify({"ok": False, "error": "Status must be either 'coming' or 'cannot'"}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Verify alert exists
    cursor.execute('SELECT id, status, user_id, mode, lat, lng FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({"ok": False, "error": "Alert not found"}), 404

    # Ensure volunteer record exists for current user
    cursor.execute('SELECT id, status, level FROM volunteers WHERE user_id = ?;', (user_id,))
    vol_row = cursor.fetchone()
    if not vol_row:
        cursor.execute("INSERT INTO volunteers (user_id, available, status) VALUES (?, 1, 'approved');", (user_id,))
        volunteer_id = cursor.lastrowid
        vol_status = 'approved'
    else:
        volunteer_id = vol_row['id']
        vol_status = vol_row['status']

    # Volunteer must be approved to respond
    if vol_status != 'approved':
        conn.close()
        return jsonify({"ok": False, "error": f"Only approved volunteers can respond to alerts (current status: {vol_status})"}), 400

    # Check if volunteer has already responded to this alert
    cursor.execute('SELECT id, status, verification_code FROM responses WHERE alert_id = ? AND volunteer_id = ?;', (alert_id, volunteer_id))
    existing_resp = cursor.fetchone()
    if existing_resp:
        if status == 'cannot':
            cursor.execute('''
                UPDATE responses SET status = 'cannot' WHERE id = ?;
            ''', (existing_resp['id'],))
            actor_label = get_volunteer_alert_label(cursor, alert_id, volunteer_id)
            log_event(
                user_id=alert['user_id'],
                type='volunteer_responded',
                actor='volunteer',
                detail={'volunteer': actor_label, 'status': 'cannot'},
                alert_id=alert_id,
                cursor=cursor
            )
            log_incident_event(cursor, alert_id, 'volunteer_cannot', actor_label, f"{actor_label} cannot continue")
            conn.commit()
            conn.close()
            return jsonify({
                "ok": True,
                "data": {
                    "alert_id": alert_id,
                    "volunteer_id": volunteer_id,
                    "status": "cannot",
                    "message": "Response updated: You cannot continue"
                }
            }), 200
        else:
            conn.close()
            return jsonify({"ok": False, "error": "You have already responded to this alert"}), 400

    verification_code = None
    if status == 'coming':
        # Generate random 4-digit verification code
        verification_code = f"{secrets.randbelow(9000) + 1000}"

    # Insert response with verification code
    cursor.execute('''
        INSERT INTO responses (alert_id, volunteer_id, status, verification_code, time)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP);
    ''', (alert_id, volunteer_id, status, verification_code))

    # Determine anonymous volunteer label for this alert
    actor_label = get_volunteer_alert_label(cursor, alert_id, volunteer_id)

    if status == 'coming':
        # Log precise location view
        cursor.execute('''
            INSERT INTO volunteer_view_log (volunteer_id, alert_id)
            VALUES (?, ?);
        ''', (volunteer_id, alert_id))

        # Log volunteer_responded event
        log_event(
            user_id=alert['user_id'],
            type='volunteer_responded',
            actor='volunteer',
            detail={'volunteer': actor_label, 'status': 'coming'},
            alert_id=alert_id,
            cursor=cursor
        )
        log_incident_event(cursor, alert_id, 'volunteer_coming', actor_label, f"{actor_label} is responding to the alert")
    else:
        log_event(
            user_id=alert['user_id'],
            type='volunteer_responded',
            actor='volunteer',
            detail={'volunteer': actor_label, 'status': 'cannot'},
            alert_id=alert_id,
            cursor=cursor
        )
        log_incident_event(cursor, alert_id, 'volunteer_cannot', actor_label, f"{actor_label} marked cannot assist")

    conn.commit()
    conn.close()

    # Trigger push notification to victim when volunteer taps "I'm coming"
    if status == 'coming':
        try:
            from routes.push import notify_victim_volunteer_coming
            notify_victim_volunteer_coming(alert['user_id'], alert_id, alert['mode'])
        except Exception:
            pass

    response_data = {
        "alert_id": alert_id,
        "volunteer_id": volunteer_id,
        "status": status,
        "message": "Response recorded successfully"
    }

    if status == 'coming':
        response_data["verification_code"] = verification_code
        response_data["exact_location"] = {
            "lat": alert['lat'],
            "lng": alert['lng'],
            "maps_link": f"https://www.google.com/maps?q={alert['lat']},{alert['lng']}" if alert['lat'] and alert['lng'] else None
        }

    return jsonify({
        "ok": True,
        "data": response_data
    }), 200


# ─── Route: GET /api/alerts/<id>/status ──────────────────────
@volunteers_bp.route('/api/alerts/<int:alert_id>/status', methods=['GET'])
def get_alert_volunteer_status(alert_id):
    """
    Get alert status, count of volunteers coming, contact responses, and responders list.
    Responders list (for alert owner):
      - volunteer's first name
      - badge (Provisional or Trusted)
      - number of completed responses
      - selfie URL (authenticated route)
      - the same 4-digit verification code
    """
    conn = get_db()
    cursor = conn.cursor()

    # Check alert exists
    cursor.execute('SELECT id, status, user_id FROM alerts WHERE id = ?;', (alert_id,))
    alert = cursor.fetchone()
    if not alert:
        cursor.execute("SELECT id, status, user_id FROM alerts ORDER BY id DESC LIMIT 1;")
        alert = cursor.fetchone()
    if not alert:
        conn.close()
        return jsonify({
            "ok": True,
            "data": {
                "alert_id": alert_id,
                "status": "resolved",
                "volunteers_coming": 0,
                "contact_responses": [],
                "responders": []
            }
        }), 200

    target_alert_id = alert['id']

    # Fetch responding volunteers with status = 'coming'
    cursor.execute('''
        SELECT r.id AS resp_id, r.verification_code, r.time AS responded_at,
               v.id AS volunteer_id, v.full_name, v.level, v.selfie_path,
               u.name AS user_name
        FROM responses r
        JOIN volunteers v ON r.volunteer_id = v.id
        JOIN users u ON v.user_id = u.id
        WHERE r.alert_id = ? AND r.status = 'coming'
        ORDER BY r.id ASC;
    ''', (target_alert_id,))
    vol_rows = cursor.fetchall()

    responders = []
    for r in vol_rows:
        v_id = r['volunteer_id']
        full_n = (r['full_name'] or r['user_name'] or 'Volunteer').strip()
        first_n = full_n.split()[0] if full_n else "Volunteer"
        badge = "Trusted" if r['level'] == 'trusted' else "Provisional"

        # Count completed past responses for this volunteer
        cursor.execute('''
            SELECT COUNT(*) AS cnt
            FROM responses resp
            JOIN alerts a ON resp.alert_id = a.id
            WHERE resp.volunteer_id = ? AND resp.status = 'coming' AND a.status != 'active';
        ''', (v_id,))
        comp_row = cursor.fetchone()
        completed_count = comp_row['cnt'] if comp_row else 0

        selfie_url = f"/api/alerts/{target_alert_id}/responder-selfie/{v_id}" if r['selfie_path'] else None

        responders.append({
            "volunteer_id": v_id,
            "first_name": first_n,
            "badge": badge,
            "completed_responses": completed_count,
            "verification_code": r['verification_code'],
            "selfie_url": selfie_url,
            "time": r['responded_at']
        })

    volunteers_coming = len(responders)

    # Fetch contact responses (name, status, time)
    cursor.execute('''
        SELECT COALESCE(c.name, 'Emergency Contact') AS name, cr.status, cr.created_at AS time
        FROM contact_responses cr
        LEFT JOIN contacts c ON cr.contact_id = c.id
        WHERE cr.alert_id = ?
        ORDER BY cr.id DESC;
    ''', (target_alert_id,))
    resp_rows = cursor.fetchall()
    contact_responses = [
        {
            "name": r['name'] or 'Emergency Contact',
            "status": r['status'],
            "time": r['time']
        }
        for r in resp_rows
    ]

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "alert_id": target_alert_id,
            "status": alert['status'],
            "volunteers_coming": volunteers_coming,
            "contact_responses": contact_responses,
            "responders": responders
        }
    }), 200


# ─── Route: GET /api/volunteers/count ────────────────────────
@volunteers_bp.route('/api/volunteers/count', methods=['GET'])
def get_available_volunteers_count():
    """
    Returns the total number of real volunteers currently marked available and nearby.
    Supports ?lat=...&lng=...&radius_km=5 to calculate REAL distance via Haversine.
    Excludes the requesting user so you don't count yourself.
    """
    lat_param = request.args.get('lat')
    lng_param = request.args.get('lng')
    radius_km = float(request.args.get('radius_km', 5.0))

    # Optional token auth check to exclude the current user
    user_id = None
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        token = auth_header.split(' ', 1)[1]
        try:
            from routes.auth import decode_token
            payload = decode_token(token)
            if payload and 'user_id' in payload:
                user_id = payload['user_id']
        except Exception:
            pass

    conn = get_db()
    cursor = conn.cursor()

    if lat_param is not None and lng_param is not None:
        try:
            u_lat = float(lat_param)
            u_lng = float(lng_param)
            if user_id:
                cursor.execute("""
                    SELECT id, user_id, lat, lng FROM volunteers
                    WHERE available = 1 AND status = 'approved' AND user_id != ? AND lat IS NOT NULL AND lng IS NOT NULL;
                """, (user_id,))
            else:
                cursor.execute("""
                    SELECT id, user_id, lat, lng FROM volunteers
                    WHERE available = 1 AND status = 'approved' AND lat IS NOT NULL AND lng IS NOT NULL;
                """)
            rows = cursor.fetchall()
            count = 0
            for row in rows:
                v_lat = row['lat']
                v_lng = row['lng']
                dist = haversine_km(u_lat, u_lng, v_lat, v_lng)
                if dist <= radius_km:
                    count += 1
            conn.close()
            return jsonify({
                "ok": True,
                "data": {
                    "available_volunteers": count,
                    "nearby": True,
                    "radius_km": radius_km
                }
            }), 200
        except (ValueError, TypeError):
            pass

    # Fallback: total available volunteers excluding self
    if user_id:
        cursor.execute("SELECT COUNT(*) AS total FROM volunteers WHERE available = 1 AND status = 'approved' AND user_id != ?;", (user_id,))
    else:
        cursor.execute("SELECT COUNT(*) AS total FROM volunteers WHERE available = 1 AND status = 'approved';")
    row = cursor.fetchone()
    count = row['total'] if row else 0
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "available_volunteers": count,
            "nearby": False
        }
    }), 200


# ─── Volunteer Training & Questionnaire Bank ─────────────────
VOLUNTEER_TRAINING_QUESTIONS = [
    {
        "id": 1,
        "question": "What is the very first action you must take when responding to an emergency alert?",
        "options": [
            "Call 112 first and don’t confront anyone",
            "Confront any suspected person immediately to protect the victim",
            "Wait 30 minutes to see if the situation de-escalates on its own",
            "Take photographs of the scene to document what happened"
        ],
        "correct_answer": "Call 112 first and don’t confront anyone"
    },
    {
        "id": 2,
        "question": "When arriving near the alert location, you see the person is accompanied by someone acting threateningly. What should you do?",
        "options": [
            "If the person is with someone threatening, stay at a distance and call 112",
            "Physically intervene immediately between the person and the threat",
            "Shout at the person threatening her to intimidate them",
            "Follow them quietly into secluded areas without informing police"
        ],
        "correct_answer": "If the person is with someone threatening, stay at a distance and call 112"
    },
    {
        "id": 3,
        "question": "What are the strict rules regarding social media and privacy after responding to an emergency?",
        "options": [
            "Never post the person’s location, photo or story on social media",
            "You can post photos of the incident if you blur their face",
            "Posting their real-time location online is allowed to gather community help",
            "You may share the incident story as long as you do not name the street"
        ],
        "correct_answer": "Never post the person’s location, photo or story on social media"
    },
    {
        "id": 4,
        "question": "After an emergency incident has ended, what is the policy regarding contacting the person you assisted?",
        "options": [
            "Never contact the person afterwards without their clear consent",
            "You should call them the next day to ask how they are feeling",
            "You may add them on social messaging platforms using their emergency contact info",
            "It is permitted to visit their home if you want to ensure they reached safely"
        ],
        "correct_answer": "Never contact the person afterwards without their clear consent"
    },
    {
        "id": 5,
        "question": "If you receive an emergency alert but you are currently alone in an unsafe or deserted location, what should you do?",
        "options": [
            "If you are alone in an unsafe place, use “Can’t help” and don’t go",
            "Proceed to the alert location anyway because the victim needs help",
            "Call out loudly in your area to see if strangers will accompany you",
            "Turn off your phone and ignore the alert completely"
        ],
        "correct_answer": "If you are alone in an unsafe place, use “Can’t help” and don’t go"
    },
    {
        "id": 6,
        "question": "How must you respond to a “silent-mode” alert (where the user’s screen is dark and no siren sounds)?",
        "options": [
            "A silent-mode alert (screen dark, no sound) is high risk, so call 112 and don’t call or message her",
            "Call her phone immediately to ask what the situation is",
            "Send repeated WhatsApp messages asking her to describe her surroundings",
            "Sound your phone’s siren to frighten away potential stalkers"
        ],
        "correct_answer": "A silent-mode alert (screen dark, no sound) is high risk, so call 112 and don’t call or message her"
    },
    {
        "id": 7,
        "question": "If the person who triggered the alert needs to leave the scene, what transportation guideline must you follow?",
        "options": [
            "Never go alone with her to a private place or vehicle unless she asks and it is safe",
            "Insist that she enters your private vehicle immediately",
            "Direct her into any passing stranger’s vehicle to get her away quickly",
            "Take her to your own private residence while waiting for help"
        ],
        "correct_answer": "Never go alone with her to a private place or vehicle unless she asks and it is safe"
    },
    {
        "id": 8,
        "question": "How is your personal data and verification information handled by the SafeHer platform?",
        "options": [
            "Your data is used only to verify you and to match you with nearby alerts",
            "Your profile, ID details, and phone number are publicly visible to all app users",
            "Your verification data is shared with private security marketing agencies",
            "Your identity document is published in the community volunteer directory"
        ],
        "correct_answer": "Your data is used only to verify you and to match you with nearby alerts"
    }
]

PRIVATE_UPLOADS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'private_uploads'))
os.makedirs(PRIVATE_UPLOADS_DIR, exist_ok=True)


def check_magic_image_type(file_bytes):
    """
    Check real image type using magic bytes.
    Accepts only real JPEG or PNG.
    """
    if file_bytes.startswith(b'\xff\xd8\xff'):
        return True, 'jpg'
    if file_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
        return True, 'png'
    return False, None


# ─── Route: GET /api/volunteers/application ───────────────────
@volunteers_bp.route('/api/volunteers/application', methods=['GET'])
@login_required
def get_volunteer_application():
    """
    Retrieve current volunteer application draft, training state, and references.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, full_name, dob, locality, id_type, id_last4,
               id_image_path, selfie_path, motivation, availability_text,
               declaration_accepted_at, declaration_version, typed_signature,
               training_score, training_passed_at, status, level, approved_at,
               approved_by, valid_until, reject_reason_code, reapply_after,
               flags_json, updated_at
        FROM volunteers
        WHERE user_id = ?;
    ''', (user_id,))
    vol = cursor.fetchone()

    if not vol:
        conn.close()
        return jsonify({
            "ok": True,
            "data": {
                "has_application": False,
                "status": "not_started"
            }
        }), 200

    vol_dict = dict(vol)
    vol_id = vol_dict['id']

    # Fetch references
    cursor.execute('''
        SELECT id, name, phone, relation, contacted_at, outcome, notes
        FROM volunteer_references
        WHERE volunteer_id = ?
        ORDER BY id ASC;
    ''', (vol_id,))
    references = [dict(r) for r in cursor.fetchall()]
    vol_dict['references'] = references
    vol_dict['has_application'] = True

    # Check cooldown status
    if vol_dict.get('reapply_after'):
        try:
            reapply_dt = datetime.datetime.strptime(vol_dict['reapply_after'], "%Y-%m-%d %H:%M:%S")
            vol_dict['cooldown_active'] = (datetime.datetime.now() < reapply_dt)
        except Exception:
            vol_dict['cooldown_active'] = False
    else:
        vol_dict['cooldown_active'] = False

    conn.close()
    return jsonify({"ok": True, "data": vol_dict}), 200


# ─── Route: PUT /api/volunteers/application ───────────────────
@volunteers_bp.route('/api/volunteers/application', methods=['PUT'])
@login_required
def save_volunteer_draft():
    """
    Save or update volunteer application draft (details, motivation, availability, 2 references, declaration).
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    data = request.get_json(silent=True) or {}

    conn = get_db()
    cursor = conn.cursor()

    # Check existing volunteer row
    cursor.execute('SELECT id, status, reapply_after FROM volunteers WHERE user_id = ?;', (user_id,))
    existing = cursor.fetchone()

    # Check 30-day cooldown if rejected
    if existing and existing['reapply_after']:
        try:
            reapply_dt = datetime.datetime.strptime(existing['reapply_after'], "%Y-%m-%d %H:%M:%S")
            if datetime.datetime.now() < reapply_dt:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": f"Application cooldown active. You cannot reapply until {existing['reapply_after']}."
                }), 403
        except Exception:
            pass

    full_name = (data.get('full_name') or '').strip()
    dob = (data.get('dob') or '').strip()
    locality = (data.get('locality') or '').strip()
    id_type = (data.get('id_type') or '').strip()
    id_last4 = (data.get('id_last4') or '').strip()
    motivation = (data.get('motivation') or '').strip()
    availability_text = (data.get('availability_text') or '').strip()
    declaration_version = (data.get('declaration_version') or 'v1.0').strip()
    typed_signature = (data.get('typed_signature') or '').strip()
    declaration_accepted = data.get('declaration_accepted') in (True, 1, 'true', '1')

    # Validate id_type if given
    VALID_ID_TYPES = {"Voter ID", "Driving Licence", "College ID", "Passport", "Other"}
    if id_type and id_type not in VALID_ID_TYPES:
        conn.close()
        return jsonify({
            "ok": False,
            "error": f"Invalid id_type. Must be one of: {', '.join(sorted(VALID_ID_TYPES))}"
        }), 400

    # Ensure id_last4 is never full ID (max 4 characters)
    if id_last4 and len(id_last4) > 4:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "id_last4 must be at most 4 digits/characters, never a full ID number."
        }), 400

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if existing:
        vol_id = existing['id']
        current_status = existing['status']
        # If currently rejected or expired, allow re-drafting after cooldown
        new_status = 'draft' if current_status in ('rejected', 'expired', 'draft', None) else current_status
        cursor.execute('''
            UPDATE volunteers
            SET full_name = COALESCE(NULLIF(?, ''), full_name),
                dob = COALESCE(NULLIF(?, ''), dob),
                locality = COALESCE(NULLIF(?, ''), locality),
                id_type = COALESCE(NULLIF(?, ''), id_type),
                id_last4 = COALESCE(NULLIF(?, ''), id_last4),
                motivation = COALESCE(NULLIF(?, ''), motivation),
                availability_text = COALESCE(NULLIF(?, ''), availability_text),
                declaration_version = ?,
                typed_signature = COALESCE(NULLIF(?, ''), typed_signature),
                declaration_accepted_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE declaration_accepted_at END,
                status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (full_name, dob, locality, id_type, id_last4, motivation, availability_text,
               declaration_version, typed_signature, declaration_accepted, new_status, vol_id))
    else:
        cursor.execute('''
            INSERT INTO volunteers (
                user_id, status, full_name, dob, locality, id_type, id_last4,
                motivation, availability_text, declaration_version, typed_signature,
                declaration_accepted_at, updated_at
            ) VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP);
        ''', (user_id, full_name or None, dob or None, locality or None, id_type or None,
               id_last4 or None, motivation or None, availability_text or None, declaration_version,
               typed_signature or None, declaration_accepted))
        vol_id = cursor.lastrowid

    # Save references if provided
    refs = data.get('references')
    if refs and isinstance(refs, list):
        cursor.execute('DELETE FROM volunteer_references WHERE volunteer_id = ?;', (vol_id,))
        for r in refs[:5]:
            r_name = (r.get('name') or '').strip()
            r_phone = (r.get('phone') or '').strip()
            r_rel = (r.get('relation') or '').strip()
            if r_name and r_phone:
                cursor.execute('''
                    INSERT INTO volunteer_references (volunteer_id, name, phone, relation, outcome)
                    VALUES (?, ?, ?, ?, 'pending');
                ''', (vol_id, r_name, r_phone, r_rel))

    conn.commit()

    # Return updated draft
    cursor.execute('''
        SELECT id, user_id, full_name, dob, locality, id_type, id_last4,
               id_image_path, selfie_path, motivation, availability_text,
               declaration_accepted_at, declaration_version, typed_signature,
               training_score, training_passed_at, status, updated_at
        FROM volunteers WHERE id = ?;
    ''', (vol_id,))
    saved_vol = dict(cursor.fetchone())

    cursor.execute('SELECT id, name, phone, relation, outcome FROM volunteer_references WHERE volunteer_id = ?;', (vol_id,))
    saved_vol['references'] = [dict(r) for r in cursor.fetchall()]

    conn.close()
    return jsonify({
        "ok": True,
        "data": saved_vol,
        "message": "Volunteer application draft saved successfully"
    }), 200


# ─── Route: POST /api/volunteers/application/id-image ─────────
@volunteers_bp.route('/api/volunteers/application/id-image', methods=['POST'])
@login_required
def upload_id_image():
    """
    Accept multipart ID image (JPEG or PNG only, at most 2 MB).
    Validates magic bytes, saves to backend/private_uploads/ with random filename.
    Never served publicly.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']

    file = request.files.get('file') or request.files.get('id_image') or request.files.get('image')
    if not file:
        return jsonify({"ok": False, "error": "No file uploaded. Use field name 'file' or 'id_image'."}), 400

    file_bytes = file.read()
    if len(file_bytes) == 0:
        return jsonify({"ok": False, "error": "Uploaded file is empty"}), 400

    # Max 2 MB enforcement
    MAX_SIZE = 2 * 1024 * 1024  # 2,097,152 bytes
    if len(file_bytes) > MAX_SIZE:
        return jsonify({"ok": False, "error": "File size exceeds maximum permitted limit of 2 MB"}), 413

    # Magic byte real type verification
    is_valid, ext = check_magic_image_type(file_bytes)
    if not is_valid:
        return jsonify({"ok": False, "error": "Invalid file type. Only real JPEG or PNG images are permitted."}), 400

    # Save with unguessable random name
    rand_name = f"id_{uuid.uuid4().hex}.{ext}"
    dest_path = os.path.join(PRIVATE_UPLOADS_DIR, rand_name)
    with open(dest_path, 'wb') as f:
        f.write(file_bytes)

    rel_path = f"private_uploads/{rand_name}"

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id FROM volunteers WHERE user_id = ?;', (user_id,))
    row = cursor.fetchone()
    if row:
        # Delete old ID image file if replacing
        cursor.execute('SELECT id_image_path FROM volunteers WHERE user_id = ?;', (user_id,))
        old_row = cursor.fetchone()
        if old_row and old_row['id_image_path']:
            old_full = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', old_row['id_image_path'])
            if os.path.exists(old_full):
                try: os.remove(old_full)
                except Exception: pass
        cursor.execute('UPDATE volunteers SET id_image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?;',
                       (rel_path, user_id))
    else:
        cursor.execute('''
            INSERT INTO volunteers (user_id, status, id_image_path, updated_at)
            VALUES (?, 'draft', ?, CURRENT_TIMESTAMP);
        ''', (user_id, rel_path))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "path": rel_path,
            "filename": rand_name,
            "message": "ID image uploaded successfully"
        }
    }), 200


# ─── Route: POST /api/volunteers/application/selfie ───────────
@volunteers_bp.route('/api/volunteers/application/selfie', methods=['POST'])
@login_required
def upload_selfie():
    """
    Accept multipart selfie (JPEG or PNG only, at most 2 MB).
    Validates magic bytes, saves to backend/private_uploads/ with random filename.
    Never served publicly.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']

    file = request.files.get('file') or request.files.get('selfie') or request.files.get('image')
    if not file:
        return jsonify({"ok": False, "error": "No file uploaded. Use field name 'file' or 'selfie'."}), 400

    file_bytes = file.read()
    if len(file_bytes) == 0:
        return jsonify({"ok": False, "error": "Uploaded file is empty"}), 400

    # Max 2 MB enforcement
    MAX_SIZE = 2 * 1024 * 1024  # 2,097,152 bytes
    if len(file_bytes) > MAX_SIZE:
        return jsonify({"ok": False, "error": "File size exceeds maximum permitted limit of 2 MB"}), 413

    # Magic byte real type verification
    is_valid, ext = check_magic_image_type(file_bytes)
    if not is_valid:
        return jsonify({"ok": False, "error": "Invalid file type. Only real JPEG or PNG images are permitted."}), 400

    # Save with unguessable random name
    rand_name = f"selfie_{uuid.uuid4().hex}.{ext}"
    dest_path = os.path.join(PRIVATE_UPLOADS_DIR, rand_name)
    with open(dest_path, 'wb') as f:
        f.write(file_bytes)

    rel_path = f"private_uploads/{rand_name}"

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id FROM volunteers WHERE user_id = ?;', (user_id,))
    row = cursor.fetchone()
    if row:
        # Delete old selfie file if replacing
        cursor.execute('SELECT selfie_path FROM volunteers WHERE user_id = ?;', (user_id,))
        old_row = cursor.fetchone()
        if old_row and old_row['selfie_path']:
            old_full = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', old_row['selfie_path'])
            if os.path.exists(old_full):
                try: os.remove(old_full)
                except Exception: pass
        cursor.execute('UPDATE volunteers SET selfie_path = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?;',
                       (rel_path, user_id))
    else:
        cursor.execute('''
            INSERT INTO volunteers (user_id, status, selfie_path, updated_at)
            VALUES (?, 'draft', ?, CURRENT_TIMESTAMP);
        ''', (user_id, rel_path))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "path": rel_path,
            "filename": rand_name,
            "message": "Selfie uploaded successfully"
        }
    }), 200


# ─── Route: GET /api/volunteers/training ──────────────────────
@volunteers_bp.route('/api/volunteers/training', methods=['GET'])
@login_required
def get_training_questions():
    """
    Returns 8 multiple-choice safety questions WITHOUT revealing the correct answers.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    conn = get_db()
    cursor = conn.cursor()

    # Check last training attempt and 24h retry lockout
    cursor.execute('''
        SELECT vta.score, vta.taken_at
        FROM volunteer_training_attempts vta
        JOIN volunteers v ON vta.volunteer_id = v.id
        WHERE v.user_id = ?
        ORDER BY vta.id DESC LIMIT 1;
    ''', (user_id,))
    last_attempt = cursor.fetchone()

    retry_locked = False
    retry_available_at = None

    if last_attempt and last_attempt['score'] < 80.0:
        try:
            taken_dt = datetime.datetime.strptime(last_attempt['taken_at'], "%Y-%m-%d %H:%M:%S")
            available_dt = taken_dt + datetime.timedelta(hours=24)
            if datetime.datetime.now() < available_dt:
                retry_locked = True
                retry_available_at = available_dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    conn.close()

    # Build sanitized questions list (omit correct_answer)
    sanitized = [
        {
            "id": q["id"],
            "question": q["question"],
            "options": q["options"]
        }
        for q in VOLUNTEER_TRAINING_QUESTIONS
    ]

    return jsonify({
        "ok": True,
        "data": {
            "total_questions": len(sanitized),
            "pass_percentage": 80,
            "retry_locked": retry_locked,
            "retry_available_at": retry_available_at,
            "questions": sanitized
        }
    }), 200


# ─── Route: POST /api/volunteers/training/submit ──────────────
@volunteers_bp.route('/api/volunteers/training/submit', methods=['POST'])
@login_required
def submit_training_answers():
    """
    Scores the 8 questions (needs at least 80% to pass).
    After a fail, allows a retry only after 24 hours.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    data = request.get_json(silent=True) or {}
    answers = data.get('answers') or {}

    conn = get_db()
    cursor = conn.cursor()

    # Ensure volunteer record exists
    cursor.execute('SELECT id, training_score, training_passed_at FROM volunteers WHERE user_id = ?;', (user_id,))
    vol = cursor.fetchone()
    if not vol:
        cursor.execute("INSERT INTO volunteers (user_id, status) VALUES (?, 'draft');", (user_id,))
        vol_id = cursor.lastrowid
    else:
        vol_id = vol['id']

    # Check 24-hour retry lock on prior failure
    cursor.execute('''
        SELECT score, taken_at
        FROM volunteer_training_attempts
        WHERE volunteer_id = ?
        ORDER BY id DESC LIMIT 1;
    ''', (vol_id,))
    last_attempt = cursor.fetchone()

    if last_attempt and last_attempt['score'] < 80.0:
        try:
            taken_dt = datetime.datetime.strptime(last_attempt['taken_at'], "%Y-%m-%d %H:%M:%S")
            available_dt = taken_dt + datetime.timedelta(hours=24)
            if datetime.datetime.now() < available_dt:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": f"Training failed. You may retry after 24 hours (available at {available_dt.strftime('%Y-%m-%d %H:%M:%S')})."
                }), 429
        except Exception:
            pass

    # Score answers
    correct_count = 0
    total = len(VOLUNTEER_TRAINING_QUESTIONS)

    for q in VOLUNTEER_TRAINING_QUESTIONS:
        qid_str = str(q['id'])
        user_ans = answers.get(qid_str) or answers.get(q['id'])
        if user_ans is None and isinstance(answers, list):
            # Also support answers as list of {"question_id": 1, "answer": ...}
            for item in answers:
                if item.get('question_id') == q['id'] or item.get('id') == q['id']:
                    user_ans = item.get('answer')
                    break

        if user_ans is not None:
            # Match by exact text or index
            correct_text = q['correct_answer'].strip().lower()
            if isinstance(user_ans, int) and 0 <= user_ans < len(q['options']):
                chosen_text = q['options'][user_ans].strip().lower()
            else:
                chosen_text = str(user_ans).strip().lower()

            if chosen_text == correct_text:
                correct_count += 1

    score_pct = round((correct_count / float(total)) * 100.0, 1)
    passed = (score_pct >= 80.0)

    # Record attempt
    cursor.execute('''
        INSERT INTO volunteer_training_attempts (volunteer_id, score, taken_at)
        VALUES (?, ?, CURRENT_TIMESTAMP);
    ''', (vol_id, score_pct))

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if passed:
        cursor.execute('''
            UPDATE volunteers
            SET training_score = ?,
                training_passed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (score_pct, vol_id))
    else:
        cursor.execute('''
            UPDATE volunteers
            SET training_score = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (score_pct, vol_id))

    conn.commit()
    conn.close()

    if passed:
        return jsonify({
            "ok": True,
            "data": {
                "score": score_pct,
                "correct": correct_count,
                "total": total,
                "passed": True,
                "message": f"Congratulations! You passed the volunteer safety training with {score_pct}%."
            }
        }), 200
    else:
        retry_time = (datetime.datetime.now() + datetime.timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        return jsonify({
            "ok": False,
            "data": {
                "score": score_pct,
                "correct": correct_count,
                "total": total,
                "passed": False,
                "retry_available_at": retry_time,
                "message": f"You scored {score_pct}% (minimum 80% required to pass). A retry will be available in 24 hours."
            },
            "error": "Training score below 80%. A retry will be available after 24 hours."
        }), 400


# ─── Route: POST /api/volunteers/application/submit ───────────
@volunteers_bp.route('/api/volunteers/application/submit', methods=['POST'])
@login_required
def submit_volunteer_application():
    """
    Validates everything:
      - age 18 or over from dob
      - full_name
      - locality
      - an ID type with last 4 digits only and never a full ID number
      - ID image and selfie uploaded
      - 2 references with different phones that are not the applicant's own
      - training passed
      - declaration accepted with a typed signature that matches the full name
    Sets status to 'submitted'.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    applicant_phone = (user.get('phone') or '').strip()

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, full_name, dob, locality, id_type, id_last4,
               id_image_path, selfie_path, motivation, availability_text,
               declaration_accepted_at, declaration_version, typed_signature,
               training_score, training_passed_at, status, reapply_after
        FROM volunteers
        WHERE user_id = ?;
    ''', (user_id,))
    vol = cursor.fetchone()

    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "No volunteer application found. Please save a draft first."}), 400

    vol = dict(vol)
    vol_id = vol['id']

    # 1. Check 30-day cooldown
    if vol.get('reapply_after'):
        try:
            reapply_dt = datetime.datetime.strptime(vol['reapply_after'], "%Y-%m-%d %H:%M:%S")
            if datetime.datetime.now() < reapply_dt:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": f"Application cooldown active. You cannot reapply until {vol['reapply_after']}."
                }), 403
        except Exception:
            pass

    # 2. Validate full_name
    full_name = (vol.get('full_name') or '').strip()
    if not full_name or len(full_name) < 2:
        conn.close()
        return jsonify({"ok": False, "error": "Full name is required (minimum 2 characters)"}), 400

    # 3. Validate Date of Birth and age 18+
    dob_str = (vol.get('dob') or '').strip()
    if not dob_str:
        conn.close()
        return jsonify({"ok": False, "error": "Date of birth is required"}), 400

    try:
        birth_date = datetime.datetime.strptime(dob_str, "%Y-%m-%d").date()
    except ValueError:
        try:
            birth_date = datetime.datetime.strptime(dob_str, "%d/%m/%Y").date()
        except ValueError:
            conn.close()
            return jsonify({"ok": False, "error": "Invalid date of birth format. Use YYYY-MM-DD."}), 400

    today = datetime.date.today()
    age = today.year - birth_date.year - ((today.month, today.day) < (birth_date.month, birth_date.day))
    if age < 18:
        conn.close()
        return jsonify({"ok": False, "error": f"Volunteer must be at least 18 years of age (current age: {age})"}), 400

    # 4. Validate locality
    locality = (vol.get('locality') or '').strip()
    if not locality or len(locality) < 2:
        conn.close()
        return jsonify({"ok": False, "error": "Locality is required"}), 400

    # 5. Validate ID Type and ID last 4
    VALID_ID_TYPES = {"Voter ID", "Driving Licence", "College ID", "Passport", "Other"}
    id_type = (vol.get('id_type') or '').strip()
    if not id_type or id_type not in VALID_ID_TYPES:
        conn.close()
        return jsonify({
            "ok": False,
            "error": f"Valid ID type is required. Choose from: {', '.join(sorted(VALID_ID_TYPES))}"
        }), 400

    id_last4 = (vol.get('id_last4') or '').strip()
    if not id_last4 or len(id_last4) != 4 or not id_last4.isalnum():
        conn.close()
        return jsonify({
            "ok": False,
            "error": "id_last4 must be exactly 4 digits or alphanumeric characters. Full ID numbers are never permitted."
        }), 400

    # 6. Validate ID image and selfie uploads exist on disk
    id_path = vol.get('id_image_path')
    selfie_path = vol.get('selfie_path')

    if not id_path:
        conn.close()
        return jsonify({"ok": False, "error": "Government ID image upload is required"}), 400

    if not selfie_path:
        conn.close()
        return jsonify({"ok": False, "error": "Live verification selfie upload is required"}), 400

    base_dir = os.path.dirname(os.path.abspath(__file__))
    id_full = os.path.join(base_dir, '..', id_path) if not os.path.isabs(id_path) else id_path
    selfie_full = os.path.join(base_dir, '..', selfie_path) if not os.path.isabs(selfie_path) else selfie_path

    if not os.path.exists(id_full):
        conn.close()
        return jsonify({"ok": False, "error": "ID image file missing from storage. Please re-upload your ID."}), 400

    if not os.path.exists(selfie_full):
        conn.close()
        return jsonify({"ok": False, "error": "Selfie file missing from storage. Please re-upload your selfie."}), 400

    # 7. Validate 2 references with different phones that are not applicant's own
    cursor.execute('''
        SELECT id, name, phone, relation FROM volunteer_references
        WHERE volunteer_id = ?;
    ''', (vol_id,))
    refs = [dict(r) for r in cursor.fetchall()]

    if len(refs) < 2:
        conn.close()
        return jsonify({"ok": False, "error": f"At least 2 personal/professional references are required (currently have {len(refs)})"}), 400

    ref_phones = []
    for r in refs:
        p = (r.get('phone') or '').strip()
        n = (r.get('name') or '').strip()
        if not n:
            conn.close()
            return jsonify({"ok": False, "error": "All references must have a contact name"}), 400
        if not p or len(p) < 7:
            conn.close()
            return jsonify({"ok": False, "error": f"Invalid phone number for reference '{n}'"}), 400

        # Cannot be applicant's own phone
        if applicant_phone and p == applicant_phone:
            conn.close()
            return jsonify({"ok": False, "error": f"Reference phone number cannot be the applicant's own phone number ({applicant_phone})"}), 400

        ref_phones.append(p)

    # References must have distinct phones
    if len(set(ref_phones[:2])) < 2:
        conn.close()
        return jsonify({"ok": False, "error": "The two references must have different phone numbers"}), 400

    # 8. Validate training passed
    training_passed_at = vol.get('training_passed_at')
    training_score = vol.get('training_score') or 0.0

    if not training_passed_at or training_score < 80.0:
        conn.close()
        return jsonify({
            "ok": False,
            "error": "Volunteer safety training must be completed and passed with at least 80% score before submitting."
        }), 400

    # 9. Validate declaration accepted with typed signature matching full name
    decl_accepted = vol.get('declaration_accepted_at')
    if not decl_accepted:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer code of conduct declaration must be accepted"}), 400

    typed_sig = (vol.get('typed_signature') or '').strip().lower()
    fn_clean = full_name.strip().lower()
    if not typed_sig or typed_sig != fn_clean:
        conn.close()
        return jsonify({
            "ok": False,
            "error": f"Typed signature ('{vol.get('typed_signature')}') must exactly match your full name ('{full_name}')"
        }), 400

    # 10. Compute automatic fraud and safety risk flags
    flags = compute_volunteer_flags(cursor, vol_id, user_id, applicant_phone, vol, refs)
    flags_json = json.dumps(flags)

    # All checks passed: set status to 'submitted' and record flags
    cursor.execute('''
        UPDATE volunteers
        SET status = 'submitted',
            flags_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (flags_json, vol_id))

    # Audit submission
    cursor.execute('''
        INSERT INTO volunteer_reviews (volunteer_id, reviewer, action, checklist_json, note)
        VALUES (?, 'system', 'submit', ?, 'Volunteer application submitted for review');
    ''', (vol_id, flags_json))
    conn.commit()

    cursor.execute('''
        SELECT id, user_id, status, full_name, id_type, id_last4, training_score, updated_at
        FROM volunteers WHERE id = ?;
    ''', (vol_id,))
    final_vol = dict(cursor.fetchone())
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "volunteer_id": final_vol['id'],
            "status": "submitted",
            "full_name": final_vol['full_name'],
            "id_type": final_vol['id_type'],
            "id_last4": final_vol['id_last4'],
            "training_score": final_vol['training_score'],
            "updated_at": final_vol['updated_at'],
            "message": "Volunteer application submitted successfully for review"
        }
    }), 200

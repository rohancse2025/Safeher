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


def _extract_phones(data, user_id=None, contact_ids=None):
    phones = []
    # 1. Direct phones list in payload
    for p in (data.get('phones') or []):
        p_str = str(p).strip()
        if p_str and p_str not in phones:
            phones.append(p_str)
    # 2. Direct single phone
    if data.get('phone'):
        p_str = str(data.get('phone')).strip()
        if p_str and p_str not in phones:
            phones.append(p_str)
    # 3. Client contacts list [{phone: '...'}]
    for c in (data.get('contacts') or []):
        if isinstance(c, dict):
            p = str(c.get('phone') or '').strip()
            if p and p not in phones:
                phones.append(p)
        elif isinstance(c, str) and c.strip():
            if c.strip() not in phones:
                phones.append(c.strip())
    # 4. If contact_ids given and database has them
    if contact_ids:
        valid_cids = [int(cid) for cid in contact_ids if str(cid).isdigit()]
        if valid_cids:
            try:
                conn = get_db()
                c = conn.cursor()
                c.execute("SELECT phone FROM contacts WHERE id IN ({});".format(','.join('?' for _ in valid_cids)), valid_cids)
                for r in c.fetchall():
                    p = str(r['phone'] or '').strip()
                    if p and p not in phones:
                        phones.append(p)
                conn.close()
            except Exception:
                pass
    # 5. Database contacts for user_id
    if not phones and user_id:
        try:
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT phone FROM contacts WHERE user_id = ? AND phone NOT IN ('112', '181');", (user_id,))
            for r in c.fetchall():
                p = str(r['phone'] or '').strip()
                if p and p not in phones:
                    phones.append(p)
            conn.close()
        except Exception:
            pass
    # 6. Fallback to any saved non-emergency contacts in DB
    if not phones:
        try:
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT phone FROM contacts WHERE phone NOT IN ('112', '181') LIMIT 5;")
            for r in c.fetchall():
                p = str(r['phone'] or '').strip()
                if p and p not in phones:
                    phones.append(p)
            conn.close()
        except Exception:
            pass
    return phones


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
        "contacts": [{phone, name}],
        "phones": ["917483245232"],
        "lat": 12.9716,
        "lng": 77.5946
      }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    data = request.get_json(silent=True) or {}
    user_name = (data.get('user_name') or (user.get('name') if user else None) or 'SafeHer User').strip()

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

    # Ensure user exists in users table to satisfy foreign keys
    try:
        cursor.execute("SELECT id FROM users WHERE id = ?;", (user_id,))
        if not cursor.fetchone():
            cursor.execute('''
                INSERT INTO users (id, name, phone, email, password_hash)
                VALUES (?, ?, '917483245232', 'user@safeher.app', 'demo_hash');
            ''', (user_id, user_name))
            conn.commit()
    except Exception:
        pass

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

    # 1. Sync any client-provided contacts into contacts table
    client_contacts = data.get('contacts') or []
    synced_contact_ids = []
    for cc in client_contacts:
        if isinstance(cc, dict):
            c_name = str(cc.get('name') or 'Emergency Contact').strip()
            c_phone = str(cc.get('phone') or '').strip()
            c_email = str(cc.get('email') or '').strip()
            if c_phone or c_email:
                cursor.execute("SELECT id FROM contacts WHERE user_id = ? AND (phone = ? OR (email = ? AND email != ''));", (user_id, c_phone, c_email))
                row = cursor.fetchone()
                if row:
                    synced_contact_ids.append(row['id'])
                else:
                    cursor.execute('''
                        INSERT INTO contacts (user_id, name, phone, email, relationship)
                        VALUES (?, ?, ?, ?, 'Contact');
                    ''', (user_id, c_name, c_phone, c_email or None))
                    synced_contact_ids.append(cursor.lastrowid)

    # 2. If client passed direct phones list
    for p in (data.get('phones') or []):
        p_str = str(p).strip()
        if p_str:
            cursor.execute("SELECT id FROM contacts WHERE user_id = ? AND phone = ?;", (user_id, p_str))
            row = cursor.fetchone()
            if row:
                if row['id'] not in synced_contact_ids:
                    synced_contact_ids.append(row['id'])
            else:
                cursor.execute('''
                    INSERT INTO contacts (user_id, name, phone, relationship)
                    VALUES (?, 'Emergency Contact', ?, 'Contact');
                ''', (user_id, p_str))
                synced_contact_ids.append(cursor.lastrowid)

    # 3. Resolve valid contact IDs that actually exist in DB
    final_contact_ids = []
    raw_cids = data.get('contact_ids')
    if raw_cids and isinstance(raw_cids, list):
        for cid in raw_cids:
            if str(cid).isdigit():
                cursor.execute("SELECT id FROM contacts WHERE id = ?;", (int(cid),))
                if cursor.fetchone():
                    final_contact_ids.append(int(cid))

    for scid in synced_contact_ids:
        if scid not in final_contact_ids:
            final_contact_ids.append(scid)

    if not final_contact_ids:
        cursor.execute("SELECT id FROM contacts WHERE user_id = ?;", (user_id,))
        final_contact_ids = [r['id'] for r in cursor.fetchall()]

    if not final_contact_ids:
        # Create a default emergency contact for user so foreign key never fails
        cursor.execute('''
            INSERT INTO contacts (user_id, name, phone, email, relationship)
            VALUES (?, 'Primary Contact', '917483245232', 'contact@safeher.app', 'Contact');
        ''', (user_id,))
        final_contact_ids = [cursor.lastrowid]

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens_list = []
    client_token = (data.get('token') or data.get('share_token') or '').strip()

    for idx, cid in enumerate(final_contact_ids):
        tok = client_token if (client_token and idx == 0) else secrets.token_urlsafe(32)
        try:
            cursor.execute('''
                INSERT INTO ride_contacts (ride_id, contact_id, token, created_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP);
            ''', (ride_id, cid, tok))
            tokens_list.append({
                "contact_id": cid,
                "token": tok,
                "track_url": f"{frontend_url}/track.html?t={tok}"
            })
        except Exception:
            tok = secrets.token_urlsafe(32)
            try:
                cursor.execute('''
                    INSERT INTO ride_contacts (ride_id, contact_id, token, created_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP);
                ''', (ride_id, cid, tok))
                tokens_list.append({
                    "contact_id": cid,
                    "token": tok,
                    "track_url": f"{frontend_url}/track.html?t={tok}"
                })
            except Exception as e:
                app_logger.warning(f"[RIDE CONTACT INSERT] cid={cid}: {e}")

    conn.commit()
    conn.close()

    primary_tok = tokens_list[0]['token'] if tokens_list else (client_token or secrets.token_urlsafe(32))
    vehicle_desc = f"{vehicle_type} {vehicle_number}".strip()

    # Dispatch automated WhatsApp notifications to selected contacts
    try:
        from whatsapp_service import send_ride_started_whatsapp_notifications_background
        c_phones = _extract_phones(data, user_id=user_id, contact_ids=final_contact_ids)
        if c_phones:
            send_ride_started_whatsapp_notifications_background(
                ride_id, user_name, vehicle_type, vehicle_number, driver_name, driver_phone,
                app_used, pickup, destination, expected_minutes, lat or 0, lng or 0, primary_tok, c_phones
            )
            app_logger.info(f"[RIDE WHATSAPP DISPATCHED] ride_id={ride_id}, phones={c_phones}")
    except Exception as e:
        app_logger.warning(f"[RIDE START WHATSAPP DISPATCH] {e}")

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
        contact_ids=final_contact_ids,
        event_key=f"ride:{ride_id}:started"
    )

    app_logger.info(f"[RIDE STARTED] ride_id={ride_id}, user_id={user_id}, vehicle={vehicle_desc}, eta={expected_minutes}m, contacts={len(final_contact_ids)}")

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
            "contacts_count": len(final_contact_ids),
            "tokens": tokens_list
        }
    }), 201


# ─── Route: POST /api/rides/<id>/position ──────────────────────
@rides_bp.route('/api/rides/<ride_id>/position', methods=['POST'])
def update_ride_position(ride_id):
    """
    Update position for an active monitored ride.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000

    data = request.get_json(silent=True) or {}
    lat = data.get('lat')
    lng = data.get('lng')

    if lat is None or lng is None:
        return jsonify({"ok": False, "error": "Coordinates lat and lng are required"}), 400

    conn = get_db()
    cursor = conn.cursor()

    row = None
    if str(ride_id).isdigit():
        cursor.execute("SELECT id, user_id, status FROM rides WHERE id = ?;", (int(ride_id),))
        row = cursor.fetchone()

    token = data.get('token') or data.get('share_token')
    if not row and token:
        cursor.execute("SELECT ride_id FROM ride_contacts WHERE token = ?;", (token,))
        sc = cursor.fetchone()
        if sc:
            cursor.execute("SELECT id, user_id, status FROM rides WHERE id = ?;", (sc['ride_id'],))
            row = cursor.fetchone()

    if not row:
        cursor.execute("SELECT id, user_id, status FROM rides WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Ride session not found"}), 404

    real_ride_id = row['id']
    if row['status'] != 'active':
        conn.close()
        return jsonify({"ok": False, "error": f"Ride session is {row['status']}"}), 400

    cursor.execute('''
        UPDATE rides
        SET last_lat = ?, last_lng = ?, last_update_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (lat, lng, real_ride_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "ride_id": real_ride_id,
            "lat": lat,
            "lng": lng
        }
    }), 200


# ─── Route: POST /api/rides/<id>/end ───────────────────────────
@rides_bp.route('/api/rides/<ride_id>/end', methods=['POST'])
def end_ride(ride_id):
    """
    End an active ride safety session.
    Dispatches 'ride_ended' notification to contacts and automated WhatsApp arrival notice.
    """
    data = request.get_json(silent=True) or {}
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = (data.get('user_name') or (user.get('name') if user else None) or 'SafeHer User').strip()

    conn = get_db()
    cursor = conn.cursor()

    row = None
    if str(ride_id).isdigit():
        cursor.execute("SELECT id, user_id, status, destination, vehicle_number FROM rides WHERE id = ?;", (int(ride_id),))
        row = cursor.fetchone()

    token = data.get('token') or data.get('share_token')
    if not row and token:
        cursor.execute("SELECT ride_id FROM ride_contacts WHERE token = ?;", (token,))
        sc = cursor.fetchone()
        if sc:
            cursor.execute("SELECT id, user_id, status, destination, vehicle_number FROM rides WHERE id = ?;", (sc['ride_id'],))
            row = cursor.fetchone()

    if not row:
        cursor.execute("SELECT id, user_id, status, destination, vehicle_number FROM rides WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        row = cursor.fetchone()

    real_ride_id = row['id'] if row else (int(ride_id) if str(ride_id).isdigit() else 0)
    dest = (row['destination'] if row else (data.get('destination') or 'Destination'))
    v_num = (row['vehicle_number'] if row else (data.get('vehicle_number') or 'Cab'))

    if row and row['status'] != 'ended':
        cursor.execute('''
            UPDATE rides
            SET status = 'ended', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (real_ride_id,))
        conn.commit()

    cursor.execute("SELECT contact_id FROM ride_contacts WHERE ride_id = ?;", (real_ride_id,))
    c_rows = cursor.fetchall()
    c_ids = [r['contact_id'] for r in c_rows if r['contact_id']]
    conn.close()

    c_phones = _extract_phones(data, user_id=user_id, contact_ids=c_ids)

    try:
        from whatsapp_service import send_ride_arrived_whatsapp_notifications_background
        if c_phones:
            send_ride_arrived_whatsapp_notifications_background(
                real_ride_id, user_name, dest, v_num, c_phones
            )
            app_logger.info(f"[RIDE ARRIVE WHATSAPP DISPATCHED] ride_id={real_ride_id}, phones={c_phones}")
    except Exception as e:
        app_logger.warning(f"[RIDE ARRIVE WHATSAPP DISPATCH] {e}")

    try:
        notify(
            event_type='ride_ended',
            user_id=user_id,
            context={
                'user_name': user_name,
                'destination': dest,
                'ride_id': real_ride_id
            },
            contact_ids=c_ids,
            event_key=f"ride:{real_ride_id}:ended"
        )
    except Exception:
        pass

    app_logger.info(f"[RIDE ENDED] ride_id={real_ride_id}, user_id={user_id}")

    return jsonify({
        "ok": True,
        "message": "Ride completed safely",
        "data": {
            "ride_id": real_ride_id,
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

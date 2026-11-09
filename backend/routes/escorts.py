# backend/routes/escorts.py – Escort Mode Tracking, Route Deviation Maths, and Automated Journey Safety
import os
import math
import json
import secrets
import datetime
import threading
import time
from flask import Blueprint, request, jsonify, g
from dotenv import load_dotenv

from db import get_db
from logger import app_logger
from routes.auth import login_required
from routes.alerts import is_valid_coord, create_alert_internal, get_user_from_request
from email_service import send_email
try:
    from services.events import log_event
except ImportError:
    from backend.services.events import log_event

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '..', '.env'))
load_dotenv()

escorts_bp = Blueprint('escorts', __name__)

EARTH_RADIUS_METERS = 6371000.0


# ─── 1. Mathematical Distance & Projection Utilities ───────────

def haversine_m(lat1, lon1, lat2, lon2):
    """
    Great-circle distance in meters between two coordinates.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c


def point_to_segment_distance_m(p_lat, p_lng, a_lat, a_lng, b_lat, b_lng):
    """
    Computes distance in meters from query point P to segment AB
    using a local equirectangular projection centered on the segment.
    """
    ref_lat = math.radians((a_lat + b_lat) / 2.0)
    cos_ref = math.cos(ref_lat)

    # Convert coordinates to local meters with point A as origin (0, 0)
    ax, ay = 0.0, 0.0
    bx = math.radians(b_lng - a_lng) * cos_ref * EARTH_RADIUS_METERS
    by = math.radians(b_lat - a_lat) * EARTH_RADIUS_METERS
    px = math.radians(p_lng - a_lng) * cos_ref * EARTH_RADIUS_METERS
    py = math.radians(p_lat - a_lat) * EARTH_RADIUS_METERS

    dx = bx - ax
    dy = by - ay
    seg_len_sq = dx * dx + dy * dy

    if seg_len_sq == 0.0:
        return math.hypot(px - ax, py - ay)

    # Project point P onto line segment AB with parameter t
    t = ((px - ax) * dx + (py - ay) * dy) / seg_len_sq
    t_clamped = max(0.0, min(1.0, t))

    closest_x = ax + t_clamped * dx
    closest_y = ay + t_clamped * dy

    return math.hypot(px - closest_x, py - closest_y)


def point_to_route_distance_m(p_lat, p_lng, route_points):
    """
    Minimum perpendicular distance in meters from point P to the polyline route.
    """
    if not route_points:
        return 0.0
    if len(route_points) == 1:
        p0 = route_points[0]
        return haversine_m(p_lat, p_lng, p0[0], p0[1])

    min_dist = float('inf')
    for i in range(len(route_points) - 1):
        a = route_points[i]
        b = route_points[i + 1]
        dist = point_to_segment_distance_m(p_lat, p_lng, a[0], a[1], b[0], b[1])
        if dist < min_dist:
            min_dist = dist
    return min_dist


def total_route_distance_m(route_points):
    """
    Total distance along the route polyline in meters.
    """
    if not route_points or len(route_points) < 2:
        return 0.0
    total = 0.0
    for i in range(len(route_points) - 1):
        a = route_points[i]
        b = route_points[i + 1]
        total += haversine_m(a[0], a[1], b[0], b[1])
    return total


def parse_datetime_utc(dt_str):
    """
    Robust ISO/SQL datetime parser returning UTC datetime.
    """
    if not dt_str:
        return None
    try:
        clean = str(dt_str).strip()
        if 'T' in clean:
            dt = datetime.datetime.fromisoformat(clean.replace('Z', '+00:00'))
        else:
            dt = datetime.datetime.strptime(clean, "%Y-%m-%d %H:%M:%S")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt
    except Exception:
        return None


# ─── 2. Route: POST /api/escorts (Create Escort) ───────────────
@escorts_bp.route('/api/escorts', methods=['POST'])
def create_escort():
    """
    Start a new Escort Mode journey.
    Supports authenticated, guest, and offline-first users.
    Expects JSON:
      - destination or dest_name (str)
      - dest_lat (float), dest_lng (float)
      - route (list of [lat, lng]) or route_points
      - expected_minutes (int, positive)
      - checkin_interval (5, 10, 15, 30 or None/0)
      - deviation_distance (100 to 500 m, default 200)
      - contact_ids (list of int) or contacts (list of contact objects)
    Creates unique token per contact and dispatches automated WhatsApp & Email.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'
    data = request.get_json(silent=True) or {}

    dest_name = (data.get('dest_name') or data.get('destination') or '').strip()
    if not dest_name:
        return jsonify({"ok": False, "error": "Destination name is required"}), 400

    dest_lat = data.get('dest_lat')
    dest_lng = data.get('dest_lng')
    if dest_lat is None or dest_lng is None or not is_valid_coord(dest_lat, dest_lng):
        return jsonify({"ok": False, "error": "Valid destination latitude and longitude are required"}), 400
    dest_lat = float(dest_lat)
    dest_lng = float(dest_lng)

    # Route points validation
    raw_route = data.get('route') or data.get('route_points') or []
    if not isinstance(raw_route, list) or len(raw_route) < 1:
        # Fallback to straight line from start/dest if none provided
        start_lat = float(data.get('start_lat') or dest_lat)
        start_lng = float(data.get('start_lng') or dest_lng)
        raw_route = [[start_lat, start_lng], [dest_lat, dest_lng]]

    route_points = []
    for pt in raw_route:
        if isinstance(pt, (list, tuple)) and len(pt) >= 2:
            try:
                route_points.append([float(pt[0]), float(pt[1])])
            except (ValueError, TypeError):
                continue

    if len(route_points) < 1:
        return jsonify({"ok": False, "error": "Route must contain at least one coordinate point"}), 400

    route_distance_m = total_route_distance_m(route_points)

    # Expected minutes
    try:
        expected_minutes = int(data.get('expected_minutes') or data.get('expected_mins') or 30)
        if expected_minutes <= 0:
            expected_minutes = 30
    except (ValueError, TypeError):
        expected_minutes = 30

    # Night default check: between 8 PM and 6 AM IST (UTC + 5:30)
    now_utc_init = datetime.datetime.now(datetime.timezone.utc)
    ist_total_mins = now_utc_init.hour * 60 + now_utc_init.minute + 330
    ist_hour = (ist_total_mins // 60) % 24
    is_night_ist = (ist_hour >= 20 or ist_hour < 6)

    # Checkin interval: 5, 10, 15, 30 or None (default 5 at night if not specified)
    raw_checkin = data.get('checkin_interval')
    if raw_checkin is None and 'checkin_interval_min' in data:
        raw_checkin = data.get('checkin_interval_min')

    checkin_interval_min = None
    if raw_checkin not in (None, '', 'none', 'off', 0, '0'):
        try:
            val = int(raw_checkin)
            if val in (5, 10, 15, 30):
                checkin_interval_min = val
        except (ValueError, TypeError):
            checkin_interval_min = None
    elif is_night_ist and raw_checkin is None:
        checkin_interval_min = 5

    # Deviation distance: 100 to 500 m (default 150 at night if not specified, else 200)
    raw_dev = data.get('deviation_distance')
    if raw_dev is None and 'deviation_m' in data:
        raw_dev = data.get('deviation_m')
    if raw_dev is not None:
        try:
            dev_dist = float(raw_dev)
            deviation_m = max(100.0, min(500.0, dev_dist))
        except (ValueError, TypeError):
            deviation_m = 150.0 if is_night_ist else 200.0
    else:
        deviation_m = 150.0 if is_night_ist else 200.0

    # Contact IDs
    raw_contact_ids = data.get('contact_ids') or []
    contact_ids = []
    if isinstance(raw_contact_ids, list):
        for cid in raw_contact_ids:
            if isinstance(cid, int) or (isinstance(cid, str) and str(cid).isdigit()):
                contact_ids.append(int(cid))

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S")
    expected_end = now_utc + datetime.timedelta(minutes=expected_minutes)
    expected_end_str = expected_end.strftime("%Y-%m-%d %H:%M:%S")

    next_checkin_due = None
    if checkin_interval_min:
        next_checkin_due = (now_utc + datetime.timedelta(minutes=checkin_interval_min)).strftime("%Y-%m-%d %H:%M:%S")

    # Initial position from first route point
    first_pt = route_points[0]
    last_lat = float(data.get('lat') or first_pt[0])
    last_lng = float(data.get('lng') or first_pt[1])

    route_json = json.dumps(route_points)

    conn = get_db()
    cursor = conn.cursor()

    # Cancel any previous active/paused escorts for this user
    cursor.execute('''
        UPDATE escorts
        SET status = 'ended', ended_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status IN ('active', 'paused');
    ''', (user_id,))

    cursor.execute('''
        INSERT INTO escorts (
            user_id, dest_name, dest_lat, dest_lng, route_json, route_distance_m,
            started_at, expected_end, status, checkin_interval_min, deviation_m,
            last_lat, last_lng, last_update_at, last_checkin_at, next_checkin_due,
            stationary_anchor_lat, stationary_anchor_lng, stationary_anchor_at,
            pauses_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0);
    ''', (
        user_id, dest_name, dest_lat, dest_lng, route_json, route_distance_m,
        now_str, expected_end_str, checkin_interval_min, deviation_m,
        last_lat, last_lng, now_str, now_str, next_checkin_due,
        last_lat, last_lng, now_str
    ))
    escort_id = cursor.lastrowid

    # Sync client contacts into DB if provided
    client_contacts = data.get('contacts')
    if client_contacts and isinstance(client_contacts, list):
        for cc in client_contacts:
            if isinstance(cc, dict):
                c_name = str(cc.get('name') or '').strip()
                c_phone = str(cc.get('phone') or '').strip()
                c_email = str(cc.get('email') or '').strip()
                if c_name and (c_phone or c_email):
                    try:
                        cursor.execute('SELECT id FROM contacts WHERE user_id = ? AND (phone = ? OR (email = ? AND email != ""));', (user_id, c_phone, c_email))
                        if not cursor.fetchone():
                            cursor.execute('INSERT INTO contacts (user_id, name, phone, email, is_primary) VALUES (?, ?, ?, ?, 1);', (user_id, c_name, c_phone, c_email or None))
                    except Exception:
                        pass

    # Verify contacts and generate tokens
    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens_map = {}
    links_map = {}

    valid_contacts = []
    if contact_ids:
        placeholders = ','.join('?' for _ in contact_ids)
        cursor.execute(f'''
            SELECT id, name, phone, email
            FROM contacts
            WHERE user_id = ? AND id IN ({placeholders});
        ''', (user_id, *contact_ids))
        valid_contacts = [dict(c) for c in cursor.fetchall()]

    if not valid_contacts:
        # Default to close contacts if specified, otherwise all user contacts
        cursor.execute('SELECT id, name, phone, email FROM contacts WHERE user_id = ? AND close = 1;', (user_id,))
        valid_contacts = [dict(c) for c in cursor.fetchall()]
        if not valid_contacts:
            cursor.execute('SELECT id, name, phone, email FROM contacts WHERE user_id = ?;', (user_id,))
            valid_contacts = [dict(c) for c in cursor.fetchall()]

    if not valid_contacts:
        cursor.execute('SELECT id, name, phone, email FROM contacts LIMIT 5;')
        valid_contacts = [dict(c) for c in cursor.fetchall()]

    if not valid_contacts:
        cursor.execute("INSERT INTO contacts (user_id, name, phone, email, is_primary) VALUES (?, 'Emergency Contact', '917483245232', 'rohanrao1803@gmail.com', 1);", (user_id,))
        valid_contacts = [{'id': cursor.lastrowid, 'name': 'Emergency Contact', 'phone': '917483245232', 'email': 'rohanrao1803@gmail.com'}]

    for c in valid_contacts:
        c_id = c['id']
        token = secrets.token_urlsafe(24)
        cursor.execute('''
            INSERT INTO escort_contacts (escort_id, contact_id, token)
            VALUES (?, ?, ?);
        ''', (escort_id, c_id, token))
        track_link = f"{frontend_url}/track.html?t={token}"
        tokens_map[str(c_id)] = token
        if 'phone' in c and c['phone']:
            tokens_map[str(c['phone']).strip()] = token
            tokens_map[str(c['phone']).replace('+', '').strip()] = token
        links_map[str(c_id)] = track_link

        pass

    # Log escort_started incident event
    log_event(
        user_id=user_id,
        type='escort_started',
        actor='user',
        detail={'dest_name': dest_name, 'expected_minutes': expected_minutes},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    app_logger.info(f"[ESCORT STARTED] escort_id={escort_id}, user_id={user_id}, dest={dest_name}")

    try:
        from services.notify import notify
        first_token = tokens_map.get(str(valid_contacts[0]['id'])) if valid_contacts else ''
        notify(
            event_type='escort_start',
            user_id=user_id,
            context={
                'user_name': user_name,
                'dest_name': dest_name,
                'expected_minutes': expected_minutes,
                'dest_lat': dest_lat,
                'dest_lng': dest_lng,
                'start_lat': route_points[0][0] if route_points else dest_lat,
                'start_lng': route_points[0][1] if route_points else dest_lng,
                'track_url': f"{frontend_url}/track.html?t={first_token}" if first_token else f"{frontend_url}/track.html",
                'escort_id': escort_id
            },
            contact_ids=[c['id'] for c in valid_contacts],
            event_key=f"escort_start_{escort_id}"
        )
    except Exception as notify_err:
        app_logger.warning(f"[NOTIFY ESCORT_START ERROR] {notify_err}")

    def send_escort_emails_bg(contact_list, u_name, d_name, exp_str, t_map):
        f_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        for c_item in contact_list:
            if c_item.get('email') and c_item['email'].strip():
                c_tok = t_map.get(c_item['id']) or t_map.get(str(c_item['id']))
                if not c_tok:
                    continue
                t_link = f"{f_url}/track.html?t={c_tok}"
                subj = f"SafeHer – {u_name} started a journey to {d_name}"
                body_txt = (
                    f"Hello {c_item['name']},\n\n"
                    f"{u_name} has started an Escort Mode journey to {d_name}, expected by {exp_str}.\n"
                    f"Track the journey in real time here:\n{t_link}\n\n"
                    f"SafeHer Women Safety"
                )
                body_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family: 'Poppins', sans-serif; background: #FCEFF3; padding: 20px;">
  <div style="max-width: 500px; margin: auto; background: #ffffff; border-radius: 16px; padding: 24px; border: 1px solid #F3C2CE;">
    <h2 style="color: #9E1B32; margin-top: 0;">SafeHer Escort Mode</h2>
    <p><strong>{u_name}</strong> started a journey to <strong>{d_name}</strong>, expected by <strong>{exp_str}</strong>.</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="{t_link}" style="background: #9E1B32; color: #ffffff; padding: 12px 24px; border-radius: 24px; text-decoration: none; font-weight: 600; display: inline-block;">Track Live Journey</a>
    </div>
    <p style="font-size: 13px; color: #666;">This link allows you to follow along live without needing an account. It expires 1 hour after arrival.</p>
  </div>
</body>
</html>"""
                try:
                    send_email(c_item['email'].strip(), subj, body_txt, body_html)
                except Exception as mail_err:
                    app_logger.error(f"[Escort] Email dispatch error to {c_item['email']}: {mail_err}")

    threading.Thread(
        target=send_escort_emails_bg,
        args=([dict(item) for item in valid_contacts], user_name, dest_name, expected_end_str, dict(tokens_map)),
        daemon=True
    ).start()

    escort_phones = [c_item['phone'].strip() for c_item in valid_contacts if ('phone' in c_item.keys() and c_item['phone'] and str(c_item['phone']).strip())]
    if escort_phones:
        try:
            from whatsapp_service import send_escort_whatsapp_notifications_background
            send_escort_whatsapp_notifications_background(
                escort_id=escort_id,
                user_name=user_name,
                dest_name=dest_name,
                expected_end_str=expected_end_str,
                recipient_phones=escort_phones,
                tokens_map=tokens_map
            )
        except Exception as wa_esc_err:
            app_logger.error(f"[Escort] WhatsApp trigger error: {wa_esc_err}")

    return jsonify({
        "ok": True,
        "data": {
            "id": escort_id,
            "dest_name": dest_name,
            "dest_lat": dest_lat,
            "dest_lng": dest_lng,
            "route_distance_m": round(route_distance_m, 1),
            "expected_minutes": expected_minutes,
            "expected_end": expected_end_str,
            "status": "active",
            "checkin_interval_min": checkin_interval_min,
            "deviation_m": deviation_m,
            "tokens": tokens_map,
            "share_links": links_map
        }
    }), 201


# ─── 3. Route: POST /api/escorts/<id>/position ────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/position', methods=['POST'])
def update_escort_position(escort_id):
    """
    Update user position along the escort journey.
    Computes distance to route polyline via local equirectangular projection.
    Sets or clears off_route_since.
    Detects stationary state (< 30 m over 5 minutes while not paused).
    Detects arrival (< 100 m from destination).
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'
    data = request.get_json(silent=True) or {}

    lat = data.get('lat')
    lng = data.get('lng')
    if lat is None or lng is None or not is_valid_coord(lat, lng):
        return jsonify({"ok": False, "error": "Valid latitude and longitude required"}), 400
    lat = float(lat)
    lng = float(lng)

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, dest_name, dest_lat, dest_lng, route_json, deviation_m,
               status, off_route_since, stationary_since, stationary_anchor_lat,
               stationary_anchor_lng, stationary_anchor_at, alert_id
        FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    current_status = escort['status']
    if current_status in ('arrived', 'ended'):
        conn.close()
        return jsonify({"ok": False, "error": f"Escort journey is already {current_status}"}), 400

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S")

    # 1. Parse route points and compute perpendicular distance to route
    try:
        route_points = json.loads(escort['route_json']) if escort['route_json'] else []
    except Exception:
        route_points = []

    deviation_m = float(escort['deviation_m'] or 200.0)
    dist_to_route = point_to_route_distance_m(lat, lng, route_points)

    # 2. Set or clear off_route_since
    off_route_since = escort['off_route_since']
    if dist_to_route > deviation_m:
        if not off_route_since:
            off_route_since = now_str
            log_event(
                user_id=user_id,
                type='escort_off_route',
                actor='user',
                detail={'distance_m': round(dist_to_route, 1), 'deviation_m': deviation_m},
                escort_id=escort_id,
                cursor=cursor
            )
    else:
        off_route_since = None

    # 3. Detect stationary (< 30 m over 5 minutes while not paused)
    stationary_since = escort['stationary_since']
    anchor_lat = escort['stationary_anchor_lat']
    anchor_lng = escort['stationary_anchor_lng']
    anchor_at_str = escort['stationary_anchor_at']

    if current_status == 'paused':
        stationary_since = None
        anchor_lat = lat
        anchor_lng = lng
        anchor_at_str = now_str
    else:
        if anchor_lat is None or anchor_lng is None or not anchor_at_str:
            anchor_lat = lat
            anchor_lng = lng
            anchor_at_str = now_str
            stationary_since = None
        else:
            dist_from_anchor = haversine_m(lat, lng, anchor_lat, anchor_lng)
            if dist_from_anchor >= 30.0:
                # User has moved more than 30 m -> reset anchor
                anchor_lat = lat
                anchor_lng = lng
                anchor_at_str = now_str
                stationary_since = None
            else:
                # Still within 30 m of anchor
                anchor_dt = parse_datetime_utc(anchor_at_str)
                if anchor_dt and (now_utc - anchor_dt).total_seconds() >= 300:
                    if not stationary_since:
                        stationary_since = now_str

    # 4. Detect arrival (within 100 m of destination)
    dist_to_dest = haversine_m(lat, lng, escort['dest_lat'], escort['dest_lng'])
    arrived = False
    if dist_to_dest <= 100.0 and current_status != 'arrived':
        arrived = True
        current_status = 'arrived'

    cursor.execute('''
        UPDATE escorts
        SET last_lat = ?,
            last_lng = ?,
            last_update_at = ?,
            off_route_since = ?,
            stationary_since = ?,
            stationary_anchor_lat = ?,
            stationary_anchor_lng = ?,
            stationary_anchor_at = ?,
            status = ?,
            ended_at = CASE WHEN ? = 'arrived' THEN ? ELSE ended_at END
        WHERE id = ?;
    ''', (
        lat, lng, now_str, off_route_since, stationary_since,
        anchor_lat, anchor_lng, anchor_at_str, current_status,
        current_status, now_str, escort_id
    ))

    if arrived:
        log_event(
            user_id=user_id,
            type='escort_arrived',
            actor='user',
            detail={'dest_name': escort['dest_name']},
            escort_id=escort_id,
            cursor=cursor
        )

        # Send "arrived safely" emails to selected contacts
        cursor.execute('''
            SELECT c.name, c.email, c.phone FROM escort_contacts ec
            JOIN contacts c ON ec.contact_id = c.id
            WHERE ec.escort_id = ?;
        ''', (escort_id,))
        contacts_to_notify = cursor.fetchall()
        user_name = user_name or 'SafeHer User'
        dest_title = escort['dest_name']

        for c in contacts_to_notify:
            if c['email'] and c['email'].strip():
                subj = f"SafeHer – {user_name} arrived safely at {dest_title}"
                body_txt = (
                    f"Hello {c['name']},\n\n"
                    f"{user_name} has arrived safely at {dest_title}.\n"
                    f"Thank you for looking out for them!\n\n"
                    f"SafeHer Women Safety"
                )
                try:
                    send_email(c['email'].strip(), subj, body_txt)
                except Exception as mail_err:
                    app_logger.error(f"[Escort Arrived] Email error to {c['email']}: {mail_err}")

        arrived_phones = [c['phone'].strip() for c in contacts_to_notify if c['phone'] and c['phone'].strip()]
        if arrived_phones:
            try:
                from whatsapp_service import send_escort_arrived_whatsapp_notifications_background
                send_escort_arrived_whatsapp_notifications_background(escort_id, user_name, dest_title, arrived_phones)
            except Exception as wa_arr_err:
                app_logger.error(f"[Escort Arrived] WhatsApp error: {wa_arr_err}")

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "distance_to_route_m": round(dist_to_route, 1),
            "distance_to_dest_m": round(dist_to_dest, 1),
            "off_route": bool(off_route_since),
            "stationary": bool(stationary_since),
            "arrived": arrived,
            "status": current_status
        }
    }), 200


# ─── 4. Route: POST /api/escorts/<id>/checkin ─────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/checkin', methods=['POST'])
def checkin_escort(escort_id):
    """
    Owner records a manual safety check-in.
    Updates last_checkin_at and calculates next_checkin_due.
    Logs escort_checkin_ok event.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, checkin_interval_min, status
        FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S")

    interval = escort['checkin_interval_min']
    next_checkin_due = None
    if interval:
        next_checkin_due = (now_utc + datetime.timedelta(minutes=interval)).strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute('''
        UPDATE escorts
        SET last_checkin_at = ?,
            next_checkin_due = ?,
            checkin_requested_at = NULL,
            checkin_requested_by = NULL
        WHERE id = ?;
    ''', (now_str, next_checkin_due, escort_id))

    log_event(
        user_id=user_id,
        type='escort_checkin_ok',
        actor='user',
        detail={'interval_min': interval},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "last_checkin_at": now_str,
            "next_checkin_due": next_checkin_due,
            "message": "Safety check-in confirmed"
        }
    }), 200


# ─── 5. Route: POST /api/escorts/<id>/pause ───────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/pause', methods=['POST'])
def pause_escort(escort_id):
    """
    Pause an active escort journey (up to 15 minutes, at most 2 per escort).
    Expects JSON: { minutes: int (1..15) }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    data = request.get_json(silent=True) or {}

    try:
        minutes = int(data.get('minutes') or 10)
    except (ValueError, TypeError):
        minutes = 10

    if minutes < 1 or minutes > 15:
        return jsonify({"ok": False, "error": "Pause duration must be between 1 and 15 minutes"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, pauses_used, status
        FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    if escort['pauses_used'] >= 2:
        conn.close()
        return jsonify({"ok": False, "error": "Maximum of 2 pauses already used for this journey"}), 400

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    pause_until = (now_utc + datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
    new_pauses_used = escort['pauses_used'] + 1

    cursor.execute('''
        UPDATE escorts
        SET status = 'paused',
            pause_until = ?,
            pauses_used = ?,
            off_route_since = NULL,
            stationary_since = NULL
        WHERE id = ?;
    ''', (pause_until, new_pauses_used, escort_id))

    log_event(
        user_id=user_id,
        type='escort_paused',
        actor='user',
        detail={'minutes': minutes, 'pause_count': new_pauses_used},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "status": "paused",
            "pauses_used": new_pauses_used,
            "pause_until": pause_until,
            "message": f"Journey paused for {minutes} minutes"
        }
    }), 200


# ─── 6. Route: POST /api/escorts/<id>/reroute ─────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/reroute', methods=['POST'])
def reroute_escort(escort_id):
    """
    Update escort route points. Resets off-route state and recalculates route distance.
    Expects JSON: { route: list of [lat, lng] } or route_points
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    data = request.get_json(silent=True) or {}

    raw_route = data.get('route') or data.get('route_points') or []
    if not isinstance(raw_route, list) or len(raw_route) < 1:
        return jsonify({"ok": False, "error": "Valid route coordinate points are required"}), 400

    route_points = []
    for pt in raw_route:
        if isinstance(pt, (list, tuple)) and len(pt) >= 2:
            try:
                route_points.append([float(pt[0]), float(pt[1])])
            except (ValueError, TypeError):
                continue

    if len(route_points) < 1:
        return jsonify({"ok": False, "error": "Route must contain at least one coordinate point"}), 400

    new_distance_m = total_route_distance_m(route_points)
    route_json = json.dumps(route_points)

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, user_id FROM escorts WHERE id = ?;', (escort_id,))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    cursor.execute('''
        UPDATE escorts
        SET route_json = ?,
            route_distance_m = ?,
            off_route_since = NULL
        WHERE id = ?;
    ''', (route_json, new_distance_m, escort_id))

    log_event(
        user_id=user_id,
        type='escort_rerouted',
        actor='user',
        detail={'distance_m': round(new_distance_m, 1)},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "route_distance_m": round(new_distance_m, 1),
            "message": "Route updated successfully"
        }
    }), 200


# ─── 7. Route: POST /api/escorts/<id>/escalate ────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/escalate', methods=['POST'])
def escalate_escort_manual(escort_id):
    """
    Manually escalate an escort journey to an active emergency alert.
    Triggers emails, whatsapp, and pushes to volunteers.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, dest_name, last_lat, last_lng, dest_lat, dest_lng, alert_id, status
        FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    # If alert already active, return existing
    if escort['alert_id']:
        cursor.execute("SELECT id, status FROM alerts WHERE id = ?;", (escort['alert_id'],))
        a_row = cursor.fetchone()
        if a_row and a_row['status'] == 'active':
            conn.close()
            return jsonify({
                "ok": True,
                "data": {
                    "alert_id": escort['alert_id'],
                    "status": "alerted",
                    "message": "Escort is already alerted"
                }
            }), 200

    lat = escort['last_lat'] if escort['last_lat'] is not None else escort['dest_lat']
    lng = escort['last_lng'] if escort['last_lng'] is not None else escort['dest_lng']

    ok, alert_res, status_code = create_alert_internal(
        user_id=user_id,
        user_name=user_name,
        mode='emergency',
        lat=lat,
        lng=lng,
        reason='manual',
        note=f"Escort escalated manually to emergency alert (destination: {escort['dest_name']})",
        bypass_rate_limit=True,
        cursor=cursor,
        conn=conn
    )

    if not ok:
        conn.close()
        return jsonify({"ok": False, "error": alert_res}), status_code

    new_alert_id = alert_res['id']
    cursor.execute('''
        UPDATE escorts
        SET alert_id = ?,
            status = 'alerted'
        WHERE id = ?;
    ''', (new_alert_id, escort_id))

    log_event(
        user_id=user_id,
        type='escort_alerted',
        actor='user',
        detail={'reason': 'manual_escalation', 'alert_id': new_alert_id},
        escort_id=escort_id,
        cursor=cursor
    )

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "alert_id": new_alert_id,
            "status": "alerted",
            "message": "Escort escalated to emergency alert"
        }
    }), 200


# ─── 8. Route: POST /api/escorts/<id>/end ─────────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/end', methods=['POST'])
def end_escort(escort_id):
    """
    End an active escort journey.
    Expects JSON: { arrived: true|false }
    When arrived: emails and WhatsApps "arrived safely" to contacts.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = user['name'] if user else 'SafeHer User'
    data = request.get_json(silent=True) or {}
    arrived = bool(data.get('arrived'))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, dest_name, status, started_at, route_distance_m, alert_id
        FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_str = now_utc.strftime("%Y-%m-%d %H:%M:%S")
    final_status = 'arrived' if arrived else 'ended'

    cursor.execute('''
        UPDATE escorts
        SET status = ?,
            ended_at = ?
        WHERE id = ?;
    ''', (final_status, now_str, escort_id))

    if arrived:
        log_event(
            user_id=user_id,
            type='escort_arrived',
            actor='user',
            detail={'dest_name': escort['dest_name']},
            escort_id=escort_id,
            cursor=cursor
        )

        # Notify contacts
        cursor.execute('''
            SELECT c.name, c.email, c.phone FROM escort_contacts ec
            JOIN contacts c ON ec.contact_id = c.id
            WHERE ec.escort_id = ?;
        ''', (escort_id,))
        contacts_to_notify = cursor.fetchall()
        dest_title = escort['dest_name']

        for c in contacts_to_notify:
            if c['email'] and c['email'].strip():
                subj = f"SafeHer – {user_name} arrived safely at {dest_title}"
                body_txt = (
                    f"Hello {c['name']},\n\n"
                    f"{user_name} has arrived safely at {dest_title}.\n"
                    f"Thank you for looking out for them!\n\n"
                    f"SafeHer Women Safety"
                )
                try:
                    send_email(c['email'].strip(), subj, body_txt)
                except Exception as mail_err:
                    app_logger.error(f"[Escort End] Email error to {c['email']}: {mail_err}")

        arrived_phones = [c['phone'].strip() for c in contacts_to_notify if c['phone'] and c['phone'].strip()]
        if arrived_phones:
            try:
                from whatsapp_service import send_escort_arrived_whatsapp_notifications_background
                send_escort_arrived_whatsapp_notifications_background(escort_id, user_name, dest_title, arrived_phones)
            except Exception as wa_arr_err:
                app_logger.error(f"[Escort End] WhatsApp error: {wa_arr_err}")

        try:
            from services.notify import notify
            notify(
                event_type='escort_safe',
                user_id=user_id,
                context={
                    'user_name': user_name,
                    'dest_name': escort['dest_name'],
                    'escort_id': escort_id
                },
                event_key=f"escort_safe_{escort_id}"
            )
        except Exception as notify_err:
            app_logger.warning(f"[NOTIFY ESCORT_SAFE ERROR] {notify_err}")
    else:
        log_event(
            user_id=user_id,
            type='escort_ended',
            actor='user',
            detail={},
            escort_id=escort_id,
            cursor=cursor
        )

    # Calculate journey summary statistics before closing DB connection
    started_dt = parse_datetime_utc(escort['started_at'])
    route_dist_val = float(escort['route_distance_m'] or 0)
    escort_alert_id = escort['alert_id']

    duration_seconds = int((now_utc - started_dt).total_seconds()) if started_dt else 0
    duration_mins = max(1, round(duration_seconds / 60))

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_checkin_ok';", (escort_id,))
    checkins_done = cursor.fetchone()['count']

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_checkin_missed';", (escort_id,))
    checkins_missed = cursor.fetchone()['count']

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_alerted';", (escort_id,))
    alert_count = cursor.fetchone()['count']
    has_alert = bool(escort_alert_id) or alert_count > 0

    conn.commit()
    conn.close()

    summary_data = {
        "escort_id": escort_id,
        "dest_name": escort['dest_name'],
        "duration_seconds": duration_seconds,
        "duration_minutes": duration_mins,
        "distance_m": round(route_dist_val, 1),
        "checkins_done": checkins_done,
        "checkins_missed": checkins_missed,
        "alert_happened": has_alert,
        "arrived": arrived
    }

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "status": final_status,
            "ended_at": now_str,
            "message": f"Escort journey marked as {final_status}",
            "summary": summary_data
        }
    }), 200




# ─── Route: GET /api/escorts/<id>/summary ─────────────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/summary', methods=['GET'])
def get_escort_summary(escort_id):
    """
    Get journey summary for ended or arrived escort.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT id, user_id, dest_name, route_distance_m, started_at, ended_at, last_update_at, alert_id, status
        FROM escorts WHERE id = ?;
    ''', (escort_id,))
    escort = cursor.fetchone()

    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    started_dt = parse_datetime_utc(escort['started_at'])
    ended_str = escort['ended_at'] or escort['last_update_at']
    ended_dt = parse_datetime_utc(ended_str) or datetime.datetime.now(datetime.timezone.utc)
    duration_seconds = int((ended_dt - started_dt).total_seconds()) if started_dt else 0
    duration_mins = max(1, round(duration_seconds / 60))

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_checkin_ok';", (escort_id,))
    checkins_done = cursor.fetchone()['count']

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_checkin_missed';", (escort_id,))
    checkins_missed = cursor.fetchone()['count']

    cursor.execute("SELECT COUNT(*) AS count FROM incident_events WHERE escort_id = ? AND type = 'escort_alerted';", (escort_id,))
    alert_count = cursor.fetchone()['count']
    has_alert = bool(escort['alert_id']) or alert_count > 0

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "escort_id": escort_id,
            "dest_name": escort['dest_name'],
            "duration_seconds": duration_seconds,
            "duration_minutes": duration_mins,
            "distance_m": round(float(escort['route_distance_m'] or 0), 1),
            "checkins_done": checkins_done,
            "checkins_missed": checkins_missed,
            "alert_happened": has_alert,
            "status": escort['status'],
            "arrived": (escort['status'] == 'arrived')
        }
    }), 200


# ─── Route: POST /api/escorts/<id>/notify-arrived ─────────────
@escorts_bp.route('/api/escorts/<int:escort_id>/notify-arrived', methods=['POST'])
def notify_contacts_arrived_safely(escort_id):
    """
    One-tap send "Arrived safely" email notification to contacts.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_name = user['name'] if user else 'SafeHer User'
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, user_id, dest_name FROM escorts WHERE id = ?;', (escort_id,))
    escort = cursor.fetchone()
    if not escort:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    cursor.execute('''
        SELECT c.name, c.email, c.phone FROM escort_contacts ec
        JOIN contacts c ON ec.contact_id = c.id
        WHERE ec.escort_id = ?;
    ''', (escort_id,))
    contacts_to_notify = cursor.fetchall()
    dest_title = escort['dest_name']

    sent_count = 0
    for c in contacts_to_notify:
        if c['email'] and c['email'].strip():
            subj = f"SafeHer – {user_name} arrived safely at {dest_title}"
            body_txt = (
                f"Hello {c['name']},\n\n"
                f"{user_name} has arrived safely at {dest_title}.\n"
                f"Thank you for looking out for them!\n\n"
                f"SafeHer Women Safety"
            )
            try:
                send_email(c['email'].strip(), subj, body_txt)
                sent_count += 1
            except Exception as mail_err:
                app_logger.error(f"[Escort Notify Arrived] Email error to {c['email']}: {mail_err}")

    log_event(
        user_id=user['id'] if user else 10000,
        type='escort_arrived',
        actor='user',
        detail={'dest_name': dest_title, 'manual_notify': True, 'sent_count': sent_count},
        escort_id=escort_id,
        cursor=cursor
    )
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "message": "Sent 'Arrived safely' to contacts",
        "data": {
            "sent_count": sent_count,
            "dest_name": dest_title
        }
    }), 200

# ─── 9. Route: GET /api/escorts/active & GET /api/escorts/<id> ─
@escorts_bp.route('/api/escorts/active', methods=['GET'])
def get_active_escort():
    """
    Get current active or paused escort journey.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None
    conn = get_db()
    cursor = conn.cursor()

    if user_id:
        cursor.execute('''
            SELECT id, dest_name, dest_lat, dest_lng, route_distance_m, started_at,
                   expected_end, status, checkin_interval_min, deviation_m, last_lat,
                   last_lng, last_update_at, last_checkin_at, next_checkin_due,
                   off_route_since, stationary_since, pauses_used, pause_until, alert_id,
                   checkin_requested_at, checkin_requested_by
            FROM escorts
            WHERE user_id = ? AND status IN ('active', 'paused', 'alerted')
            ORDER BY id DESC LIMIT 1;
        ''', (user_id,))
    else:
        cursor.execute('''
            SELECT id, dest_name, dest_lat, dest_lng, route_distance_m, started_at,
                   expected_end, status, checkin_interval_min, deviation_m, last_lat,
                   last_lng, last_update_at, last_checkin_at, next_checkin_due,
                   off_route_since, stationary_since, pauses_used, pause_until, alert_id,
                   checkin_requested_at, checkin_requested_by
            FROM escorts
            WHERE status IN ('active', 'paused', 'alerted')
            ORDER BY id DESC LIMIT 1;
        ''')
    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"ok": True, "data": None}), 200

    return jsonify({"ok": True, "data": dict(row)}), 200


@escorts_bp.route('/api/escorts/<int:escort_id>', methods=['GET'])
def get_escort_details(escort_id):
    """
    Get full escort journey packet.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT * FROM escorts
        WHERE id = ?;
    ''', (escort_id,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Escort journey not found"}), 404

    cursor.execute('''
        SELECT ec.contact_id, ec.token, c.name, c.phone, c.email
        FROM escort_contacts ec
        JOIN contacts c ON ec.contact_id = c.id
        WHERE ec.escort_id = ?;
    ''', (escort_id,))
    contacts = cursor.fetchall()
    conn.close()

    data = dict(row)
    data['contacts'] = [dict(c) for c in contacts]
    return jsonify({"ok": True, "data": data}), 200


# ─── 10. Automated Escort Safety Scheduler (Runs every 10s) ─────

def check_active_escorts():
    """
    Runs every 10 seconds for active escorts:
      (a) Creates alert with reason 'route_deviation' if off-route for > 2 min and not paused.
      (b) Creates alert with reason 'missed_checkin' if check-in is > 60 seconds overdue.
      (c) Sends 'uneasy' alert to close contacts with reason 'no_signal' if no position update
          for 5 minutes, and escalates to a normal alert after 10 minutes.
      (d) Creates alert with reason 'late_arrival' if expected_end + 10 min passed with no arrival.
    Reuses create_alert_internal (bypasses hourly user limit, max 1 active system alert per escort).
    """
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            SELECT e.id, e.user_id, e.dest_name, e.dest_lat, e.dest_lng, e.status,
                   e.checkin_interval_min, e.deviation_m, e.last_lat, e.last_lng,
                   e.started_at, e.expected_end, e.last_update_at, e.last_checkin_at,
                   e.next_checkin_due, e.off_route_since, e.stationary_since,
                   e.pause_until, e.alert_id, e.checkin_requested_at, e.checkin_requested_by,
                   u.name AS user_name
            FROM escorts e
            JOIN users u ON e.user_id = u.id
            WHERE e.status IN ('active', 'paused', 'alerted');
        ''')
        escorts = cursor.fetchall()
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        for escort in escorts:
            escort_id = escort['id']
            user_id = escort['user_id']
            user_name = escort['user_name'] or 'User'
            status = escort['status']
            alert_id = escort['alert_id']
            lat = escort['last_lat'] if escort['last_lat'] is not None else escort['dest_lat']
            lng = escort['last_lng'] if escort['last_lng'] is not None else escort['dest_lng']

            # Handle pause expiration
            if status == 'paused' and escort['pause_until']:
                pause_dt = parse_datetime_utc(escort['pause_until'])
                if pause_dt and now_utc >= pause_dt:
                    status = 'active'
                    cursor.execute("UPDATE escorts SET status = 'active', pause_until = NULL WHERE id = ?;", (escort_id,))
                    conn.commit()

            # Check existing active alert status
            active_alert_row = None
            if alert_id:
                cursor.execute("SELECT id, mode, status FROM alerts WHERE id = ?;", (alert_id,))
                active_alert_row = cursor.fetchone()
                if active_alert_row and active_alert_row['status'] != 'active':
                    active_alert_row = None

            # ─── Condition (a): Route Deviation (> 2 min and not paused) ───────────
            if not active_alert_row and status == 'active' and escort['off_route_since']:
                off_dt = parse_datetime_utc(escort['off_route_since'])
                if off_dt and (now_utc - off_dt).total_seconds() > 120:
                    ok, res, _ = create_alert_internal(
                        user_id=user_id,
                        user_name=user_name,
                        mode='emergency',
                        lat=lat,
                        lng=lng,
                        reason='route_deviation',
                        note="Automated Escort Alert: Off-route deviation for more than 2 minutes",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    if ok:
                        new_aid = res['id']
                        cursor.execute("UPDATE escorts SET alert_id = ?, status = 'alerted' WHERE id = ?;", (new_aid, escort_id))
                        log_event(
                            user_id=user_id,
                            type='escort_alerted',
                            actor='system',
                            detail={'reason': 'route_deviation', 'alert_id': new_aid},
                            escort_id=escort_id,
                            cursor=cursor
                        )
                        conn.commit()
                    continue

            # ─── Condition (b): Missed Check-in (> 60s overdue) ────────────────────
            if not active_alert_row and status == 'active' and escort['checkin_interval_min'] and escort['next_checkin_due']:
                chk_dt = parse_datetime_utc(escort['next_checkin_due'])
                if chk_dt and (now_utc - chk_dt).total_seconds() > 60:
                    log_event(
                        user_id=user_id,
                        type='escort_checkin_missed',
                        actor='system',
                        detail={'interval_min': escort['checkin_interval_min']},
                        escort_id=escort_id,
                        cursor=cursor
                    )
                    ok, res, _ = create_alert_internal(
                        user_id=user_id,
                        user_name=user_name,
                        mode='emergency',
                        lat=lat,
                        lng=lng,
                        reason='missed_checkin',
                        note="Automated Escort Alert: Safety check-in missed by more than 60 seconds",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    if ok:
                        new_aid = res['id']
                        cursor.execute("UPDATE escorts SET alert_id = ?, status = 'alerted' WHERE id = ?;", (new_aid, escort_id))
                        log_event(
                            user_id=user_id,
                            type='escort_alerted',
                            actor='system',
                            detail={'reason': 'missed_checkin', 'alert_id': new_aid},
                            escort_id=escort_id,
                            cursor=cursor
                        )
                        conn.commit()
                    continue

            # ─── Condition (b2): Contact Ping Check-in Timeout (> 60s overdue) ───────
            if not active_alert_row and status == 'active' and escort['checkin_requested_at']:
                req_dt = parse_datetime_utc(escort['checkin_requested_at'])
                if req_dt and (now_utc - req_dt).total_seconds() > 60:
                    log_event(
                        user_id=user_id,
                        type='escort_checkin_missed',
                        actor='system',
                        detail={'reason': 'contact_ping_timeout'},
                        escort_id=escort_id,
                        cursor=cursor
                    )
                    ok, res, _ = create_alert_internal(
                        user_id=user_id,
                        user_name=user_name,
                        mode='emergency',
                        lat=lat,
                        lng=lng,
                        reason='missed_checkin',
                        note="Automated Escort Alert: Check-in requested by contact not answered within 60 seconds",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    if ok:
                        new_aid = res['id']
                        cursor.execute("UPDATE escorts SET alert_id = ?, status = 'alerted', checkin_requested_at = NULL, checkin_requested_by = NULL WHERE id = ?;", (new_aid, escort_id))
                        log_event(
                            user_id=user_id,
                            type='escort_alerted',
                            actor='system',
                            detail={'reason': 'missed_checkin', 'alert_id': new_aid},
                            escort_id=escort_id,
                            cursor=cursor
                        )
                        conn.commit()
                    continue

            # ─── Condition (c): No Signal (>5 min uneasy, >10 min escalate to normal) ─
            up_time_str = escort['last_update_at'] or escort['started_at']
            up_dt = parse_datetime_utc(up_time_str)
            seconds_since_update = (now_utc - up_dt).total_seconds() if up_dt else 0

            if seconds_since_update >= 600:
                # 10+ minutes without update
                if active_alert_row and active_alert_row['mode'] == 'uneasy':
                    # Escalate existing uneasy alert to normal
                    cursor.execute("UPDATE alerts SET mode = 'normal' WHERE id = ?;", (alert_id,))
                    log_event(
                        user_id=user_id,
                        type='alert_mode_changed',
                        actor='system',
                        detail={'old_mode': 'uneasy', 'new_mode': 'normal'},
                        alert_id=alert_id,
                        cursor=cursor
                    )
                    log_event(
                        user_id=user_id,
                        type='escort_alerted',
                        actor='system',
                        detail={'reason': 'no_signal_escalated', 'mode': 'normal', 'alert_id': alert_id},
                        escort_id=escort_id,
                        cursor=cursor
                    )
                    cursor.execute("UPDATE escorts SET status = 'alerted' WHERE id = ?;", (escort_id,))
                    conn.commit()
                    continue
                elif not active_alert_row:
                    ok, res, _ = create_alert_internal(
                        user_id=user_id,
                        user_name=user_name,
                        mode='normal',
                        lat=lat,
                        lng=lng,
                        reason='no_signal',
                        note="Automated Escort Alert: No position update for over 10 minutes",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    if ok:
                        new_aid = res['id']
                        cursor.execute("UPDATE escorts SET alert_id = ?, status = 'alerted' WHERE id = ?;", (new_aid, escort_id))
                        log_event(
                            user_id=user_id,
                            type='escort_alerted',
                            actor='system',
                            detail={'reason': 'no_signal', 'mode': 'normal', 'alert_id': new_aid},
                            escort_id=escort_id,
                            cursor=cursor
                        )
                        conn.commit()
                    continue

            elif seconds_since_update >= 300 and not active_alert_row:
                # 5+ minutes without update -> uneasy alert to close contacts
                ok, res, _ = create_alert_internal(
                    user_id=user_id,
                    user_name=user_name,
                    mode='uneasy',
                    lat=lat,
                    lng=lng,
                    reason='no_signal',
                    note="Automated Escort Alert: No position update for 5 minutes",
                    bypass_rate_limit=True,
                    cursor=cursor,
                    conn=conn
                )
                if ok:
                    new_aid = res['id']
                    cursor.execute("UPDATE escorts SET alert_id = ? WHERE id = ?;", (new_aid, escort_id))
                    log_event(
                        user_id=user_id,
                        type='escort_alerted',
                        actor='system',
                        detail={'reason': 'no_signal', 'mode': 'uneasy', 'alert_id': new_aid},
                        escort_id=escort_id,
                        cursor=cursor
                    )
                    conn.commit()
                continue

            # If an active alert already exists, do not trigger a second system alert
            if active_alert_row:
                continue

            # ─── Condition (d): Late Arrival (> 10 min past expected_end) ──────────
            if status != 'arrived' and escort['expected_end']:
                end_dt = parse_datetime_utc(escort['expected_end'])
                if end_dt and (now_utc - end_dt).total_seconds() > 600:
                    ok, res, _ = create_alert_internal(
                        user_id=user_id,
                        user_name=user_name,
                        mode='emergency',
                        lat=lat,
                        lng=lng,
                        reason='late_arrival',
                        note="Automated Escort Alert: Destination not reached 10 minutes past ETA",
                        bypass_rate_limit=True,
                        cursor=cursor,
                        conn=conn
                    )
                    if ok:
                        new_aid = res['id']
                        cursor.execute("UPDATE escorts SET alert_id = ?, status = 'alerted' WHERE id = ?;", (new_aid, escort_id))
                        log_event(
                            user_id=user_id,
                            type='escort_alerted',
                            actor='system',
                            detail={'reason': 'late_arrival', 'alert_id': new_aid},
                            escort_id=escort_id,
                            cursor=cursor
                        )
                        conn.commit()
                    continue

    except Exception as e:
        print(f"[EscortMonitor Error] {e}")
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def start_escort_monitor():
    """
    Launch background thread checking active escorts every 10 seconds.
    """
    def loop():
        time.sleep(5)
        while True:
            try:
                check_active_escorts()
            except Exception as e:
                print(f"[EscortMonitor Loop Error] {e}")
            time.sleep(10)

    monitor_thread = threading.Thread(target=loop, daemon=True, name="EscortSafetyMonitor")
    monitor_thread.start()
    print("[EscortMonitor] Escort mode background monitor running (10s intervals)")

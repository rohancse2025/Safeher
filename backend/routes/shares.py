# backend/routes/shares.py – Share Location sessions with per-contact tracking tokens & Brevo notifications
import os
import secrets
import datetime
from flask import Blueprint, request, jsonify, g

from db import get_db
from logger import app_logger
from routes.alerts import get_user_from_request
from services.notify import notify

shares_bp = Blueprint('shares', __name__)


# ─── Route: POST /api/shares ───────────────────────────────────
@shares_bp.route('/api/shares', methods=['POST'])
def create_share():
    """
    Start a new Share Location session.
    Payload:
      {
        "contact_ids": [1, 2, ...],      // optional list of contact IDs
        "duration_minutes": 60,           // optional integer (default 60 if not until_stopped)
        "until_stopped": false,           // boolean
        "lat": 12.9716,                   // optional initial latitude
        "lng": 77.5946                    // optional initial longitude
      }
    Generates one unique tracking token per selected contact, stores in share_contacts,
    and dispatches 'share_started' via notify().
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    user_id = user['id']
    user_name = (user.get('name') or 'SafeHer User').strip()
    data = request.get_json(silent=True) or {}

    until_stopped = bool(data.get('until_stopped', False))
    duration_min = data.get('duration_minutes')
    if not until_stopped:
        try:
            duration_min = int(duration_min) if duration_min is not None else 60
        except Exception:
            duration_min = 60
    else:
        duration_min = None

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    expires_at = None
    if duration_min and not until_stopped:
        expires_at = (now_utc + datetime.timedelta(minutes=duration_min)).strftime("%Y-%m-%d %H:%M:%S")

    lat = data.get('lat')
    lng = data.get('lng')

    conn = get_db()
    cursor = conn.cursor()

    # Cancel any previous active share for this user
    cursor.execute('''
        UPDATE shares
        SET status = 'ended', ended_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'active';
    ''', (user_id,))

    cursor.execute('''
        INSERT INTO shares (
            user_id, duration_minutes, until_stopped, started_at, expires_at,
            status, last_lat, last_lng, last_update_at
        ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'active', ?, ?, CURRENT_TIMESTAMP);
    ''', (user_id, duration_min, 1 if until_stopped else 0, expires_at, lat, lng))
    share_id = cursor.lastrowid

    # Resolve contacts: either specified or all user contacts
    contact_ids = data.get('contact_ids')
    if contact_ids and isinstance(contact_ids, list):
        contact_ids = [int(cid) for cid in contact_ids if str(cid).isdigit()]
    else:
        cursor.execute("SELECT id FROM contacts WHERE user_id = ?;", (user_id,))
        contact_ids = [r['id'] for r in cursor.fetchall()]

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens_map = {}
    tokens_list = []

    for cid in contact_ids:
        tok = secrets.token_urlsafe(32)
        cursor.execute('''
            INSERT INTO share_contacts (share_id, contact_id, token, created_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP);
        ''', (share_id, cid, tok))
        tokens_map[cid] = tok
        tokens_list.append({
            "contact_id": cid,
            "token": tok,
            "track_url": f"{frontend_url}/track.html?t={tok}"
        })

    conn.commit()
    conn.close()

    duration_desc = f"{duration_min} minutes" if not until_stopped else "until stopped"
    primary_tok = tokens_list[0]['token'] if tokens_list else secrets.token_urlsafe(32)

    # Dispatch share_started notification via central engine
    notify(
        event_type='share_started',
        user_id=user_id,
        context={
            'user_name': user_name,
            'duration_str': duration_desc,
            'lat': lat,
            'lng': lng,
            'share_id': share_id,
            'track_url': f"{frontend_url}/track.html?t={primary_tok}"
        },
        contact_ids=contact_ids,
        event_key=f"share:{share_id}:started"
    )

    app_logger.info(f"[SHARE STARTED] share_id={share_id}, user_id={user_id}, duration={duration_desc}, contacts={len(contact_ids)}")

    return jsonify({
        "ok": True,
        "message": f"Location sharing started ({duration_desc})",
        "data": {
            "id": share_id,
            "status": "active",
            "duration_minutes": duration_min,
            "until_stopped": until_stopped,
            "expires_at": expires_at,
            "contacts_count": len(contact_ids),
            "tokens": tokens_list
        }
    }), 201


# ─── Route: POST /api/shares/<id>/position ─────────────────────
@shares_bp.route('/api/shares/<int:share_id>/position', methods=['POST'])
def update_share_position(share_id):
    """
    Update real-time coordinates for an active share session.
    Payload: { "lat": 12.345, "lng": 77.567 }
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
        SELECT id, user_id, status FROM shares
        WHERE id = ? AND user_id = ?;
    ''', (share_id, user['id']))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Share session not found"}), 404

    if row['status'] != 'active':
        conn.close()
        return jsonify({"ok": False, "error": f"Share session is {row['status']}"}), 400

    cursor.execute('''
        UPDATE shares
        SET last_lat = ?, last_lng = ?, last_update_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (lat, lng, share_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "share_id": share_id,
            "lat": lat,
            "lng": lng
        }
    }), 200


# ─── Route: POST /api/shares/<id>/stop ─────────────────────────
@shares_bp.route('/api/shares/<int:share_id>/stop', methods=['POST'])
def stop_share(share_id):
    """
    End an active share location session.
    Dispatches 'share_ended' notification to contacts.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT s.id, s.user_id, s.status, u.name AS user_name
        FROM shares s
        JOIN users u ON s.user_id = u.id
        WHERE s.id = ? AND s.user_id = ?;
    ''', (share_id, user['id']))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Share session not found"}), 404

    if row['status'] != 'ended':
        cursor.execute('''
            UPDATE shares
            SET status = 'ended', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (share_id,))
        conn.commit()

    # Get contacts who had tokens for this share
    cursor.execute("SELECT contact_id FROM share_contacts WHERE share_id = ?;", (share_id,))
    c_rows = cursor.fetchall()
    c_ids = [r['contact_id'] for r in c_rows]
    conn.close()

    user_name = row['user_name'] or 'SafeHer User'

    notify(
        event_type='share_ended',
        user_id=row['user_id'],
        context={
            'user_name': user_name,
            'share_id': share_id
        },
        contact_ids=c_ids,
        event_key=f"share:{share_id}:ended"
    )

    app_logger.info(f"[SHARE ENDED] share_id={share_id}, user_id={row['user_id']}")

    return jsonify({
        "ok": True,
        "message": "Location sharing stopped safely",
        "data": {
            "share_id": share_id,
            "status": "ended"
        }
    }), 200


# ─── Route: GET /api/shares/active ─────────────────────────────
@shares_bp.route('/api/shares/active', methods=['GET'])
def get_active_share():
    """
    Return currently active location share session for authenticated user.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, duration_minutes, until_stopped, started_at, expires_at,
               status, last_lat, last_lng, last_update_at
        FROM shares
        WHERE user_id = ? AND status = 'active'
        ORDER BY id DESC LIMIT 1;
    ''', (user['id'],))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": True, "data": None}), 200

    cursor.execute('''
        SELECT contact_id, token FROM share_contacts WHERE share_id = ?;
    ''', (row['id'],))
    c_rows = cursor.fetchall()
    conn.close()

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens = [{"contact_id": r['contact_id'], "track_url": f"{frontend_url}/track.html?t={r['token']}"} for r in c_rows]

    share_dict = dict(row)
    share_dict['tokens'] = tokens

    return jsonify({
        "ok": True,
        "data": share_dict
    }), 200

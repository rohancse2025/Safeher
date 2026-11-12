# backend/routes/shares.py – Share Location sessions with per-contact tracking tokens & Brevo notifications
import os
import secrets
import datetime
from flask import Blueprint, request, jsonify, g

from db import get_db, execute_with_retry
from logger import app_logger
from routes.alerts import get_user_from_request
from services.notify import notify

shares_bp = Blueprint('shares', __name__)


def _extract_phones(data, user_id=None, contact_ids=None, conn=None):
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
    should_close = False
    if conn is None:
        try:
            conn = get_db()
            should_close = True
        except Exception:
            conn = None

    if conn:
        try:
            c = conn.cursor()
            if contact_ids:
                valid_cids = [int(cid) for cid in contact_ids if str(cid).isdigit()]
                if valid_cids:
                    c.execute("SELECT phone FROM contacts WHERE id IN ({});".format(','.join('?' for _ in valid_cids)), valid_cids)
                    for r in c.fetchall():
                        p = str(r['phone'] or '').strip()
                        if p and p not in phones:
                            phones.append(p)
            # 5. Database contacts for user_id
            if not phones and user_id:
                c.execute("SELECT phone FROM contacts WHERE user_id = ? AND phone NOT IN ('112', '181');", (user_id,))
                for r in c.fetchall():
                    p = str(r['phone'] or '').strip()
                    if p and p not in phones:
                        phones.append(p)
            # 6. Fallback to any saved non-emergency contacts in DB
            if not phones:
                c.execute("SELECT phone FROM contacts WHERE phone NOT IN ('112', '181') LIMIT 5;")
                for r in c.fetchall():
                    p = str(r['phone'] or '').strip()
                    if p and p not in phones:
                        phones.append(p)
        except Exception:
            pass
        finally:
            if should_close:
                try: conn.close()
                except Exception: pass

    return phones


# ─── Route: POST /api/shares ───────────────────────────────────
@shares_bp.route('/api/shares', methods=['POST'])
def create_share():
    """
    Start a new Share Location session.
    Payload:
      {
        "contact_ids": [1, 2, ...],      // optional list of contact IDs
        "contacts": [{phone, name}, ...], // optional client contacts list
        "phones": ["917483245232"],       // optional direct phone numbers
        "duration_minutes": 60,           // optional integer (default 60 if not until_stopped)
        "until_stopped": false,           // boolean
        "lat": 12.9716,                   // optional initial latitude
        "lng": 77.5946                    // optional initial longitude
      }
    Generates one unique tracking token per selected contact, stores in share_contacts,
    and dispatches 'share_started' via notify().
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    data = request.get_json(silent=True) or {}
    user_name = (data.get('user_name') or (user.get('name') if user else None) or 'SafeHer User').strip()

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
    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    client_token = (data.get('token') or '').strip()

    def _run_share_db():
        conn = get_db()
        try:
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

            tokens_map = {}
            tokens_list = []

            for idx, cid in enumerate(final_contact_ids):
                tok = client_token if (client_token and idx == 0) else secrets.token_urlsafe(32)
                try:
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
                except Exception:
                    tok = secrets.token_urlsafe(32)
                    try:
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
                    except Exception as e:
                        app_logger.warning(f"[SHARE CONTACT INSERT] cid={cid}: {e}")

            conn.commit()
            return share_id, tokens_map, tokens_list, final_contact_ids
        finally:
            conn.close()

    share_id, tokens_map, tokens_list, final_contact_ids = execute_with_retry(_run_share_db)

    duration_desc = f"{duration_min} minutes" if not until_stopped else "until stopped"
    primary_tok = tokens_list[0]['token'] if tokens_list else (client_token or secrets.token_urlsafe(32))

    # Dispatch automated WhatsApp notifications to selected contacts
    try:
        from whatsapp_service import send_location_share_whatsapp_notifications_background
        c_phones = _extract_phones(data, user_id=user_id, contact_ids=final_contact_ids)
        if not c_phones:
            c_phones = ['917483245232']
        if c_phones:
            send_location_share_whatsapp_notifications_background(
                share_id, user_name, duration_desc, lat or 0, lng or 0, c_phones, token=primary_tok
            )
            app_logger.info(f"[SHARE WHATSAPP DISPATCHED] share_id={share_id}, phones={c_phones}")
        else:
            app_logger.warning(f"[SHARE WHATSAPP DISPATCH] No phone numbers found for share_id={share_id}")
    except Exception as e:
        app_logger.warning(f"[SHARE WHATSAPP DISPATCH] {e}")

    # Dispatch share_started notification via central engine
    try:
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
            contact_ids=final_contact_ids,
            event_key=f"share:{share_id}:started"
        )
    except Exception as e:
        app_logger.warning(f"[SHARE NOTIFY] {e}")

    app_logger.info(f"[SHARE STARTED] share_id={share_id}, user_id={user_id}, duration={duration_desc}, contacts={len(final_contact_ids)}")

    return jsonify({
        "ok": True,
        "message": f"Location sharing started ({duration_desc})",
        "data": {
            "id": share_id,
            "status": "active",
            "duration_minutes": duration_min,
            "until_stopped": until_stopped,
            "expires_at": expires_at,
            "contacts_count": len(final_contact_ids),
            "tokens": tokens_list
        }
    }), 201


# ─── Route: POST /api/shares/<id>/position ─────────────────────
@shares_bp.route('/api/shares/<share_id>/position', methods=['POST'])
def update_share_position(share_id):
    """
    Update real-time coordinates for an active share session.
    Payload: { "lat": 12.345, "lng": 77.567 }
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
    if str(share_id).isdigit():
        cursor.execute("SELECT id, user_id, status FROM shares WHERE id = ?;", (int(share_id),))
        row = cursor.fetchone()

    token = data.get('token') or data.get('share_token')
    if not row and token:
        cursor.execute("SELECT share_id FROM share_contacts WHERE token = ?;", (token,))
        sc = cursor.fetchone()
        if sc:
            cursor.execute("SELECT id, user_id, status FROM shares WHERE id = ?;", (sc['share_id'],))
            row = cursor.fetchone()

    if not row:
        cursor.execute("SELECT id, user_id, status FROM shares WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
        row = cursor.fetchone()

    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Share session not found"}), 404

    real_share_id = row['id']
    if row['status'] != 'active':
        conn.close()
        return jsonify({"ok": False, "error": f"Share session is {row['status']}"}), 400

    cursor.execute('''
        UPDATE shares
        SET last_lat = ?, last_lng = ?, last_update_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (lat, lng, real_share_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "share_id": real_share_id,
            "lat": lat,
            "lng": lng
        }
    }), 200


# ─── Route: POST /api/shares/<id>/stop ─────────────────────────
@shares_bp.route('/api/shares/<share_id>/stop', methods=['POST'])
def stop_share(share_id):
    """
    End an active share location session.
    Dispatches 'share_ended' notification to contacts and automated WhatsApp.
    """
    data = request.get_json(silent=True) or {}
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 10000
    user_name = (data.get('user_name') or (user.get('name') if user else None) or 'SafeHer User').strip()

    conn = get_db()
    c_ids = []
    real_share_id = 0
    try:
        cursor = conn.cursor()

        sh_row = None
        if str(share_id).isdigit():
            cursor.execute("SELECT id, user_id, status FROM shares WHERE id = ?;", (int(share_id),))
            sh_row = cursor.fetchone()

        token = data.get('token') or data.get('share_token')
        if not sh_row and token:
            cursor.execute("SELECT share_id FROM share_contacts WHERE token = ?;", (token,))
            sc = cursor.fetchone()
            if sc:
                cursor.execute("SELECT id, user_id, status FROM shares WHERE id = ?;", (sc['share_id'],))
                sh_row = cursor.fetchone()

        if not sh_row:
            cursor.execute("SELECT id, user_id, status FROM shares WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1;", (user_id,))
            sh_row = cursor.fetchone()

        real_share_id = sh_row['id'] if sh_row else (int(share_id) if str(share_id).isdigit() else 0)

        if sh_row and sh_row['status'] != 'ended':
            cursor.execute('''
                UPDATE shares
                SET status = 'ended', ended_at = CURRENT_TIMESTAMP
                WHERE id = ?;
            ''', (real_share_id,))
            conn.commit()

        # Get contacts who had tokens for this share
        cursor.execute("SELECT contact_id FROM share_contacts WHERE share_id = ?;", (real_share_id,))
        c_rows = cursor.fetchall()
        c_ids = [r['contact_id'] for r in c_rows if r['contact_id']]
    finally:
        conn.close()

    # Extract all recipient phones from payload, contacts table, or DB
    sh_phones = _extract_phones(data, user_id=user_id, contact_ids=c_ids)

    try:
        from whatsapp_service import send_share_stopped_whatsapp_notifications_background
        if sh_phones:
            send_share_stopped_whatsapp_notifications_background(real_share_id, user_name, sh_phones)
            app_logger.info(f"[SHARE STOP WHATSAPP DISPATCHED] share_id={real_share_id}, phones={sh_phones}")
    except Exception as e:
        app_logger.warning(f"[SHARE STOP WHATSAPP DISPATCH] {e}")

    try:
        notify(
            event_type='share_ended',
            user_id=user_id,
            context={
                'user_name': user_name,
                'share_id': real_share_id
            },
            contact_ids=c_ids,
            event_key=f"share:{real_share_id}:ended"
        )
    except Exception:
        pass

    app_logger.info(f"[SHARE ENDED] share_id={real_share_id}, user_id={user_id}")

    return jsonify({
        "ok": True,
        "message": "Location sharing stopped safely",
        "data": {
            "share_id": real_share_id,
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

    # Query recent contact responses for this user (deduplicated by contact & status)
    cursor.execute('''
        SELECT detail_json, ts FROM incident_events
        WHERE user_id = ? AND type = 'contact_responded' AND ts >= datetime('now', '-2 hours')
        ORDER BY id DESC LIMIT 20;
    ''', (user['id'],))
    ev_rows = cursor.fetchall()
    responses = []
    seen_contact_statuses = set()
    import json as py_json
    for ev in ev_rows:
        try:
            raw_det = ev['detail_json']
            det = py_json.loads(raw_det) if isinstance(raw_det, str) else raw_det
            if isinstance(det, dict) and det.get('status'):
                c_name = str(det.get('contact') or 'Emergency Contact').strip()
                c_status = str(det.get('status')).strip()
                dedup_key = (c_name.lower(), c_status.lower())
                if dedup_key not in seen_contact_statuses:
                    seen_contact_statuses.add(dedup_key)
                    responses.append({
                        "name": c_name,
                        "status": c_status,
                        "time": ev['ts']
                    })
        except Exception:
            pass

    conn.close()

    frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
    tokens = [{"contact_id": r['contact_id'], "track_url": f"{frontend_url}/track.html?t={r['token']}"} for r in c_rows]

    share_dict = dict(row)
    share_dict['tokens'] = tokens
    share_dict['contact_responses'] = responses

    return jsonify({
        "ok": True,
        "data": share_dict
    }), 200

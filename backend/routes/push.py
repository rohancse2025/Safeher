# backend/routes/push.py – Web Push subscription management and notification dispatcher
import os
import json
import logging
import threading
from flask import Blueprint, request, jsonify, g
from dotenv import load_dotenv
from pywebpush import webpush, WebPushException
from db import get_db
from logger import app_logger
from routes.auth import login_required

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'))
load_dotenv()

push_bp = Blueprint('push', __name__)

logger = logging.getLogger(__name__)


def get_vapid_config():
    """
    Load VAPID configuration from environment settings.
    """
    private_key = os.getenv('VAPID_PRIVATE_KEY')
    public_key = os.getenv('VAPID_PUBLIC_KEY')
    sub = os.getenv('VAPID_CLAIMS_SUB', 'mailto:admin@safeher.local')
    return private_key, public_key, sub


# ─── Public VAPID Key Endpoint ──────────────────────────────────────────
@push_bp.route('/api/push/vapid-public-key', methods=['GET'])
def get_vapid_public_key():
    """
    Return the public VAPID key for client push subscriptions.
    """
    _, public_key, _ = get_vapid_config()
    if not public_key:
        return jsonify({"ok": False, "error": "VAPID public key not configured on server"}), 500
    return jsonify({
        "ok": True,
        "data": {
            "public_key": public_key
        }
    }), 200


# ─── Subscribe Route ───────────────────────────────────────────────────
@push_bp.route('/api/push/subscribe', methods=['POST'])
@login_required
def subscribe():
    """
    Store or update a user's Web Push subscription.
    Expects JSON: { endpoint: str, keys: { p256dh: str, auth: str } }
               or { endpoint: str, p256dh: str, auth: str }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}

    endpoint = (data.get('endpoint') or '').strip()
    keys = data.get('keys') or {}
    p256dh = (keys.get('p256dh') or data.get('p256dh') or '').strip()
    auth = (keys.get('auth') or data.get('auth') or '').strip()

    if not endpoint or not p256dh or not auth:
        return jsonify({"ok": False, "error": "Endpoint, p256dh, and auth are required"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            created_at = CURRENT_TIMESTAMP;
    ''', (user_id, endpoint, p256dh, auth))
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "data": {"message": "Subscribed to push notifications successfully"}}), 200


# ─── Unsubscribe Route ─────────────────────────────────────────────────
@push_bp.route('/api/push/unsubscribe', methods=['POST'])
@login_required
def unsubscribe():
    """
    Remove a Web Push subscription.
    Expects JSON: { endpoint: str }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}
    endpoint = (data.get('endpoint') or '').strip()

    if not endpoint:
        return jsonify({"ok": False, "error": "Endpoint is required"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?;', (endpoint, user_id))
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "data": {"message": "Unsubscribed from push notifications successfully"}}), 200


# ─── Push Dispatch Helpers ─────────────────────────────────────────────
def send_single_push(sub_row, payload):
    """
    Send a single Web Push notification.
    If the push service returns 404 or 410, delete the expired subscription.
    """
    priv_key, pub_key, sub = get_vapid_config()
    if not priv_key:
        logger.warning("[WebPush] Cannot send notification: VAPID_PRIVATE_KEY not set")
        return

    sub_info = {
        "endpoint": sub_row['endpoint'],
        "keys": {
            "p256dh": sub_row['p256dh'],
            "auth": sub_row['auth']
        }
    }

    try:
        webpush(
            subscription_info=sub_info,
            data=json.dumps(payload),
            vapid_private_key=priv_key,
            vapid_claims={"sub": sub}
        )
        alert_id_val = payload.get('data', {}).get('alert_id') or payload.get('data', {}).get('timer_id') or 'N/A'
        app_logger.info(f"[PUSH SENT] alert_id={alert_id_val}, user_id={sub_row['user_id']}")
    except WebPushException as ex:
        status_code = getattr(ex.response, 'status_code', None) if ex.response is not None else None
        alert_id_val = payload.get('data', {}).get('alert_id') or payload.get('data', {}).get('timer_id') or 'N/A'
        app_logger.error(f"[PUSH FAILED] alert_id={alert_id_val}, user_id={sub_row['user_id']}, status={status_code}, error={ex}")
        # Remove subscriptions that return 404 or 410
        if status_code in (404, 410):
            logger.info(f"[WebPush] Subscription expired ({status_code}), removing dead subscription")
            try:
                conn = get_db()
                conn.execute('DELETE FROM push_subscriptions WHERE endpoint = ?;', (sub_row['endpoint'],))
                conn.commit()
                conn.close()
            except Exception as del_err:
                app_logger.error(f"[WebPush] Failed removing dead subscription: {del_err}")
        else:
            logger.warning(f"[WebPush] Delivery failed ({status_code}): {ex}")
    except Exception as ex:
        alert_id_val = payload.get('data', {}).get('alert_id') or payload.get('data', {}).get('timer_id') or 'N/A'
        app_logger.error(f"[PUSH FAILED] alert_id={alert_id_val}, user_id={sub_row['user_id']}, error={ex}")


def dispatch_push_to_users(user_ids, payload):
    """
    Asynchronously send a Web Push notification to all subscriptions of given user IDs.
    """
    if not user_ids:
        return

    def _worker():
        try:
            conn = get_db()
            cursor = conn.cursor()
            placeholders = ','.join('?' for _ in user_ids)
            cursor.execute(f'''
                SELECT id, user_id, endpoint, p256dh, auth
                FROM push_subscriptions
                WHERE user_id IN ({placeholders});
            ''', tuple(user_ids))
            subs = cursor.fetchall()
            conn.close()

            for s in subs:
                send_single_push(s, payload)
        except Exception as err:
            logger.error(f"[WebPush] Error fetching subscriptions for users {user_ids}: {err}")

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()


def notify_nearby_volunteers_on_alert(alert_id, alert_mode, alert_lat, alert_lng, exclude_user_id):
    """
    Push to available approved volunteers within 2 km of an alert.
    Title: "Someone nearby needs help", body: distance only, never the name.
    If alert_mode is silent, push is sent with silent=True (no sound).
    """
    if alert_lat is None or alert_lng is None:
        return

    def _worker():
        import math
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute('''
                SELECT v.user_id, v.lat, v.lng
                FROM volunteers v
                WHERE v.available = 1 AND v.status = 'approved' AND v.user_id != ?
                  AND v.lat IS NOT NULL AND v.lng IS NOT NULL;
            ''', (exclude_user_id,))
            volunteers = cursor.fetchall()

            for vol in volunteers:
                v_lat = vol['lat']
                v_lng = vol['lng']
                # Haversine distance
                dlat = math.radians(v_lat - alert_lat)
                dlon = math.radians(v_lng - alert_lng)
                a = (math.sin(dlat / 2) ** 2 +
                     math.cos(math.radians(alert_lat)) * math.cos(math.radians(v_lat)) * math.sin(dlon / 2) ** 2)
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                dist_km = 6371.0 * c

                if dist_km <= 2.0:
                    cursor.execute('''
                        SELECT id, user_id, endpoint, p256dh, auth
                        FROM push_subscriptions
                        WHERE user_id = ?;
                    ''', (vol['user_id'],))
                    subs = cursor.fetchall()

                    payload = {
                        "title": "Someone nearby needs help",
                        "body": f"Distance: {round(dist_km, 1)} km",
                        "data": {
                            "screen": "volunteers",
                            "alert_id": alert_id,
                            "distance_km": round(dist_km, 1)
                        },
                        "silent": (alert_mode == 'silent')
                    }

                    for s in subs:
                        send_single_push(s, payload)

            conn.close()
        except Exception as err:
            logger.error(f"[WebPush] Error notifying nearby volunteers for alert {alert_id}: {err}")

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()


def notify_victim_volunteer_coming(victim_user_id, alert_id, alert_mode):
    """
    Push to victim when a volunteer taps "I'm coming".
    Never sends push for silent-mode alerts (silent alerts go only to nearby volunteers).
    """
    if alert_mode == 'silent':
        # Rule: Never send a push for silent-mode alerts to anyone except approved volunteers within range
        return

    payload = {
        "title": "A volunteer is on the way",
        "body": "A volunteer has responded and is heading to your location.",
        "data": {
            "screen": "sos-active",
            "alert_id": alert_id
        },
        "silent": False
    }
    dispatch_push_to_users([victim_user_id], payload)


def notify_user_timer_expired(user_id, timer_id):
    """
    Push to user when their safe-arrival timer expires.
    """
    payload = {
        "title": "Safe Arrival Timer Expired",
        "body": "Your safe arrival timer has expired and your emergency contacts have been alerted.",
        "data": {
            "screen": "sos-active",
            "timer_id": timer_id
        },
        "silent": False
    }
    dispatch_push_to_users([user_id], payload)


def notify_alert_owner_contact_response(owner_user_id, alert_id, contact_name, status):
    """
    Send a Web Push notification to the alert owner for each new contact response,
    if she has subscribed.
    """
    status_label_map = {
        'on_my_way': "I'm on my way",
        'called': "I called her",
        'alerted_police': "I alerted police",
        'cannot_reach': "I can't reach her"
    }
    action_label = status_label_map.get(status, status)
    payload = {
        "title": f"Contact Update: {contact_name}",
        "body": f"{contact_name}: {action_label}",
        "data": {
            "screen": "sos-active",
            "alert_id": alert_id,
            "status": status,
            "contact_name": contact_name
        },
        "silent": False
    }
    dispatch_push_to_users([owner_user_id], payload)


# backend/routes/notifications.py – Notification outbox, settings, Brevo webhook & optout routes
import os
import re
import json
import time
from datetime import datetime
from flask import Blueprint, request, jsonify, g

from db import get_db
from logger import app_logger
from routes.auth import login_required
from routes.alerts import get_user_from_request
from services.notify import (
    notify,
    process_outbox,
    mask_email,
    is_sos_event
)

notifications_bp = Blueprint('notifications', __name__)

DEFAULT_WEBHOOK_SECRET = os.getenv('BREVO_WEBHOOK_SECRET', 'safeher_brevo_webhook_secret_2026')


# ─── Route: GET /api/notifications ───────────────────────────
@notifications_bp.route('/api/notifications', methods=['GET'])
def get_notifications():
    """
    List recent notification logs for the user (Owner only / Authenticated user).
    Never exposes raw recipient email addresses or private keys.
    Query param: limit (default 50, max 200)
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None

    limit = 50
    try:
        limit = min(int(request.args.get('limit', 50)), 200)
    except Exception:
        limit = 50

    conn = get_db()
    cursor = conn.cursor()

    event_key_prefix = request.args.get('event_key_prefix')
    event_key = request.args.get('event_key')
    alert_id = request.args.get('alert_id')

    query = '''
        SELECT n.id, n.user_id, n.alert_id, n.event_type, n.event_key, n.contact_id, n.channel,
               n.recipient_masked, n.subject, n.status, n.attempts, n.last_error,
               n.next_attempt_at, n.created_at, n.sent_at, n.delivered_at, n.provider_message_id,
               c.name AS contact_name
        FROM notifications n
        LEFT JOIN contacts c ON c.id = n.contact_id
        WHERE 1=1
    '''
    params = []
    if user_id:
        query += ' AND n.user_id = ?'
        params.append(user_id)
    if event_key_prefix:
        query += ' AND n.event_key LIKE ?'
        params.append(event_key_prefix + '%')
    if event_key:
        query += ' AND n.event_key = ?'
        params.append(event_key)
    if alert_id:
        try:
            query += ' AND n.alert_id = ?'
            params.append(int(alert_id))
        except Exception:
            pass

    query += ' ORDER BY n.id DESC LIMIT ?;'
    params.append(limit)

    cursor.execute(query, tuple(params))

    rows = cursor.fetchall()
    conn.close()

    items = [dict(r) for r in rows]
    return jsonify({
        "ok": True,
        "count": len(items),
        "data": items
    }), 200


# ─── Route: POST /api/notifications/<id>/retry ───────────────
@notifications_bp.route('/api/notifications/<int:notif_id>/retry', methods=['POST'])
def retry_notification(notif_id):
    """
    Requeue a failed, bounced, or stuck notification for immediate resend.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None

    conn = get_db()
    cursor = conn.cursor()

    if user_id:
        cursor.execute('''
            SELECT id, user_id, recipient_masked, status
            FROM notifications
            WHERE id = ? AND user_id = ?;
        ''', (notif_id, user_id))
    else:
        cursor.execute('SELECT id, user_id, recipient_masked, status FROM notifications WHERE id = ?;', (notif_id,))

    row = cursor.fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "error": "Notification record not found"}), 404

    cursor.execute('''
        UPDATE notifications
        SET status = 'queued',
            next_attempt_at = CURRENT_TIMESTAMP,
            last_error = NULL
        WHERE id = ?;
    ''', (notif_id,))
    conn.commit()
    conn.close()

    app_logger.info(f"[NOTIFY REQUEUE] Notification #{notif_id} requeued by user {user_id or 'admin'}")

    # Trigger process outbox in background
    import threading
    threading.Thread(target=process_outbox, daemon=True, name="RetryOutboxWorker").start()

    return jsonify({
        "ok": True,
        "message": f"Notification #{notif_id} requeued for immediate send",
        "data": {
            "id": notif_id,
            "status": "queued"
        }
    }), 200


# ─── Route: POST /api/notifications/test ─────────────────────
@notifications_bp.route('/api/notifications/test', methods=['POST'])
def test_notification():
    """
    Send a sample of an event type to the owner's own email.
    Body JSON: { "event_type": "sos" | "escort_start" | "ride_start" | ... }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 1

    data = request.get_json(silent=True) or {}
    event_type = (data.get('event_type') or 'sos').strip().lower()

    # Determine recipient: owner email from user profile or fallback
    owner_email = None
    user_name = 'SafeHer User'
    if user:
        owner_email = user.get('email')
        user_name = user.get('name') or user_name

    if not owner_email:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT email, name FROM users WHERE id = ?;", (user_id,))
        u = cursor.fetchone()
        if u:
            owner_email = u['email']
            user_name = u['name'] or user_name
        conn.close()

    if not owner_email:
        owner_email = os.getenv('EMAIL_FROM', 'rohanrao1803@gmail.com')

    context = {
        'user_name': user_name,
        'lat': 12.9716,
        'lng': 77.5946,
        'destination': 'Whitefield Metro Station',
        'vehicle_type': 'Auto',
        'vehicle_number': 'KA-04-AB-1234',
        'minutes': 15,
        'recipient_email': owner_email,
        'note': 'This is a test notification generated by SafeHer diagnostics.'
    }

    event_key = f"test_{event_type}_{user_id}_{int(time.time()*1000)}"
    created_ids = notify(
        event_type=event_type,
        user_id=user_id,
        context=context,
        event_key=event_key
    )

    masked = mask_email(owner_email)
    return jsonify({
        "ok": True,
        "message": f"Test notification for '{event_type}' queued for {masked}",
        "data": {
            "event_type": event_type,
            "recipient_masked": masked,
            "notification_ids": created_ids
        }
    }), 200


# ─── Route: GET /api/notification-settings ───────────────────
@notifications_bp.route('/api/notification-settings', methods=['GET'])
def get_notification_settings():
    """
    Get email alert settings for the authenticated user.
    All settings are enabled by default. SOS is always true.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 1

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT event_type, enabled
        FROM notification_settings
        WHERE user_id = ?;
    ''', (user_id,))
    rows = cursor.fetchall()
    conn.close()

    # Standard default settings covering all event types
    settings = {
        "alert_created": True,
        "alert_uneasy": True,
        "alert_escalated": True,
        "alert_ended": True,
        "volunteer_coming": True,
        "escort_started": True,
        "escort_arrived": True,
        "escort_off_route": True,
        "escort_missed_checkin": True,
        "escort_no_signal": True,
        "escort_late_arrival": True,
        "escort_ended": True,
        "timer_expired": True,
        "share_started": True,
        "share_ended": True,
        "ride_started": True,
        "ride_ended": True,
        "ride_late": True,
        "contact_added": True,
        "alert_reminders": True,
        "alert_reminder": True,
        # Backward compatibility aliases
        "sos": True,
        "sos_safe": True,
        "escort_start": True,
        "escort_safe": True,
        "escort_alert": True,
        "share_start": True,
        "share_stop": True,
        "timer_start": True,
        "timer_safe": True,
        "ride_start": True,
        "ride_safe": True,
        "welcome": True
    }

    # Overlay user-saved preferences
    for r in rows:
        et = r['event_type']
        val = bool(r['enabled'])
        if is_sos_event(et):
            settings[et] = True  # Can never be disabled
        else:
            settings[et] = val

    return jsonify({
        "ok": True,
        "data": {
            "user_id": user_id,
            "settings": settings,
            "locked_events": sorted([k for k in settings.keys() if is_sos_event(k)])
        }
    }), 200


# ─── Route: PUT /api/notification-settings ───────────────────
@notifications_bp.route('/api/notification-settings', methods=['PUT'])
def update_notification_settings():
    """
    Update email alert settings for the authenticated user.
    SOS events can NEVER be disabled.
    Accepts JSON: { "settings": { "event_name": boolean } } or { "event_type": str, "enabled": boolean }
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else 1

    data = request.get_json(silent=True) or {}
    updates = data.get('settings')
    if updates is None and 'event_type' in data:
        updates = {data['event_type']: data.get('enabled', True)}

    if not isinstance(updates, dict):
        return jsonify({"ok": False, "error": "Invalid payload format. Expected { settings: { event_type: boolean } }"}), 400

    conn = get_db()
    cursor = conn.cursor()
    enforced_notes = []

    for event_type, enabled in updates.items():
        event_type = str(event_type).strip().lower()
        val = bool(enabled)

        # SOS events can NEVER be disabled
        if is_sos_event(event_type) and not val:
            val = True
            enforced_notes.append(f"SOS alert '{event_type}' cannot be disabled for personal safety")

        int_val = 1 if val else 0
        cursor.execute('''
            INSERT INTO notification_settings (user_id, event_type, enabled, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, event_type) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = CURRENT_TIMESTAMP;
        ''', (user_id, event_type, int_val))

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "message": "Notification settings updated successfully",
        "notes": enforced_notes
    }), 200


# ─── Route: POST /api/brevo/webhook/<secret> ─────────────────
@notifications_bp.route('/api/brevo/webhook/<secret>', methods=['POST'])
def brevo_webhook(secret):
    """
    Receive Brevo transactional webhook delivery, bounce, and block events.
    Matches notification by provider_message_id, updates delivery status,
    and flags contact email_status as 'bounced' on hard bounces.
    """
    expected_secret = os.getenv('BREVO_WEBHOOK_SECRET', DEFAULT_WEBHOOK_SECRET)
    if secret != expected_secret:
        app_logger.warning(f"[BREVO WEBHOOK] Unauthorized webhook attempt with invalid secret")
        return jsonify({"ok": False, "error": "Invalid webhook secret"}), 401

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"ok": False, "error": "Empty or non-JSON webhook body"}), 400

    # Payload may be a list of events or a single event dictionary
    events = payload if isinstance(payload, list) else [payload]
    processed_count = 0

    conn = get_db()
    cursor = conn.cursor()

    try:
        for ev in events:
            if not isinstance(ev, dict):
                continue

            event_name = (ev.get('event') or '').strip().lower()
            # Brevo sends 'message-id' or 'messageId'
            msg_id = (ev.get('message-id') or ev.get('messageId') or '').strip()
            # Strip angle brackets if present: <abc@domain> -> abc@domain
            clean_msg_id = msg_id.strip('<>') if msg_id else None
            recipient_email = (ev.get('email') or '').strip().lower()
            reason = str(ev.get('reason') or ev.get('description') or event_name)

            masked_recip = mask_email(recipient_email)
            app_logger.info(f"[BREVO WEBHOOK] Event='{event_name}' recipient={masked_recip} msgId={clean_msg_id}")

            # Find matching notification
            target_notif = None
            if clean_msg_id:
                cursor.execute('''
                    SELECT id, contact_id, status FROM notifications
                    WHERE provider_message_id = ? OR provider_message_id = ?
                    ORDER BY id DESC LIMIT 1;
                ''', (clean_msg_id, f"<{clean_msg_id}>"))
                target_notif = cursor.fetchone()

            if not target_notif and recipient_email:
                # Match latest notification sent to that email
                cursor.execute('''
                    SELECT id, contact_id, status FROM notifications
                    WHERE recipient_email = ?
                    ORDER BY id DESC LIMIT 1;
                ''', (recipient_email,))
                target_notif = cursor.fetchone()

            notif_id = target_notif['id'] if target_notif else None
            contact_id = target_notif['contact_id'] if target_notif else None

            # Process by Brevo event name
            if event_name in ('delivered', 'delivered_at'):
                if notif_id:
                    cursor.execute('''
                        UPDATE notifications
                        SET status = 'delivered',
                            delivered_at = CURRENT_TIMESTAMP,
                            last_error = NULL
                        WHERE id = ?;
                    ''', (notif_id,))
                if contact_id:
                    cursor.execute("UPDATE contacts SET email_status = 'ok' WHERE id = ?;", (contact_id,))
                processed_count += 1

            elif event_name in ('hard_bounce', 'soft_bounce'):
                if notif_id:
                    cursor.execute('''
                        UPDATE notifications
                        SET status = 'bounced',
                            last_error = ?
                        WHERE id = ?;
                    ''', (f"Bounce: {reason}", notif_id))

                # On hard bounce, mark contact as permanently bounced
                if event_name == 'hard_bounce':
                    if contact_id:
                        cursor.execute("UPDATE contacts SET email_status = 'bounced' WHERE id = ?;", (contact_id,))
                    elif recipient_email:
                        cursor.execute("UPDATE contacts SET email_status = 'bounced' WHERE email = ?;", (recipient_email,))
                processed_count += 1

            elif event_name in ('blocked', 'invalid_email', 'spam'):
                if notif_id:
                    cursor.execute('''
                        UPDATE notifications
                        SET status = 'blocked',
                            last_error = ?
                        WHERE id = ?;
                    ''', (f"Blocked: {reason}", notif_id))

                if contact_id:
                    cursor.execute("UPDATE contacts SET email_status = 'bounced' WHERE id = ?;", (contact_id,))
                elif recipient_email:
                    cursor.execute("UPDATE contacts SET email_status = 'bounced' WHERE email = ?;", (recipient_email,))
                processed_count += 1

            elif event_name in ('error', 'deferred'):
                if notif_id:
                    cursor.execute('''
                        UPDATE notifications
                        SET status = 'failed',
                            last_error = ?
                        WHERE id = ?;
                    ''', (f"Error: {reason}", notif_id))
                processed_count += 1

        conn.commit()

    finally:
        conn.close()

    return jsonify({
        "ok": True,
        "processed": processed_count
    }), 200


# ─── Route: GET /api/optout/<token> ──────────────────────────
@notifications_bp.route('/api/optout/<token>', methods=['GET'])
def optout_contact(token):
    """
    1-Click consent opt-out link embedded in every email footer.
    Sets opted_out = 1 for that contact and renders a calm, clear HTML confirmation page.
    """
    token = str(token).strip()
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT c.id, c.name, c.email, c.user_id, u.name AS user_name
        FROM contacts c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.optout_token = ?;
    ''', (token,))
    contact = cursor.fetchone()

    if not contact:
        conn.close()
        return """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeHer – Opt-Out</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #F9FAFB; padding: 40px 20px; color: #1F2937; text-align: center; }
    .card { max-width: 440px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 12px; border: 1px solid #E5E7EB; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { font-size: 18px; margin: 0 0 10px 0; color: #9E1B32; }
    p { font-size: 14px; color: #4B5563; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Link Not Found or Expired</h1>
    <p>This opt-out link is invalid or has already been processed. If you need assistance, please contact SafeHer support.</p>
  </div>
</body>
</html>""", 404

    c_id = contact['id']
    user_name = contact['user_name'] or 'the user'
    masked_email = mask_email(contact['email'])

    cursor.execute("UPDATE contacts SET opted_out = 1 WHERE id = ?;", (c_id,))
    conn.commit()
    conn.close()

    app_logger.info(f"[OPTOUT] Contact #{c_id} ({masked_email}) opted out of alerts for user {contact['user_id']}")

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeHer – Opt-Out Confirmed</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F9FAFB; padding: 40px 20px; color: #1F2937; text-align: center; }}
    .card {{ max-width: 480px; margin: 0 auto; background: #FFFFFF; padding: 36px 28px; border-radius: 12px; border: 1px solid #E5E7EB; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }}
    .icon {{ width: 48px; height: 48px; border-radius: 50%; background: #F0FDF4; color: #16A34A; display: inline-flex; align-items: center; justify-content: center; font-size: 24px; margin-bottom: 16px; }}
    h1 {{ font-size: 20px; margin: 0 0 12px 0; color: #111827; font-weight: 600; }}
    p {{ font-size: 14px; color: #4B5563; line-height: 1.6; margin: 0 0 16px 0; }}
    .notice {{ background: #F3F4F6; padding: 12px 16px; border-radius: 6px; font-size: 12px; color: #6B7280; margin-top: 20px; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Opt-Out Confirmed</h1>
    <p>You have successfully opted out of receiving emergency safety alerts for <strong>{user_name}</strong>.</p>
    <p>Your email address (<code>{masked_email}</code>) will no longer receive automated notifications from this account.</p>
    <div class="notice">
      If this was done in error, {user_name} can re-enable your alerts in her SafeHer emergency contacts settings.
    </div>
  </div>
</body>
</html>""", 200


# ─── Route: POST /api/internal/tick ──────────────────────────
@notifications_bp.route('/api/internal/tick', methods=['POST'])
def internal_tick():
    """
    On-demand or cron-triggered outbox processing tick.
    """
    count = process_outbox(limit=50)
    return jsonify({
        "ok": True,
        "processed": count,
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }), 200

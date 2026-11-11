# backend/services/notify.py – Central email notification engine with Brevo outbox & retries
import os
import re
import json
import time
import secrets
import threading
import urllib.request
import urllib.error
from datetime import datetime, timedelta

from db import get_db
from logger import app_logger
from services.templates import render_template, format_ist_time

# Retry backoff schedule in seconds: 1m, 5m, 15m, 30m, 60m (up to 5 attempts)
RETRY_DELAYS = [60, 300, 900, 1800, 3600]
MAX_ATTEMPTS = 5

# SOS events that can NEVER be turned off
SOS_EVENT_TYPES = {
    'sos', 'emergency', 'silent', 'uneasy', 'sos_safe',
    'alert_resolved', 'safe', 'timer_expired', 'escort_alert',
    'alert_created', 'alert_uneasy', 'alert_escalated', 'alert_ended',
    'normal', 'escalated', 'volunteer_coming',
    'escort_off_route', 'escort_missed_checkin', 'escort_no_signal',
    'escort_late_arrival', 'ride_late'
}


def mask_email(email):
    """
    Safely mask an email address for logging and database visibility.
    Never logs or exposes full email addresses.
    Example: 'rohanrao1803@gmail.com' -> 'r***3@gmail.com'
             'test@example.com'      -> 't***t@example.com'
             'a@b.com'               -> 'a***@b.com'
    """
    if not email or not isinstance(email, str) or '@' not in email:
        return 'N/A'
    email = email.strip().lower()
    parts = email.split('@', 1)
    user_part, domain_part = parts[0], parts[1]

    if len(user_part) <= 1:
        masked_user = f"{user_part}***"
    elif len(user_part) == 2:
        masked_user = f"{user_part[0]}***"
    else:
        masked_user = f"{user_part[0]}***{user_part[-1]}"

    return f"{masked_user}@{domain_part}"


def is_sos_event(event_type):
    """Check if an event type is an emergency SOS alert."""
    return str(event_type).strip().lower() in SOS_EVENT_TYPES


def is_event_enabled_for_user(user_id, event_type, conn=None):
    """
    Check notification_settings table.
    All events are enabled by default (True).
    SOS events can NEVER be disabled.
    """
    if is_sos_event(event_type):
        return True

    should_close = False
    if conn is None:
        conn = get_db()
        should_close = True

    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT enabled FROM notification_settings
            WHERE user_id = ? AND event_type = ?;
        ''', (user_id, event_type))
        row = cursor.fetchone()
        if row is not None:
            return bool(row['enabled'])
        return True
    finally:
        if should_close:
            conn.close()


def notify(event_type, user_id, context=None, contact_ids=None, alert_id=None, event_key=None):
    """
    Central notification dispatcher.
    Chooses recipients by event rules, enforces consent & opt-out, renders calm templates,
    persists outbox rows (with idempotency on event_key + contact_id + channel),
    and triggers process_outbox in the background.

    Returns:
        list of created/processed notification IDs.
    """
    context = dict(context or {})
    event_type = str(event_type).strip().lower()

    # 1. Enforce notification settings (SOS events can NEVER be turned off)
    if not is_event_enabled_for_user(user_id, event_type):
        app_logger.info(f"[NOTIFY] Event {event_type} disabled by user {user_id}. Skipping.")
        return []

    # 2. Determine base event key for deduplication
    if not event_key:
        alert_tag = str(alert_id) if alert_id else '0'
        ts_tag = int(time.time() * 1000)
        event_key = f"{event_type}_{user_id}_{alert_tag}_{ts_tag}"

    conn = get_db()
    cursor = conn.cursor()
    created_notification_ids = []

    try:
        # Resolve user name if missing
        if not context.get('user_name'):
            cursor.execute("SELECT name FROM users WHERE id = ?;", (user_id,))
            u_row = cursor.fetchone()
            if u_row and u_row['name']:
                context['user_name'] = u_row['name']
            else:
                context['user_name'] = 'SafeHer User'

        # Set standard IST time in context if missing
        if not context.get('time_str'):
            context['time_str'] = format_ist_time()

        backend_url = os.getenv('BACKEND_URL', 'https://safeher-dwkj.onrender.com').rstrip('/')

        # 3. Determine recipients
        # Special case: direct test email passed in context
        direct_recipient = context.get('recipient_email')
        if direct_recipient:
            masked = mask_email(direct_recipient)
            subject, body_text, body_html = render_template(event_type, context)
            try:
                cursor.execute('''
                    INSERT INTO notifications (
                        user_id, alert_id, event_type, event_key, contact_id, channel,
                        recipient_masked, recipient_email, subject, body_text, body_html,
                        status, attempts, last_error, next_attempt_at
                    ) VALUES (?, ?, ?, ?, NULL, 'email', ?, ?, ?, ?, ?, 'queued', 0, NULL, CURRENT_TIMESTAMP);
                ''', (
                    user_id, alert_id, event_type, event_key,
                    masked, direct_recipient, subject, body_text, body_html
                ))
                created_notification_ids.append(cursor.lastrowid)
            except Exception as e:
                app_logger.warning(f"[NOTIFY DUP] Direct email for {event_key} ignored: {e}")

            conn.commit()
            _trigger_outbox_background()
            return created_notification_ids

        # Fetch contacts for user
        if contact_ids:
            placeholders = ','.join(['?'] * len(contact_ids))
            cursor.execute(f'''
                SELECT id, name, email, phone, opted_out, email_status, optout_token
                FROM contacts
                WHERE user_id = ? AND id IN ({placeholders})
                ORDER BY id ASC;
            ''', [user_id] + list(contact_ids))
        else:
            cursor.execute('''
                SELECT id, name, email, phone, opted_out, email_status, optout_token
                FROM contacts
                WHERE user_id = ?
                ORDER BY id ASC;
            ''', (user_id,))
        contacts = cursor.fetchall()

        if not contacts:
            app_logger.info(f"[NOTIFY] No contacts found for user {user_id} on event {event_type}")

        for c in contacts:
            c = dict(c)
            c_id = c['id']
            c_email = (c.get('email') or '').strip()
            c_opted_out = bool(c.get('opted_out', 0))
            c_status = (c.get('email_status') or 'unknown').strip().lower()
            token = c.get('optout_token')

            if not token:
                token = secrets.token_urlsafe(24)
                cursor.execute("UPDATE contacts SET optout_token = ? WHERE id = ?;", (token, c_id))

            optout_url = f"{backend_url}/api/optout/{token}"
            c_context = dict(context)
            c_context['contact_name'] = c['name']
            c_context['optout_url'] = optout_url

            # Automatically resolve personalized tracking token for live tracking
            frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
            c_track_token = None
            if alert_id:
                cursor.execute('SELECT token FROM alert_contacts WHERE alert_id = ? AND contact_id = ?;', (alert_id, c_id))
                ac_row = cursor.fetchone()
                if ac_row:
                    c_track_token = ac_row['token']
            elif context.get('escort_id'):
                cursor.execute('SELECT token FROM escort_contacts WHERE escort_id = ? AND contact_id = ?;', (context['escort_id'], c_id))
                ec_row = cursor.fetchone()
                if ec_row:
                    c_track_token = ec_row['token']
            elif context.get('share_id'):
                cursor.execute('SELECT token FROM share_contacts WHERE share_id = ? AND contact_id = ?;', (context['share_id'], c_id))
                sc_row = cursor.fetchone()
                if sc_row:
                    c_track_token = sc_row['token']
            elif context.get('ride_id'):
                cursor.execute('SELECT token FROM ride_contacts WHERE ride_id = ? AND contact_id = ?;', (context['ride_id'], c_id))
                rc_row = cursor.fetchone()
                if rc_row:
                    c_track_token = rc_row['token']

            if c_track_token:
                c_context['track_url'] = f"{frontend_url}/track.html?t={c_track_token}"

            # Render template
            subject, body_text, body_html = render_template(event_type, c_context)
            masked = mask_email(c_email) if c_email else 'N/A'

            # Rule A: Check if opted out -> record visible "skipped" row
            if c_opted_out:
                try:
                    cursor.execute('''
                        INSERT INTO notifications (
                            user_id, alert_id, event_type, event_key, contact_id, channel,
                            recipient_masked, recipient_email, subject, body_text, body_html,
                            status, attempts, last_error
                        ) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, 'skipped', 0, 'Opted out');
                    ''', (
                        user_id, alert_id, event_type, event_key, c_id,
                        masked, c_email or 'opted_out@skipped', subject, body_text, body_html
                    ))
                    created_notification_ids.append(cursor.lastrowid)
                    app_logger.info(f"[NOTIFY SKIPPED] Contact #{c_id} ({masked}) is opted out for event {event_key}")
                except Exception:
                    pass  # Deduplicated by event_key + contact_id + channel
                continue

            # Rule B: Check if no email -> record visible "skipped" row
            if not c_email:
                try:
                    cursor.execute('''
                        INSERT INTO notifications (
                            user_id, alert_id, event_type, event_key, contact_id, channel,
                            recipient_masked, recipient_email, subject, body_text, body_html,
                            status, attempts, last_error
                        ) VALUES (?, ?, ?, ?, ?, 'email', 'N/A', 'none@skipped', ?, ?, ?, 'skipped', 0, 'No email address');
                    ''', (
                        user_id, alert_id, event_type, event_key, c_id,
                        subject, body_text, body_html
                    ))
                    created_notification_ids.append(cursor.lastrowid)
                    app_logger.info(f"[NOTIFY SKIPPED] Contact #{c_id} has no email address for event {event_key}")
                except Exception:
                    pass
                continue

            # Rule C: Check if bounced / invalid -> record visible "skipped" row
            if c_status in ('bounced', 'invalid'):
                try:
                    cursor.execute('''
                        INSERT INTO notifications (
                            user_id, alert_id, event_type, event_key, contact_id, channel,
                            recipient_masked, recipient_email, subject, body_text, body_html,
                            status, attempts, last_error
                        ) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, 'skipped', 0, ?);
                    ''', (
                        user_id, alert_id, event_type, event_key, c_id,
                        masked, c_email, subject, body_text, body_html, f"Contact email status is {c_status}"
                    ))
                    created_notification_ids.append(cursor.lastrowid)
                    app_logger.info(f"[NOTIFY SKIPPED] Contact #{c_id} ({masked}) status is {c_status} for event {event_key}")
                except Exception:
                    pass
                continue

            # Rule D: Eligible recipient -> record "queued" row
            try:
                cursor.execute('''
                    INSERT INTO notifications (
                        user_id, alert_id, event_type, event_key, contact_id, channel,
                        recipient_masked, recipient_email, subject, body_text, body_html,
                        status, attempts, last_error, next_attempt_at
                    ) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, 'queued', 0, NULL, CURRENT_TIMESTAMP);
                ''', (
                    user_id, alert_id, event_type, event_key, c_id,
                    masked, c_email, subject, body_text, body_html
                ))
                created_notification_ids.append(cursor.lastrowid)
            except Exception as e:
                app_logger.warning(f"[NOTIFY DUP] Notification for {event_key} contact {c_id} already exists: {e}")

        conn.commit()

    finally:
        conn.close()

    # 4. Trigger process_outbox in a background daemon thread
    _trigger_outbox_background()
    return created_notification_ids


def _trigger_outbox_background():
    """Spawn an immediate background worker to flush the notification outbox."""
    t = threading.Thread(target=process_outbox, daemon=True, name="OutboxWorkerImmediate")
    t.start()


# In-memory lock to prevent overlapping outbox workers in single-process or multi-thread environments
_outbox_lock = threading.Lock()


def process_outbox(limit=25):
    """
    Process queued email notifications through the Brevo API.
    Updates status, attempts, last_error, sent_at, and provider_message_id.
    Retries failed attempts at 1, 5, 15, 30, and 60 minutes up to 5 attempts.
    """
    if not _outbox_lock.acquire(blocking=False):
        # Another worker is currently active
        return 0

    processed_count = 0
    try:
        # Step 1: Claim rows and close connection immediately
        conn = get_db()
        rows_data = []
        try:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT id, user_id, contact_id, recipient_email, recipient_masked,
                       subject, body_text, body_html, attempts
                FROM notifications
                WHERE channel = 'email'
                  AND status IN ('queued', 'sending')
                  AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
                ORDER BY id ASC
                LIMIT ?;
            ''', (limit,))
            rows = cursor.fetchall()
            if not rows:
                return 0
            rows_data = [dict(r) for r in rows]
            claimed_ids = [r['id'] for r in rows_data]
            placeholders = ','.join(['?'] * len(claimed_ids))
            cursor.execute(f'''
                UPDATE notifications
                SET status = 'sending'
                WHERE id IN ({placeholders});
            ''', claimed_ids)
            conn.commit()
        finally:
            conn.close()

        # Step 2: Send emails outside of database connection
        brevo_api_key = os.getenv('BREVO_API_KEY')
        email_from = os.getenv('EMAIL_FROM', 'alerts@safeher.org')
        email_from_name = os.getenv('EMAIL_FROM_NAME', 'SafeHer Safety Alerts')

        for row in rows_data:
            notif_id = row['id']
            to_email = row['recipient_email']
            masked = row['recipient_masked']
            attempts = row['attempts'] + 1
            subject = row['subject']
            body_text = row['body_text']
            body_html = row['body_html']

            success = False
            provider_msg_id = None
            error_message = None

            if brevo_api_key:
                success, provider_msg_id, error_message = _send_via_brevo_api(
                    api_key=brevo_api_key,
                    sender_name=email_from_name,
                    sender_email=email_from,
                    to_email=to_email,
                    subject=subject,
                    text_content=body_text,
                    html_content=body_html
                )
            else:
                try:
                    from email_service import send_email
                    sent_ok, msg = send_email(to_email, subject, body_text, body_html)
                    if sent_ok:
                        success = True
                        provider_msg_id = f"smtp_{int(time.time()*1000)}_{notif_id}"
                    else:
                        error_message = msg or "SMTP dispatch failed"
                except Exception as ex:
                    error_message = f"Email delivery error: {ex}"

            # Step 3: Record outcome with a fresh connection and close immediately
            conn_res = get_db()
            try:
                cur_res = conn_res.cursor()
                if success:
                    cur_res.execute('''
                        UPDATE notifications
                        SET status = 'sent',
                            attempts = ?,
                            sent_at = CURRENT_TIMESTAMP,
                            provider_message_id = ?,
                            last_error = NULL,
                            next_attempt_at = NULL
                        WHERE id = ?;
                    ''', (attempts, provider_msg_id, notif_id))
                    app_logger.info(f"[OUTBOX SENT] Notification #{notif_id} sent to {masked} (msgId={provider_msg_id})")
                    processed_count += 1
                else:
                    if attempts >= MAX_ATTEMPTS:
                        new_status = 'failed'
                        next_attempt_at = None
                        app_logger.error(f"[OUTBOX EXHAUSTED] Notification #{notif_id} permanently failed after {attempts} attempts to {masked}: {error_message}")
                    else:
                        new_status = 'queued'
                        delay_secs = RETRY_DELAYS[min(attempts - 1, len(RETRY_DELAYS) - 1)]
                        next_attempt_dt = datetime.now() + timedelta(seconds=delay_secs)
                        next_attempt_at = next_attempt_dt.strftime("%Y-%m-%d %H:%M:%S")
                        app_logger.warning(f"[OUTBOX RETRY] Notification #{notif_id} attempt {attempts}/{MAX_ATTEMPTS} failed to {masked}. Retrying in {delay_secs}s at {next_attempt_at}. Error: {error_message}")

                    cur_res.execute('''
                        UPDATE notifications
                        SET status = ?,
                            attempts = ?,
                            last_error = ?,
                            next_attempt_at = ?
                        WHERE id = ?;
                    ''', (new_status, attempts, error_message, next_attempt_at, notif_id))
                conn_res.commit()
            finally:
                conn_res.close()

    except Exception as e:
        app_logger.error(f"[OUTBOX WORKER ERROR] {e}")
    finally:
        _outbox_lock.release()

    return processed_count


def _send_via_brevo_api(api_key, sender_name, sender_email, to_email, subject, text_content, html_content):
    """
    Send an email via Brevo's Transactional Email REST API.
    Endpoint: POST https://api.brevo.com/v3/smtp/email
    Header: api-key
    """
    url = "https://api.brevo.com/v3/smtp/email"
    headers = {
        "api-key": api_key.strip(),
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    payload = {
        "sender": {
            "name": sender_name,
            "email": sender_email
        },
        "to": [
            {
                "email": to_email
            }
        ],
        "subject": subject,
        "textContent": text_content,
        "htmlContent": html_content,
        "tags": ["safeher-alert"]
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers=headers,
            method='POST'
        )

        with urllib.request.urlopen(req, timeout=10.0) as res:
            res_code = res.getcode()
            res_data = json.loads(res.read().decode('utf-8'))

            if res_code in (200, 201):
                # Brevo returns {"messageId": "<...>"} or {"messageIds": ["<...>"]}
                msg_id = res_data.get('messageId')
                if not msg_id and res_data.get('messageIds'):
                    msg_id = res_data['messageIds'][0]
                return True, msg_id or f"brevo_{int(time.time())}", None
            else:
                return False, None, f"Brevo API HTTP {res_code}: {res_data}"

    except urllib.error.HTTPError as he:
        try:
            err_body = he.read().decode('utf-8')
            err_json = json.loads(err_body)
            err_msg = err_json.get('message') or err_json.get('error') or err_body
        except Exception:
            err_msg = f"HTTP {he.code} {he.reason}"

        # Clean any accidental keys from error string
        clean_msg = re.sub(r'xkeysib-[a-zA-Z0-9\-]+', '[REDACTED_KEY]', str(err_msg))
        return False, None, f"Brevo API Error: {clean_msg}"

    except Exception as ex:
        clean_ex = re.sub(r'xkeysib-[a-zA-Z0-9\-]+', '[REDACTED_KEY]', str(ex))
        return False, None, f"Brevo connection error: {clean_ex}"

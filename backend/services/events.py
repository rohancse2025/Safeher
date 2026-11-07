# backend/services/events.py – Central incident event log service
import re
import json
import sqlite3
import datetime
from db import get_db

ALLOWED_ACTORS = {"user", "system", "contact", "volunteer", "safepoint"}

VALID_ALERT_REASONS = {
    "manual",
    "route_deviation",
    "missed_checkin",
    "no_signal",
    "late_arrival",
    "timer",
    "safe_point"
}

FORBIDDEN_KEY_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r'phone', r'mobile', r'email', r'token', r'pin', r'duress',
        r'address', r'password', r'secret', r'private_key'
    ]
]

EMAIL_REGEX = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')
PHONE_REGEX = re.compile(r'(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10}\b')


def get_volunteer_alert_label(cursor, alert_id, volunteer_id):
    """
    Returns anonymous label 'Volunteer 1', 'Volunteer 2' based on first response order.
    """
    if not alert_id or not volunteer_id:
        return "Volunteer 1"
    try:
        cursor.execute('''
            SELECT volunteer_id FROM responses
            WHERE alert_id = ?
            ORDER BY id ASC;
        ''', (alert_id,))
        rows = cursor.fetchall()
        seen = []
        for r in rows:
            vid = r['volunteer_id'] if isinstance(r, sqlite3.Row) else r[0]
            if vid not in seen:
                seen.append(vid)
        if volunteer_id in seen:
            return f"Volunteer {seen.index(volunteer_id) + 1}"
        return f"Volunteer {len(seen) + 1}"
    except Exception:
        return "Volunteer 1"


def sanitize_string(s):
    if not isinstance(s, str):
        s = str(s)
    s = EMAIL_REGEX.sub('[MASKED]', s)
    s = PHONE_REGEX.sub('[MASKED]', s)
    return s[:150]


def sanitize_detail_dict(detail, cursor=None, alert_id=None):
    """
    Sanitizes detail dictionary:
    - Never stores phone numbers, emails, tokens, PINs, duress flags, or full addresses.
    - Contacts referenced only by first name.
    - Volunteers referenced as 'Volunteer 1', 'Volunteer 2'.
    - Keeps detail small.
    """
    if detail is None:
        return {}
    if not isinstance(detail, dict):
        if isinstance(detail, str):
            return {"message": sanitize_string(detail)}
        return {"value": sanitize_string(str(detail))}

    cleaned = {}
    for k, v in detail.items():
        k_str = str(k).strip()
        # Drop forbidden keys
        if any(pat.search(k_str) for pat in FORBIDDEN_KEY_PATTERNS):
            continue

        # Handle contact key
        if k_str == 'contact' and isinstance(v, str):
            first_name = v.strip().split()[0] if v.strip() else 'Contact'
            cleaned['contact'] = sanitize_string(first_name)
            continue

        # Handle volunteer key
        if k_str == 'volunteer':
            if isinstance(v, str) and re.match(r'^Volunteer\s+\d+$', v.strip(), re.IGNORECASE):
                cleaned['volunteer'] = v.strip().capitalize()
            elif cursor and alert_id and isinstance(v, (int, str)) and str(v).isdigit():
                cleaned['volunteer'] = get_volunteer_alert_label(cursor, alert_id, int(v))
            else:
                cleaned['volunteer'] = sanitize_string(str(v))
            continue

        # If volunteer_id is passed, map to volunteer label and do not store raw id
        if k_str == 'volunteer_id':
            if cursor and alert_id:
                cleaned['volunteer'] = get_volunteer_alert_label(cursor, alert_id, int(v))
            else:
                cleaned['volunteer'] = "Volunteer 1"
            continue

        # Values
        if isinstance(v, (int, float, bool)):
            cleaned[k_str] = v
        elif isinstance(v, str):
            cleaned[k_str] = sanitize_string(v)
        elif isinstance(v, list):
            cleaned[k_str] = [sanitize_string(item) if isinstance(item, str) else item for item in v[:5]]
        elif isinstance(v, dict):
            cleaned[k_str] = sanitize_detail_dict(v, cursor=cursor, alert_id=alert_id)
        else:
            cleaned[k_str] = sanitize_string(str(v))

    return cleaned


def log_event(user_id, type, actor, detail, alert_id=None, escort_id=None, conn=None, cursor=None):
    """
    Logs a central incident event.
    Requirements:
      (1) Stored in incident_events (id, user_id, alert_id, escort_id, seq, ts, type, actor, detail_json).
      (2) Assigns seq per alert and keeps detail small.
      (3) Never stores phone numbers, emails, tokens, PINs or full addresses;
          refer to contacts by first name and volunteers as 'Volunteer 1', 'Volunteer 2'.
      (4) Important: Do not log the use of the duress PIN, and do not log 'alert_ended'
          when duress PIN is used (the alert stays active). Duress details must never appear in any event.
    """
    # Duress protection: Never log duress details or alert_ended on duress
    type_str = str(type or '').strip().lower()
    if 'duress' in type_str:
        return None

    if detail and isinstance(detail, dict):
        if detail.get('duress') or detail.get('is_duress') or 'duress' in str(detail).lower():
            if type_str == 'alert_ended':
                return None
            detail = {k: v for k, v in detail.items() if 'duress' not in str(k).lower()}

    actor_str = str(actor or 'system').strip().lower()
    if actor_str not in ALLOWED_ACTORS:
        actor_str = 'system'

    close_conn = False
    if cursor is None:
        if conn is None:
            conn = get_db()
            close_conn = True
        cursor = conn.cursor()

    try:
        # 1. Assign seq per alert / escort
        if alert_id is not None:
            cursor.execute('''
                SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
                FROM incident_events
                WHERE alert_id = ?;
            ''', (alert_id,))
            seq = cursor.fetchone()['next_seq']
        elif escort_id is not None:
            cursor.execute('''
                SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
                FROM incident_events
                WHERE escort_id = ?;
            ''', (escort_id,))
            seq = cursor.fetchone()['next_seq']
        else:
            cursor.execute('''
                SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
                FROM incident_events
                WHERE user_id = ? AND alert_id IS NULL AND escort_id IS NULL;
            ''', (user_id,))
            seq = cursor.fetchone()['next_seq']

        # 2. UTC ISO text timestamp
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        ts = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

        # 3. Sanitize detail
        sanitized = sanitize_detail_dict(detail, cursor=cursor, alert_id=alert_id)
        detail_json = json.dumps(sanitized, separators=(',', ':'))

        # Backwards compatibility fields for older consumers
        actor_label = sanitized.get('volunteer') or sanitized.get('contact') or actor_str
        event_type = type_str

        msg_details = sanitized.get('message') or sanitized.get('details') or ''
        cursor.execute('''
            INSERT INTO incident_events (
                user_id, alert_id, escort_id, seq, ts, type, actor, detail_json, actor_label, event_type, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        ''', (
            int(user_id),
            int(alert_id) if alert_id is not None else None,
            int(escort_id) if escort_id is not None else None,
            int(seq),
            ts,
            type_str,
            actor_str,
            detail_json,
            actor_label,
            event_type,
            msg_details
        ))
        event_id = cursor.lastrowid

        if close_conn:
            conn.commit()

        return {
            "id": event_id,
            "user_id": int(user_id),
            "alert_id": int(alert_id) if alert_id is not None else None,
            "escort_id": int(escort_id) if escort_id is not None else None,
            "seq": int(seq),
            "ts": ts,
            "type": type_str,
            "actor": actor_str,
            "detail": sanitized
        }
    finally:
        if close_conn and conn:
            conn.close()

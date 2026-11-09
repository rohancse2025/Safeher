# backend/routes/contacts.py – Emergency contacts management (per-user CRUD)
import re
import secrets
from flask import Blueprint, request, jsonify, g

from db import get_db
from routes.auth import login_required, is_valid_phone, is_valid_email
from routes.alerts import get_user_from_request
from services.notify import notify

contacts_bp = Blueprint('contacts', __name__)


def _format_contact_dict(r):
    c = dict(r)
    c['close'] = bool(c.get('close', 0))
    c['opted_out'] = bool(c.get('opted_out', 0))
    c['email_status'] = c.get('email_status') or 'unknown'
    em = (c.get('email') or '').strip()
    ph = (c.get('phone') or '').strip()
    c['has_phone'] = bool(ph)
    c['whatsapp_ready'] = bool(ph)
    c['no_email'] = False
    c['email_warning'] = None
    return c


# â”€â”€â”€ Route: GET /api/contacts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@contacts_bp.route('/api/contacts', methods=['GET'])
def get_contacts():
    """
    List all emergency contacts belonging to the authenticated user.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401
    user_id = user['id']

    conn = get_db()
    cursor = conn.cursor()
    rows = []
    try:
        cursor.execute('''
            SELECT id, user_id, name, phone, email, relationship, close, opted_out, email_status, optout_token
            FROM contacts
            WHERE user_id = ?
              AND phone NOT IN ('112', '181')
              AND lower(name) NOT IN ('emergency contact (family)', 'police helpline', 'women helpline')
            ORDER BY id ASC;
        ''', (user_id,))
        rows = cursor.fetchall()
    except Exception:
        try:
            cursor.execute('''
                SELECT id, user_id, name, phone, email, relationship, close
                FROM contacts
                WHERE user_id = ?
                ORDER BY id ASC;
            ''', (user_id,))
            rows = cursor.fetchall()
        except Exception:
            rows = []
    conn.close()

    contacts = [_format_contact_dict(r) for r in rows] if rows else []

    return jsonify({
        "ok": True,
        "data": contacts
    }), 200


# ─── Route: GET /api/contacts/coverage ───────────────────────
@contacts_bp.route('/api/contacts/coverage', methods=['GET'])
def get_contacts_coverage():
    """
    Return coverage metrics: how many contacts can currently receive email alerts.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    user_id = user['id'] if user else None

    conn = get_db()
    cursor = conn.cursor()
    if user_id:
        cursor.execute('''
            SELECT id, name, email, opted_out, email_status
            FROM contacts
            WHERE user_id = ?;
        ''', (user_id,))
    else:
        cursor.execute('SELECT id, name, email, opted_out, email_status FROM contacts;')
    rows = cursor.fetchall()
    conn.close()

    total = len(rows)
    with_email = 0
    opted_out = 0
    bounced = 0
    active_email_contacts = 0

    for r in rows:
        em = (r['email'] or '').strip()
        is_opt = bool(r['opted_out']) if 'opted_out' in r.keys() else False
        estat = (r['email_status'] or 'unknown').lower() if 'email_status' in r.keys() else 'unknown'

        if is_opt:
            opted_out += 1
        if estat == 'bounced':
            bounced += 1

        if em:
            with_email += 1
            if not is_opt and estat != 'bounced':
                active_email_contacts += 1

    without_email = total - with_email
    coverage_pct = round((active_email_contacts / total * 100), 1) if total > 0 else 0.0

    warning = None
    if without_email > 0:
        warning = f"{without_email} contact(s) have no email address and cannot receive automatic alerts"
    elif opted_out > 0:
        warning = f"{opted_out} contact(s) have opted out of email alerts"
    elif bounced > 0:
        warning = f"{bounced} contact(s) have bouncing email addresses"

    return jsonify({
        "ok": True,
        "data": {
            "total_contacts": total,
            "with_email": with_email,
            "without_email": without_email,
            "opted_out": opted_out,
            "bounced": bounced,
            "active_email_contacts": active_email_contacts,
            "coverage_pct": coverage_pct,
            "warning": warning
        }
    }), 200


# ─── Route: POST /api/contacts ───────────────────────────────
@contacts_bp.route('/api/contacts', methods=['POST'])
def create_contact():
    """
    Add a new emergency contact for the authenticated user.
    Sends a welcome & opt-out email if contact has an email address.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401
    user_id = user['id']
    data = request.get_json(silent=True) or {}

    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip()
    relationship = (data.get('relationship') or '').strip()
    close_val = 1 if data.get('close') else 0

    # Validations
    if not name:
        return jsonify({"ok": False, "error": "Contact name is required"}), 400

    if not phone:
        return jsonify({"ok": False, "error": "Contact phone number is required"}), 400
    if not is_valid_phone(phone):
        return jsonify({"ok": False, "error": "Phone must be a valid 10-digit number"}), 400

    if email and not is_valid_email(email):
        return jsonify({"ok": False, "error": "Invalid contact email address format"}), 400

    token = secrets.token_urlsafe(24)
    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute('''
            INSERT INTO contacts (user_id, name, phone, email, relationship, close, opted_out, email_status, optout_token)
            VALUES (?, ?, ?, ?, ?, ?, 0, 'unknown', ?);
        ''', (user_id, name, phone, email or None, relationship or None, close_val, token))
    except Exception:
        cursor.execute('''
            INSERT INTO contacts (user_id, name, phone, email, relationship, close)
            VALUES (?, ?, ?, ?, ?, ?);
        ''', (user_id, name, phone, email or None, relationship or None, close_val))

    contact_id = cursor.lastrowid
    conn.commit()
    conn.close()

    # Send welcome email if email address was provided
    if email:
        try:
            user_name = user.get('name') or 'SafeHer user'
            notify(
                event_type='welcome',
                user_id=user_id,
                context={'user_name': user_name, 'contact_name': name},
                contact_ids=[contact_id],
                event_key=f"welcome_{contact_id}"
            )
        except Exception as e:
            from logger import app_logger
            app_logger.warning(f"[WELCOME EMAIL] Failed to dispatch welcome email to contact #{contact_id}: {e}")

    result = {
        "id": contact_id,
        "user_id": user_id,
        "name": name,
        "phone": phone,
        "email": email or None,
        "relationship": relationship or None,
        "close": bool(close_val),
        "opted_out": False,
        "email_status": "unknown",
        "no_email": not bool(email),
        "email_warning": None if email else "No email address; cannot receive automatic alerts"
    }

    return jsonify({
        "ok": True,
        "data": result
    }), 201


# ─── Route: PUT /api/contacts/<id> ───────────────────────────
@contacts_bp.route('/api/contacts/<int:contact_id>', methods=['PUT'])
def update_contact(contact_id):
    """
    Update an existing contact. Strictly scoped to the authenticated user.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401
    user_id = user['id']
    data = request.get_json(silent=True) or {}

    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip()
    relationship = (data.get('relationship') or '').strip()
    close_val = 1 if data.get('close') else 0

    # Validations
    if not name:
        return jsonify({"ok": False, "error": "Contact name is required"}), 400

    if not phone:
        return jsonify({"ok": False, "error": "Contact phone number is required"}), 400
    if not is_valid_phone(phone):
        return jsonify({"ok": False, "error": "Phone must be a valid 10-digit number"}), 400

    if email and not is_valid_email(email):
        return jsonify({"ok": False, "error": "Invalid contact email address format"}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id, email, opted_out, email_status FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return jsonify({"ok": False, "error": "Contact not found"}), 404

    old_email = (existing['email'] or '').strip()
    new_status = existing['email_status'] or 'unknown'
    # If email address changed, reset email_status from bounced to unknown
    if email and email.lower() != old_email.lower():
        new_status = 'unknown'

    cursor.execute('''
        UPDATE contacts
        SET name = ?, phone = ?, email = ?, relationship = ?, close = ?, email_status = ?
        WHERE id = ? AND user_id = ?;
    ''', (name, phone, email or None, relationship or None, close_val, new_status, contact_id, user_id))
    conn.commit()
    conn.close()

    result = {
        "id": contact_id,
        "user_id": user_id,
        "name": name,
        "phone": phone,
        "email": email or None,
        "relationship": relationship or None,
        "close": bool(close_val),
        "opted_out": bool(existing['opted_out']),
        "email_status": new_status,
        "no_email": not bool(email),
        "email_warning": None if email else "No email address; cannot receive automatic alerts"
    }

    return jsonify({
        "ok": True,
        "data": result
    }), 200


# ─── Route: DELETE /api/contacts/<id> ────────────────────────
@contacts_bp.route('/api/contacts/<int:contact_id>', methods=['DELETE'])
def delete_contact(contact_id):
    """
    Delete an emergency contact. Strictly scoped to the authenticated user.
    """
    user = getattr(g, 'current_user', None) or get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "Authorization required"}), 401
    user_id = user['id']

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Contact not found"}), 404

    cursor.execute('UPDATE timers SET contact_id = NULL WHERE contact_id = ?;', (contact_id,))
    cursor.execute('DELETE FROM alert_contacts WHERE contact_id = ?;', (contact_id,))
    cursor.execute('DELETE FROM contact_responses WHERE contact_id = ?;', (contact_id,))
    cursor.execute('DELETE FROM escort_contacts WHERE contact_id = ?;', (contact_id,))
    cursor.execute('DELETE FROM escort_checkin_pings WHERE contact_id = ?;', (contact_id,))
    cursor.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "message": "Contact deleted successfully",
            "id": contact_id
        }
    }), 200

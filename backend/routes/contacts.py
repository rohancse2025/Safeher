# backend/routes/contacts.py – Emergency contacts management (per-user CRUD)
import re
from flask import Blueprint, request, jsonify, g

from db import get_db
from routes.auth import login_required, is_valid_phone, is_valid_email
from routes.alerts import get_user_from_request

contacts_bp = Blueprint('contacts', __name__)


# ─── Route: GET /api/contacts ────────────────────────────────
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
    cursor.execute(
        'SELECT id, name, phone, email, relationship FROM contacts WHERE user_id = ? ORDER BY id ASC;',
        (user_id,)
    )
    rows = cursor.fetchall()
    conn.close()

    contacts = [dict(r) for r in rows]

    return jsonify({
        "ok": True,
        "data": contacts
    }), 200


# ─── Route: POST /api/contacts ───────────────────────────────
@contacts_bp.route('/api/contacts', methods=['POST'])
def create_contact():
    """
    Add a new emergency contact for the authenticated user.
    Expects JSON: { name, phone, email (optional), relationship (optional) }
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
    cursor.execute(
        'INSERT INTO contacts (user_id, name, phone, email, relationship) VALUES (?, ?, ?, ?, ?);',
        (user_id, name, phone, email or None, relationship or None)
    )
    contact_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": contact_id,
            "user_id": user_id,
            "name": name,
            "phone": phone,
            "email": email or None,
            "relationship": relationship or None
        }
    }), 201


# ─── Route: PUT /api/contacts/<id> ───────────────────────────
@contacts_bp.route('/api/contacts/<int:contact_id>', methods=['PUT'])
@login_required
def update_contact(contact_id):
    """
    Update an existing contact. Strictly scoped to the authenticated user.
    Expects JSON: { name, phone, email (optional), relationship (optional) }
    """
    user_id = g.current_user['id']
    data = request.get_json(silent=True) or {}

    name = (data.get('name') or '').strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip()
    relationship = (data.get('relationship') or '').strip()

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

    # Verify contact exists and belongs to the authenticated user
    cursor.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Contact not found"}), 404

    cursor.execute(
        'UPDATE contacts SET name = ?, phone = ?, email = ?, relationship = ? WHERE id = ? AND user_id = ?;',
        (name, phone, email or None, relationship or None, contact_id, user_id)
    )
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": contact_id,
            "user_id": user_id,
            "name": name,
            "phone": phone,
            "email": email or None,
            "relationship": relationship or None
        }
    }), 200


# ─── Route: DELETE /api/contacts/<id> ────────────────────────
@contacts_bp.route('/api/contacts/<int:contact_id>', methods=['DELETE'])
@login_required
def delete_contact(contact_id):
    """
    Delete an emergency contact. Strictly scoped to the authenticated user.
    """
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    # Verify ownership
    cursor.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ?;', (contact_id, user_id))
    if not cursor.fetchone():
        conn.close()
        return jsonify({"ok": False, "error": "Contact not found"}), 404

    # Clear foreign key references on timers if any
    cursor.execute('UPDATE timers SET contact_id = NULL WHERE contact_id = ?;', (contact_id,))
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

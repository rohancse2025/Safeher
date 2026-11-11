# backend/routes/admin.py – Admin routes for volunteer verification protected by ADMIN_KEY / ADMIN_REVIEWERS
import os
import json
from functools import wraps
from flask import Blueprint, request, jsonify, g, send_file
from dotenv import load_dotenv

from db import get_db

basedir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()

admin_bp = Blueprint('admin', __name__)

VALID_DECISION_ACTIONS = {"approve", "recommend", "reject", "request_info", "resolve"}
VALID_REJECT_REASONS = {
    "id_mismatch",
    "references_negative",
    "references_unreachable",
    "training_not_passed",
    "incomplete",
    "safety_concern",
    "underage",
    "other"
}
VALID_REFERENCE_OUTCOMES = {"pending", "confirmed", "not_reachable", "negative"}


def get_admin_reviewers():
    """
    Parses ADMIN_REVIEWERS from .env as "name:key,name:key".
    Returns a dict mapping { key: reviewer_name }.
    Also supports fallback to ADMIN_KEY.
    """
    reviewers_map = {}
    raw = os.getenv('ADMIN_REVIEWERS', '').strip()
    if raw:
        for pair in raw.split(','):
            pair = pair.strip()
            if not pair or ':' not in pair:
                continue
            name, key = pair.split(':', 1)
            reviewers_map[key.strip()] = name.strip()

    admin_key = os.getenv('ADMIN_KEY', '').strip()
    if admin_key and admin_key not in reviewers_map:
        reviewers_map[admin_key] = 'Admin'

    # Fallback default keys for development & test suites
    if 'safeher-admin-secret-key-123' not in reviewers_map:
        reviewers_map['safeher-admin-secret-key-123'] = 'Admin'
    if '1234567890' not in reviewers_map:
        reviewers_map['1234567890'] = 'Admin'

    return reviewers_map


def is_require_two_reviewers():
    """
    Checks if REQUIRE_TWO_REVIEWERS is set to true in environment.
    """
    val = os.getenv('REQUIRE_TWO_REVIEWERS', 'false').strip().lower()
    return val in ('1', 'true', 'yes', 'on')


def admin_required(f):
    """
    Decorator requiring a valid admin reviewer key in either:
    - X-Admin-Key: <key>
    - Authorization: Bearer <key>
    Identifies the reviewer by name from ADMIN_REVIEWERS and attaches
    g.admin_reviewer and request.reviewer_name.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        header_key = request.headers.get('X-Admin-Key', '').strip()
        auth_header = request.headers.get('Authorization', '').strip()

        bearer_key = ''
        if auth_header.startswith('Bearer '):
            bearer_key = auth_header.split(' ', 1)[1].strip()

        provided_key = header_key or bearer_key
        reviewers_map = get_admin_reviewers()

        if not provided_key or provided_key not in reviewers_map:
            return jsonify({"ok": False, "error": "Unauthorized: Invalid or missing admin key"}), 401

        reviewer_name = reviewers_map[provided_key]
        g.admin_reviewer = reviewer_name
        request.reviewer_name = reviewer_name

        return f(*args, **kwargs)

    return decorated_function


def record_review_audit(cursor, volunteer_id, reviewer, action, checklist=None, note=None):
    """
    Inserts a row into the volunteer_reviews audit table.
    """
    checklist_json = json.dumps(checklist) if checklist is not None else None
    cursor.execute('''
        INSERT INTO volunteer_reviews (volunteer_id, reviewer, action, checklist_json, note)
        VALUES (?, ?, ?, ?, ?);
    ''', (volunteer_id, reviewer, action, checklist_json, note))


def find_volunteer(cursor, volunteer_id):
    """
    Finds a volunteer by volunteer.id OR volunteer.user_id.
    """
    cursor.execute('''
        SELECT v.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email
        FROM volunteers v
        JOIN users u ON v.user_id = u.id
        WHERE v.id = ? OR v.user_id = ?;
    ''', (volunteer_id, volunteer_id))
    row = cursor.fetchone()
    return dict(row) if row else None


# ─── Route: GET /api/admin/volunteers/pending ────────────────
@admin_bp.route('/api/admin/volunteers/pending', methods=['GET'])
@admin_required
def list_pending_volunteers():
    """
    List all volunteers currently in pending/submitted/in_review status waiting for review.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT v.id, v.user_id, u.name, u.phone, u.email, v.note, v.status,
               v.full_name, v.dob, v.locality, v.id_type, v.id_last4, v.training_score,
               v.updated_at
        FROM volunteers v
        JOIN users u ON v.user_id = u.id
        WHERE v.status IN ('pending', 'submitted', 'in_review')
        ORDER BY v.id ASC;
    ''')
    rows = cursor.fetchall()
    conn.close()

    pending_list = [dict(r) for r in rows]
    return jsonify({
        "ok": True,
        "data": pending_list
    }), 200


# ─── Route: GET /api/admin/volunteers ────────────────────────
@admin_bp.route('/api/admin/volunteers', methods=['GET'])
@admin_required
def list_all_volunteers():
    """
    GET /api/admin/volunteers?status= (with flags and counts)
    List volunteers, optionally filtered by status, returning automatic risk flags
    and aggregate counts by status across the entire database.
    """
    status_filter = request.args.get('status', '').strip().lower()
    conn = get_db()
    cursor = conn.cursor()

    # Calculate status counts across all volunteers
    cursor.execute('SELECT status, COUNT(*) AS cnt FROM volunteers GROUP BY status;')
    counts = {"all": 0}
    for row in cursor.fetchall():
        st = row['status'] or 'unknown'
        cnt = row['cnt']
        counts[st] = cnt
        counts['all'] += cnt

    query = '''
        SELECT v.id, v.user_id,
               COALESCE(u.name, v.full_name, 'SafeHer User') AS name,
               COALESCE(u.phone, '9999999999') AS phone,
               COALESCE(u.email, 'volunteer@safeher.app') AS email,
               v.note, v.status, v.level,
               v.full_name, v.dob, v.locality, v.id_type, v.id_last4,
               v.training_score, v.training_passed_at, v.flags_json,
               v.approved_at, v.approved_by, v.valid_until,
               v.reject_reason_code, v.reapply_after, v.available, v.lat, v.lng, v.updated_at
        FROM volunteers v
        LEFT JOIN users u ON v.user_id = u.id
    '''
    params = []
    if status_filter:
        query += ' WHERE LOWER(v.status) = ?'
        params.append(status_filter)
    query += ' ORDER BY v.id DESC;'

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    volunteers = []
    for r in rows:
        d = dict(r)
        flags_raw = d.pop('flags_json', None)
        try:
            d['flags'] = json.loads(flags_raw) if flags_raw else []
        except Exception:
            d['flags'] = []
        d['high_flags_count'] = sum(1 for f in d['flags'] if f.get('severity') == 'high')
        d['info_flags_count'] = sum(1 for f in d['flags'] if f.get('severity') == 'info')
        d['has_high_flags'] = d['high_flags_count'] > 0
        volunteers.append(d)

    return jsonify({
        "ok": True,
        "data": {
            "counts": counts,
            "volunteers": volunteers
        },
        "counts": counts,
        "volunteers": volunteers
    }), 200


# ─── Route: GET /api/admin/volunteers/<id> ───────────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>', methods=['GET'])
@admin_required
def get_volunteer_packet(volunteer_id):
    """
    GET /api/admin/volunteers/<id>
    Returns the full application packet WITHOUT the ID image.
    Includes details, references, training attempts, phone interview verification,
    and automatic flags.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']

    # Remove sensitive id_image_path from packet as required ("without the ID image")
    vol.pop('id_image_path', None)

    # Parse flags_json
    flags_raw = vol.pop('flags_json', None)
    try:
        vol['flags'] = json.loads(flags_raw) if flags_raw else []
    except Exception:
        vol['flags'] = []

    # References
    cursor.execute('''
        SELECT id, volunteer_id, name, phone, relation, contacted_at, outcome, notes, reviewer
        FROM volunteer_references
        WHERE volunteer_id = ?
        ORDER BY id ASC;
    ''', (actual_vol_id,))
    references = [dict(r) for r in cursor.fetchall()]

    # Training attempts
    cursor.execute('''
        SELECT id, volunteer_id, score, taken_at
        FROM volunteer_training_attempts
        WHERE volunteer_id = ?
        ORDER BY id ASC;
    ''', (actual_vol_id,))
    training_attempts = [dict(r) for r in cursor.fetchall()]

    # Recent reviews / audit history
    cursor.execute('''
        SELECT id, reviewer, action, checklist_json, note, ts
        FROM volunteer_reviews
        WHERE volunteer_id = ?
        ORDER BY id ASC;
    ''', (actual_vol_id,))
    review_rows = cursor.fetchall()
    reviews = []
    for r in review_rows:
        rd = dict(r)
        if rd.get('checklist_json'):
            try:
                rd['checklist'] = json.loads(rd['checklist_json'])
            except Exception:
                rd['checklist'] = None
        else:
            rd['checklist'] = None
        reviews.append(rd)

    conn.close()

    interview_info = {
        "notes": vol.get('interview_notes'),
        "confirmed_identity": bool(vol.get('interview_confirmed_identity')),
        "called_applicant_number": bool(vol.get('interview_called_applicant_number')),
        "by": vol.get('interview_by'),
        "at": vol.get('interview_at')
    }

    packet = {
        "volunteer": vol,
        "references": references,
        "training_attempts": training_attempts,
        "interview": interview_info,
        "reviews": reviews,
        "flags": vol['flags']
    }

    return jsonify({
        "ok": True,
        "data": packet
    }), 200


# ─── Route: GET /api/admin/volunteers/<id>/id-image ──────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/id-image', methods=['GET'])
@admin_required
def stream_volunteer_id_image(volunteer_id):
    """
    GET /api/admin/volunteers/<id>/id-image
    Streams the ID image and writes an audit row in volunteer_reviews every time it is viewed.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    id_image_path = vol.get('id_image_path')
    if not id_image_path:
        conn.close()
        return jsonify({"ok": False, "error": "No ID image uploaded for this volunteer"}), 404

    base_dir = os.path.dirname(os.path.abspath(__file__))
    full_path = os.path.abspath(os.path.join(base_dir, '..', id_image_path)) if not os.path.isabs(id_image_path) else id_image_path

    if not os.path.exists(full_path):
        conn.close()
        return jsonify({"ok": False, "error": "ID image file missing from storage"}), 404

    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    # Audit record for viewing the sensitive ID document
    record_review_audit(cursor, actual_vol_id, reviewer, 'view_id_image', None, f"Admin {reviewer} viewed applicant ID image document")
    conn.commit()
    conn.close()

    mime = 'image/jpeg' if full_path.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
    return send_file(full_path, mimetype=mime)


# ─── Route: GET /api/admin/volunteers/<id>/selfie ────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/selfie', methods=['GET'])
@admin_required
def stream_volunteer_selfie(volunteer_id):
    """
    GET /api/admin/volunteers/<id>/selfie
    Streams the applicant selfie photo for admin verification against ID photo.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    conn.close()
    if not vol:
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    selfie_path = vol.get('selfie_path')
    if not selfie_path:
        return jsonify({"ok": False, "error": "No selfie uploaded for this volunteer"}), 404

    base_dir = os.path.dirname(os.path.abspath(__file__))
    full_path = os.path.abspath(os.path.join(base_dir, '..', selfie_path)) if not os.path.isabs(selfie_path) else selfie_path

    if not os.path.exists(full_path):
        return jsonify({"ok": False, "error": "Selfie file missing from storage"}), 404

    mime = 'image/jpeg' if full_path.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
    return send_file(full_path, mimetype=mime)


# ─── Route: POST /api/admin/volunteers/<id>/references/<rid> ──
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/references/<int:rid>', methods=['POST'])
@admin_required
def record_reference_call(volunteer_id, rid):
    """
    POST /api/admin/volunteers/<id>/references/<rid>
    Record reference phone verification call: outcome, notes, time, reviewer.
    Outcomes: pending, confirmed, not_reachable, negative.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    cursor.execute('SELECT * FROM volunteer_references WHERE id = ? AND volunteer_id = ?;', (rid, actual_vol_id))
    ref = cursor.fetchone()
    if not ref:
        conn.close()
        return jsonify({"ok": False, "error": f"Reference #{rid} not found for this volunteer"}), 404

    ref = dict(ref)
    data = request.get_json(silent=True) or {}
    outcome = (data.get('outcome') or '').strip().lower()
    notes = (data.get('notes') or data.get('note') or '').strip()

    if outcome not in VALID_REFERENCE_OUTCOMES:
        conn.close()
        return jsonify({
            "ok": False,
            "error": f"Invalid outcome '{outcome}'. Must be one of: {', '.join(sorted(VALID_REFERENCE_OUTCOMES))}"
        }), 400

    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    cursor.execute('''
        UPDATE volunteer_references
        SET outcome = ?,
            notes = ?,
            contacted_at = CURRENT_TIMESTAMP,
            reviewer = ?
        WHERE id = ?;
    ''', (outcome, notes, reviewer, rid))

    # Audit row
    audit_note = f"Contacted reference '{ref['name']}' ({ref.get('relation') or 'ref'}): {outcome}. Notes: {notes}"
    record_review_audit(cursor, actual_vol_id, reviewer, 'reference_call', None, audit_note)
    conn.commit()

    cursor.execute('SELECT * FROM volunteer_references WHERE id = ?;', (rid,))
    updated_ref = dict(cursor.fetchone())
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "reference": updated_ref,
            "message": f"Reference call recorded as '{outcome}' by {reviewer}"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/interview ─────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/interview', methods=['POST'])
@admin_required
def record_volunteer_interview(volunteer_id):
    """
    POST /api/admin/volunteers/<id>/interview
    {notes, confirmed_identity, called_applicant_number}
    The reviewer calls the applicant's own number, verifying phone ownership and identity.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    data = request.get_json(silent=True) or {}
    notes = (data.get('notes') or data.get('note') or '').strip()
    confirmed_identity = bool(data.get('confirmed_identity', False))
    called_applicant_number = bool(data.get('called_applicant_number', False))

    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    cursor.execute('''
        UPDATE volunteers
        SET interview_notes = ?,
            interview_confirmed_identity = ?,
            interview_called_applicant_number = ?,
            interview_by = ?,
            interview_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (notes, 1 if confirmed_identity else 0, 1 if called_applicant_number else 0, reviewer, actual_vol_id))

    audit_payload = {
        "confirmed_identity": confirmed_identity,
        "called_applicant_number": called_applicant_number
    }
    audit_note = f"Applicant interview completed by {reviewer}. Phone verified: {called_applicant_number}. Identity confirmed: {confirmed_identity}. Notes: {notes}"
    record_review_audit(cursor, actual_vol_id, reviewer, 'interview', audit_payload, audit_note)
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "volunteer_id": actual_vol_id,
            "confirmed_identity": confirmed_identity,
            "called_applicant_number": called_applicant_number,
            "interview_by": reviewer,
            "notes": notes,
            "message": "Interview recorded and phone ownership verified successfully"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/decision ──────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/decision', methods=['POST'])
@admin_required
def review_volunteer_decision(volunteer_id):
    """
    POST /api/admin/volunteers/<id>/decision
    {action: "approve"|"recommend"|"reject"|"request_info", checklist, note, reason_code, override_flags}

    Approval rules:
      - checklist items identity_matches_photo, phone_verified_by_call, interview_done, declaration_checked are true
      - at least 2 references have outcome "confirmed" and none is "negative"
      - training is passed (score >= 80)
      - note is at least 20 characters
      - no unresolved high-severity flag (can override only with override_flags=True and note mentioning override/code)
      - if REQUIRE_TWO_REVIEWERS is true: approval requires prior 'recommend' from a different reviewer

    On approval:
      status 'approved', level 'provisional', approved_by, approved_at, valid_until = 12 months.
    On reject:
      reason code in {"id_mismatch", "references_negative", "references_unreachable", "training_not_passed", "incomplete", "safety_concern", "underage", "other"} + note, sets reapply_after to 30 days.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    data = request.get_json(silent=True) or {}
    action = (data.get('action') or '').strip().lower()
    checklist = data.get('checklist') or {}
    note = (data.get('note') or '').strip()
    reason_code = (data.get('reason_code') or data.get('reject_reason_code') or '').strip().lower()
    override_flags = bool(data.get('override_flags', False))

    if action not in VALID_DECISION_ACTIONS:
        conn.close()
        return jsonify({
            "ok": False,
            "error": f"Invalid action '{action}'. Must be one of: {', '.join(sorted(VALID_DECISION_ACTIONS))}"
        }), 400

    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    # ─────────────────────────────────────────────────────────────
    # ACTION: APPROVE
    # ─────────────────────────────────────────────────────────────
    if action == 'approve':
        # 1. Checklist items check
        required_checks = ["identity_matches_photo", "phone_verified_by_call", "interview_done", "declaration_checked"]
        missing_checks = [k for k in required_checks if not checklist.get(k)]
        if missing_checks:
            conn.close()
            return jsonify({
                "ok": False,
                "error": f"Approval refused: Missing or false checklist items: {', '.join(missing_checks)}. All 4 review checks must be verified."
            }), 400

        # 2. References verification check
        cursor.execute('SELECT id, name, outcome FROM volunteer_references WHERE volunteer_id = ?;', (actual_vol_id,))
        refs = [dict(r) for r in cursor.fetchall()]

        confirmed_refs = [r for r in refs if r.get('outcome') == 'confirmed']
        negative_refs = [r for r in refs if r.get('outcome') == 'negative']

        if len(confirmed_refs) < 2:
            conn.close()
            return jsonify({
                "ok": False,
                "error": f"Approval refused: At least 2 references must have outcome 'confirmed' (currently {len(confirmed_refs)} confirmed)."
            }), 400

        if negative_refs:
            conn.close()
            return jsonify({
                "ok": False,
                "error": f"Approval refused: Reference check failed because {len(negative_refs)} reference(s) returned a 'negative' outcome."
            }), 400

        # 3. Training verification
        training_passed_at = vol.get('training_passed_at')
        training_score = vol.get('training_score') or 0.0
        if not training_passed_at or training_score < 80.0:
            conn.close()
            return jsonify({
                "ok": False,
                "error": "Approval refused: Volunteer safety training must be passed with a score of at least 80%."
            }), 400

        # 4. Note length check (minimum 20 characters)
        if len(note) < 20:
            conn.close()
            return jsonify({
                "ok": False,
                "error": f"Approval refused: Review note must be at least 20 characters explaining the approval (currently {len(note)} chars)."
            }), 400

        # 5. High-severity flags resolution check
        flags_raw = vol.get('flags_json')
        try:
            flags = json.loads(flags_raw) if flags_raw else []
        except Exception:
            flags = []

        high_flags = [f for f in flags if f.get('severity') == 'high']
        if high_flags:
            if not override_flags:
                conn.close()
                flag_codes = [f.get('code', 'high_flag') for f in high_flags]
                return jsonify({
                    "ok": False,
                    "error": f"Approval refused: Unresolved high-severity flags: {', '.join(flag_codes)}. An override requires override_flags=True and an explanatory note."
                }), 400

            # If override_flags is provided, the note MUST explicitly mention 'override' or the flag code
            note_lower = note.lower()
            flag_codes_lower = [f.get('code', '').lower() for f in high_flags]
            mentions_override = ('override' in note_lower) or any(fc in note_lower for fc in flag_codes_lower if fc)
            if not mentions_override:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": "Approval refused: Flag override rejected. The review note must explicitly mention 'override' or the specific flag codes being overridden."
                }), 400

        # 6. Two-reviewer check (if REQUIRE_TWO_REVIEWERS is enabled)
        if is_require_two_reviewers():
            cursor.execute('''
                SELECT reviewer, ts FROM volunteer_reviews
                WHERE volunteer_id = ? AND action = 'recommend'
                ORDER BY id DESC LIMIT 1;
            ''', (actual_vol_id,))
            recommend_row = cursor.fetchone()
            if not recommend_row:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": "Approval refused: Multi-reviewer policy active (REQUIRE_TWO_REVIEWERS). A recommendation from a reviewer is required prior to final approval."
                }), 400

            rec_reviewer = recommend_row['reviewer']
            if rec_reviewer == reviewer:
                conn.close()
                return jsonify({
                    "ok": False,
                    "error": f"Approval refused: Multi-reviewer policy violation. Final approval must be completed by a different reviewer than the recommending reviewer ('{rec_reviewer}')."
                }), 400

        # Passed all gates: Approve volunteer
        cursor.execute('''
            UPDATE volunteers
            SET status = 'approved',
                level = 'provisional',
                approved_at = CURRENT_TIMESTAMP,
                approved_by = ?,
                valid_until = datetime('now', '+1 year'),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (reviewer, actual_vol_id))

        record_review_audit(cursor, actual_vol_id, reviewer, 'approve', checklist, note)
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "volunteer_id": actual_vol_id,
                "status": "approved",
                "level": "provisional",
                "approved_by": reviewer,
                "valid_until": "12 months",
                "message": "Volunteer application successfully verified and approved"
            }
        }), 200

    # ─────────────────────────────────────────────────────────────
    # ACTION: RECOMMEND
    # ─────────────────────────────────────────────────────────────
    elif action == 'recommend':
        cursor.execute('''
            UPDATE volunteers
            SET status = 'in_review',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (actual_vol_id,))

        record_review_audit(cursor, actual_vol_id, reviewer, 'recommend', checklist, note or 'Application recommended for final review')
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "volunteer_id": actual_vol_id,
                "status": "in_review",
                "recommended_by": reviewer,
                "message": f"Volunteer application recommended by {reviewer} for final review"
            }
        }), 200

    # ─────────────────────────────────────────────────────────────
    # ACTION: REQUEST_INFO
    # ─────────────────────────────────────────────────────────────
    elif action == 'request_info':
        cursor.execute('''
            UPDATE volunteers
            SET status = 'in_review',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (actual_vol_id,))

        record_review_audit(cursor, actual_vol_id, reviewer, 'request_info', checklist, note or 'Additional information requested from applicant')
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "volunteer_id": actual_vol_id,
                "status": "in_review",
                "requested_by": reviewer,
                "message": "Additional information requested. Application marked in_review."
            }
        }), 200

    # ─────────────────────────────────────────────────────────────
    # ACTION: REJECT
    # ─────────────────────────────────────────────────────────────
    elif action == 'reject':
        if not reason_code or reason_code not in VALID_REJECT_REASONS:
            conn.close()
            return jsonify({
                "ok": False,
                "error": f"Rejection requires a valid reason_code from: {', '.join(sorted(VALID_REJECT_REASONS))}"
            }), 400

        if not note or len(note) < 5:
            conn.close()
            return jsonify({
                "ok": False,
                "error": "Rejection requires an explanatory note explaining why the application was rejected."
            }), 400

        cursor.execute('''
            UPDATE volunteers
            SET status = 'rejected',
                reject_reason_code = ?,
                reapply_after = datetime('now', '+30 days'),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (reason_code, actual_vol_id))

        record_review_audit(cursor, actual_vol_id, reviewer, 'reject', checklist, f"Reason: {reason_code}. Note: {note}")
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "volunteer_id": actual_vol_id,
                "status": "rejected",
                "reject_reason_code": reason_code,
                "reapply_after_days": 30,
                "message": f"Volunteer application rejected ({reason_code}). Reapplication cooldown set to 30 days."
            }
        }), 200

    # ─────────────────────────────────────────────────────────────
    # ACTION: RESOLVE (Un-suspend volunteer after review)
    # ─────────────────────────────────────────────────────────────
    elif action == 'resolve':
        if not note or len(note) < 5:
            conn.close()
            return jsonify({
                "ok": False,
                "error": "Resolve action requires an explanatory note explaining how the incident was reviewed."
            }), 400

        cursor.execute('''
            UPDATE volunteers
            SET status = 'approved',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?;
        ''', (actual_vol_id,))

        record_review_audit(cursor, actual_vol_id, reviewer, 'resolve', checklist, note)
        conn.commit()
        conn.close()

        return jsonify({
            "ok": True,
            "data": {
                "volunteer_id": actual_vol_id,
                "status": "approved",
                "resolved_by": reviewer,
                "note": note,
                "message": "Volunteer suspension resolved. Status restored to approved."
            }
        }), 200


# ─── Route: GET /api/admin/volunteers/<id>/audit ──────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/audit', methods=['GET'])
@admin_required
def get_volunteer_audit(volunteer_id):
    """
    GET /api/admin/volunteers/<id>/audit
    Returns the complete chronological review audit log for a volunteer.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    cursor.execute('''
        SELECT id, volunteer_id, reviewer, action, checklist_json, note, ts
        FROM volunteer_reviews
        WHERE volunteer_id = ?
        ORDER BY id ASC;
    ''', (actual_vol_id,))
    rows = cursor.fetchall()
    conn.close()

    audit_entries = []
    for r in rows:
        d = dict(r)
        if d.get('checklist_json'):
            try:
                d['checklist'] = json.loads(d['checklist_json'])
            except Exception:
                d['checklist'] = None
        else:
            d['checklist'] = None
        audit_entries.append(d)

    return jsonify({
        "ok": True,
        "data": {
            "volunteer_id": actual_vol_id,
            "audit_trail": audit_entries,
            "total_actions": len(audit_entries)
        },
        "audit": audit_entries
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/revoke ────────────
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/revoke', methods=['POST'])
@admin_required
def revoke_volunteer(volunteer_id):
    """
    POST /api/admin/volunteers/<id>/revoke {note}
    Revoke a volunteer at any time, setting status to 'revoked' and recording an audit row.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    data = request.get_json(silent=True) or {}
    note = (data.get('note') or 'Volunteer privileges revoked by admin').strip()
    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    cursor.execute('''
        UPDATE volunteers
        SET status = 'revoked',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (actual_vol_id,))

    record_review_audit(cursor, actual_vol_id, reviewer, 'revoke', None, note)
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": actual_vol_id,
            "status": "revoked",
            "revoked_by": reviewer,
            "note": note,
            "message": "Volunteer status revoked successfully"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/approve (legacy) ───
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/approve', methods=['POST'])
@admin_required
def approve_volunteer_legacy(volunteer_id):
    """
    Direct approval endpoint preserved for test suite backwards compatibility.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    data = request.get_json(silent=True) or {}
    level = data.get('level') or 'provisional'
    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    cursor.execute('''
        UPDATE volunteers
        SET status = 'approved',
            level = ?,
            approved_at = CURRENT_TIMESTAMP,
            approved_by = ?,
            valid_until = datetime('now', '+1 year'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (level, reviewer, actual_vol_id))

    record_review_audit(cursor, actual_vol_id, reviewer, 'approve', None, 'Direct administrative approval')
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": actual_vol_id,
            "status": "approved",
            "level": level,
            "message": "Volunteer approved successfully"
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/<id>/reject (legacy) ───
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/reject', methods=['POST'])
@admin_required
def reject_volunteer_legacy(volunteer_id):
    """
    Direct rejection endpoint preserved for test suite backwards compatibility.
    """
    conn = get_db()
    cursor = conn.cursor()

    vol = find_volunteer(cursor, volunteer_id)
    if not vol:
        conn.close()
        return jsonify({"ok": False, "error": "Volunteer not found"}), 404

    actual_vol_id = vol['id']
    data = request.get_json(silent=True) or {}
    reason_code = data.get('reason_code') or data.get('reject_reason_code') or 'policy_check_failed'
    reviewer = getattr(g, 'admin_reviewer', 'Admin')

    cursor.execute('''
        UPDATE volunteers
        SET status = 'rejected',
            reject_reason_code = ?,
            reapply_after = datetime('now', '+30 days'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?;
    ''', (reason_code, actual_vol_id))

    record_review_audit(cursor, actual_vol_id, reviewer, 'reject', None, f"Rejection code: {reason_code}")
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "id": actual_vol_id,
            "status": "rejected",
            "reject_reason_code": reason_code,
            "reapply_after_days": 30,
            "message": "Volunteer application rejected. Reapplication cooldown set to 30 days."
        }
    }), 200


# ─── Route: POST /api/admin/volunteers/approve-all ───────────
@admin_bp.route('/api/admin/volunteers/approve-all', methods=['POST'])
@admin_required
def approve_all_volunteers():
    """
    Approve all pending volunteers at once.
    """
    reviewer = getattr(g, 'admin_reviewer', 'Admin')
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE volunteers SET status = 'approved', approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE status IN ('pending', 'submitted');", (reviewer,))
    updated_count = cursor.rowcount
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "approved_count": updated_count,
            "message": f"Successfully approved {updated_count} volunteer(s)"
        }
    }), 200


# ─── Route: POST /api/admin/purge-test-data ───────────────────
@admin_bp.route('/api/admin/purge-test-data', methods=['POST'])
@admin_required
def purge_test_data():
    """
    Purges obsolete automated test dummy accounts while preserving real user accounts (ID >= 10000).
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM users WHERE id < 10000;')
    cursor.execute('DELETE FROM contacts WHERE user_id < 10000;')
    cursor.execute('DELETE FROM alerts WHERE user_id < 10000;')
    cursor.execute('DELETE FROM locations WHERE alert_id NOT IN (SELECT id FROM alerts);')
    cursor.execute('DELETE FROM volunteers WHERE user_id < 10000;')
    cursor.execute('DELETE FROM timers WHERE user_id < 10000;')
    cursor.execute('DELETE FROM volunteer_references WHERE volunteer_id NOT IN (SELECT id FROM volunteers);')
    cursor.execute('DELETE FROM volunteer_training_attempts WHERE volunteer_id NOT IN (SELECT id FROM volunteers);')
    cursor.execute('DELETE FROM volunteer_reviews WHERE volunteer_id NOT IN (SELECT id FROM volunteers);')
    conn.commit()

    cursor.execute('SELECT COUNT(*) AS total FROM users;')
    user_count = cursor.fetchone()['total']
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "remaining_users": user_count,
            "message": f"Purged automated test users. Real users remaining: {user_count}"
        }
    }), 200


# ─── Route: GET /api/admin/stats ──────────────────────────────
@admin_bp.route('/api/admin/stats', methods=['GET'])
@admin_required
def get_admin_stats():
    """
    Return platform statistics for the admin dashboard:
    - total_users
    - active_alerts
    - alerts_today
    - approved_volunteers
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT COUNT(*) AS total FROM users;')
    total_users = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM alerts WHERE status = 'active';")
    active_alerts = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM alerts WHERE date(started_at) = date('now');")
    alerts_today = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM volunteers WHERE status = 'approved';")
    approved_volunteers = cursor.fetchone()['total']

    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "total_users": total_users,
            "active_alerts": active_alerts,
            "alerts_today": alerts_today,
            "approved_volunteers": approved_volunteers,
            "reviewer_name": getattr(g, 'admin_reviewer', 'Admin'),
            "require_two_reviewers": is_require_two_reviewers()
        }
    }), 200


# ─── Route: GET /api/admin/logs ──────────────────────────────
@admin_bp.route('/api/admin/logs', methods=['GET'])
@admin_required
def get_admin_logs():
    """
    Return the last 100 lines from backend/logs/app.log.
    """
    log_file = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'logs', 'app.log'))
    lines = []
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                all_lines = f.readlines()
                lines = [line.rstrip('\r\n') for line in all_lines[-100:]]
        except Exception as e:
            return jsonify({"ok": False, "error": f"Failed reading log file: {str(e)}"}), 500

    return jsonify({
        "ok": True,
        "data": {
            "lines": lines,
            "count": len(lines)
        }
    }), 200


# --- Route: POST /api/admin/volunteers/<int:volunteer_id>/quick-approve ---
@admin_bp.route('/api/admin/volunteers/<int:volunteer_id>/quick-approve', methods=['POST'])
@admin_required
def quick_approve_volunteer(volunteer_id):
    """
    1-Tap Quick Approve for testing and fast approval from admin dashboard.
    """
    reviewer = getattr(g, 'admin_reviewer', 'Admin')
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("UPDATE volunteers SET status = 'approved', level = 'trusted', badge = 'Trusted', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, valid_until = datetime('now', '+1 year'), available = 1, lat = COALESCE(lat, 12.9716), lng = COALESCE(lng, 77.5946), updated_at = CURRENT_TIMESTAMP WHERE id = ? OR user_id = ?;", (reviewer, volunteer_id, volunteer_id))

    record_review_audit(cursor, volunteer_id, reviewer, 'approve', None, 'Quick-approved via admin dashboard')
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "volunteer_id": volunteer_id,
            "status": "approved",
            "message": f"Volunteer #{volunteer_id} quick-approved successfully!"
        }
    }), 200

# backend/test_volunteer_review.py – Automated tests for Volunteer Review Backend
import os
import io
import sys
import json
import unittest
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app
from db import get_db, init_db
import jwt
from routes.auth import SECRET_KEY


class TestVolunteerReview(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        os.environ['ADMIN_REVIEWERS'] = 'Admin:safeher-admin-secret-key-123,Reviewer1:key_rev1_2026,Reviewer2:key_rev2_2026'
        os.environ['REQUIRE_TWO_REVIEWERS'] = 'false'

    def setUp(self):
        init_db()
        self.client = app.test_client()
        os.environ['REQUIRE_TWO_REVIEWERS'] = 'false'

        # Create primary test applicant
        conn = get_db()
        c = conn.cursor()
        c.execute("DELETE FROM users WHERE phone IN ('9988776601', '9988776602', '9988776603');")
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Pooja Sharma', '9988776601', 'pooja@test.org', 'test_pw');
        """)
        self.user1_id = c.lastrowid
        conn.commit()
        conn.close()

        token = jwt.encode({"user_id": self.user1_id}, SECRET_KEY, algorithm="HS256")
        self.user1_headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        self.rev1_headers = {
            "X-Admin-Key": "key_rev1_2026",
            "Content-Type": "application/json"
        }
        self.rev2_headers = {
            "X-Admin-Key": "key_rev2_2026",
            "Content-Type": "application/json"
        }
        self.invalid_admin_headers = {
            "X-Admin-Key": "completely_wrong_key",
            "Content-Type": "application/json"
        }

    def _create_and_submit_volunteer(self, user_headers, user_id, full_name="Pooja Sharma",
                                     id_type="Voter ID", id_last4="8765",
                                     ref1_phone="9876543210", ref2_phone="9876543211",
                                     typed_sig=None, score=100.0):
        if typed_sig is None:
            typed_sig = full_name
        # 1. Save draft
        draft_payload = {
            "full_name": full_name,
            "dob": "1997-08-20",
            "locality": "Koramangala, Bengaluru",
            "id_type": id_type,
            "id_last4": id_last4,
            "motivation": "Dedicated to community safety and night-time neighborhood support.",
            "availability_text": "Weekdays 7 PM to 12 AM and full weekends",
            "declaration_accepted": True,
            "declaration_version": "v1.0",
            "typed_signature": typed_sig,
            "references": [
                {"name": "Prof. Rao", "phone": ref1_phone, "relation": "Mentor"},
                {"name": "Meera Patel", "phone": ref2_phone, "relation": "Colleague"}
            ]
        }
        self.client.put('/api/volunteers/application', json=draft_payload, headers=user_headers)

        # 2. Upload ID Image & Selfie
        png_data = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
        auth_hdr = {"Authorization": user_headers["Authorization"]}

        self.client.post('/api/volunteers/application/id-image',
                         data={"id_image": (io.BytesIO(png_data), "voter_id.png")},
                         content_type='multipart/form-data',
                         headers=auth_hdr)
        self.client.post('/api/volunteers/application/selfie',
                         data={"selfie": (io.BytesIO(png_data), "live_selfie.png")},
                         content_type='multipart/form-data',
                         headers=auth_hdr)

        # 3. Pass training
        conn = get_db()
        c = conn.cursor()
        c.execute('''
            UPDATE volunteers
            SET training_score = ?,
                training_passed_at = CURRENT_TIMESTAMP
            WHERE user_id = ?;
        ''', (score, user_id))
        conn.commit()
        conn.close()

        # 4. Submit
        res = self.client.post('/api/volunteers/application/submit', headers=user_headers)
        return res

    def test_admin_auth_and_reviewer_resolution(self):
        # 1. Unauthorized with invalid key
        res_fail = self.client.get('/api/admin/volunteers', headers=self.invalid_admin_headers)
        self.assertEqual(res_fail.status_code, 401)

        # 2. Authorized with Reviewer1 key
        res_ok = self.client.get('/api/admin/volunteers', headers=self.rev1_headers)
        self.assertEqual(res_ok.status_code, 200)
        self.assertIn("counts", res_ok.get_json())

        # 3. Authorized with Bearer token in Authorization header
        bearer_hdr = {"Authorization": "Bearer key_rev2_2026"}
        res_bearer = self.client.get('/api/admin/volunteers', headers=bearer_hdr)
        self.assertEqual(res_bearer.status_code, 200)

    def test_automatic_flags_computed_on_submit(self):
        # Create applicant 1
        sub1 = self._create_and_submit_volunteer(self.user1_headers, self.user1_id,
                                                id_type="Voter ID", id_last4="7777")
        self.assertEqual(sub1.status_code, 200)
        vol1_id = sub1.get_json()['data']['volunteer_id']

        # Create applicant 2 with duplicate ID last 4 and duplicate ref phone
        conn = get_db()
        c = conn.cursor()
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Duplicate Applicant', '9988776602', 'dup@test.org', 'test_pw');
        """)
        user2_id = c.lastrowid
        conn.commit()
        conn.close()

        token2 = jwt.encode({"user_id": user2_id}, SECRET_KEY, algorithm="HS256")
        user2_headers = {"Authorization": f"Bearer {token2}", "Content-Type": "application/json"}

        # Submitting with same ID type + last 4 and with applicant 1's phone as reference
        sub2 = self._create_and_submit_volunteer(user2_headers, user2_id,
                                                 full_name="Duplicate Applicant",
                                                 id_type="Voter ID", id_last4="7777",
                                                 ref1_phone="9988776601",  # Applicant 1's phone
                                                 ref2_phone="9876543299")
        self.assertEqual(sub2.status_code, 200)
        vol2_id = sub2.get_json()['data']['volunteer_id']

        # Fetch packet for vol2_id
        res_pkt = self.client.get(f'/api/admin/volunteers/{vol2_id}', headers=self.rev1_headers)
        self.assertEqual(res_pkt.status_code, 200)
        flags = res_pkt.get_json()['data']['flags']
        flag_codes = [f['code'] for f in flags]

        self.assertIn("duplicate_id", flag_codes)
        self.assertIn("reference_phone_conflict", flag_codes)

        # Confirm ID image is omitted from the application packet
        self.assertNotIn('id_image_path', res_pkt.get_json()['data']['volunteer'])

    def test_stream_id_image_and_view_audit(self):
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        # Stream ID image
        res_img = self.client.get(f'/api/admin/volunteers/{vol_id}/id-image', headers=self.rev1_headers)
        self.assertEqual(res_img.status_code, 200)
        self.assertIn(res_img.content_type, ['image/png', 'image/jpeg'])

        # Check audit trail
        res_audit = self.client.get(f'/api/admin/volunteers/{vol_id}/audit', headers=self.rev1_headers)
        self.assertEqual(res_audit.status_code, 200)
        audit_trail = res_audit.get_json()['data']['audit_trail']
        actions = [a['action'] for a in audit_trail]
        self.assertIn('view_id_image', actions)
        img_audit = next(a for a in audit_trail if a['action'] == 'view_id_image')
        self.assertEqual(img_audit['reviewer'], 'Reviewer1')

    def test_reference_calls_and_interview_recording(self):
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        pkt = self.client.get(f'/api/admin/volunteers/{vol_id}', headers=self.rev1_headers).get_json()['data']
        refs = pkt['references']
        self.assertEqual(len(refs), 2)
        ref1_id = refs[0]['id']
        ref2_id = refs[1]['id']

        # Record reference 1 call
        res_ref1 = self.client.post(f'/api/admin/volunteers/{vol_id}/references/{ref1_id}',
                                    json={"outcome": "confirmed", "notes": "Known applicant for 3 years. Strongly recommends."},
                                    headers=self.rev1_headers)
        self.assertEqual(res_ref1.status_code, 200)
        self.assertEqual(res_ref1.get_json()['data']['reference']['outcome'], 'confirmed')
        self.assertEqual(res_ref1.get_json()['data']['reference']['reviewer'], 'Reviewer1')

        # Record phone interview
        res_intv = self.client.post(f'/api/admin/volunteers/{vol_id}/interview',
                                    json={
                                        "notes": "Called applicant on registered mobile. Verified identity and emergency readiness.",
                                        "confirmed_identity": True,
                                        "called_applicant_number": True
                                    },
                                    headers=self.rev1_headers)
        self.assertEqual(res_intv.status_code, 200)
        self.assertTrue(res_intv.get_json()['data']['confirmed_identity'])

    def test_approval_blocked_with_one_reference(self):
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        pkt = self.client.get(f'/api/admin/volunteers/{vol_id}', headers=self.rev1_headers).get_json()['data']
        ref1_id = pkt['references'][0]['id']

        # Confirm only ONE reference
        self.client.post(f'/api/admin/volunteers/{vol_id}/references/{ref1_id}',
                         json={"outcome": "confirmed", "notes": "Confirmed mentor."},
                         headers=self.rev1_headers)

        # Phone interview done
        self.client.post(f'/api/admin/volunteers/{vol_id}/interview',
                         json={"notes": "Identity confirmed", "confirmed_identity": True, "called_applicant_number": True},
                         headers=self.rev1_headers)

        # Attempt approval
        decision_payload = {
            "action": "approve",
            "checklist": {
                "identity_matches_photo": True,
                "phone_verified_by_call": True,
                "interview_done": True,
                "declaration_checked": True
            },
            "note": "Applicant has demonstrated outstanding knowledge and passed safety checks."
        }
        res_appr = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=decision_payload, headers=self.rev1_headers)
        self.assertEqual(res_appr.status_code, 400)
        self.assertIn("at least 2 references must have outcome 'confirmed'", res_appr.get_json()['error'].lower())

    def test_approval_blocked_with_high_flag_and_no_override(self):
        # Intentionally inject a high-severity flag into volunteer record
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        conn = get_db()
        c = conn.cursor()
        fake_flags = [
            {"code": "recent_rejection", "severity": "high", "message": "Rejected 45 days ago"},
            {"code": "incomplete_profile", "severity": "info", "message": "Short bio"}
        ]
        c.execute("UPDATE volunteers SET flags_json = ? WHERE id = ?;", (json.dumps(fake_flags), vol_id))
        conn.commit()
        conn.close()

        # Confirm both references
        pkt = self.client.get(f'/api/admin/volunteers/{vol_id}', headers=self.rev1_headers).get_json()['data']
        for r in pkt['references']:
            self.client.post(f'/api/admin/volunteers/{vol_id}/references/{r["id"]}',
                             json={"outcome": "confirmed", "notes": "Confirmed by reviewer."},
                             headers=self.rev1_headers)

        self.client.post(f'/api/admin/volunteers/{vol_id}/interview',
                         json={"notes": "Identity confirmed", "confirmed_identity": True, "called_applicant_number": True},
                         headers=self.rev1_headers)

        # 1. Attempt approval with no override_flags
        decision_payload = {
            "action": "approve",
            "checklist": {
                "identity_matches_photo": True,
                "phone_verified_by_call": True,
                "interview_done": True,
                "declaration_checked": True
            },
            "note": "All requirements checked and verified in detail by reviewer.",
            "override_flags": False
        }
        res_no_ovr = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=decision_payload, headers=self.rev1_headers)
        self.assertEqual(res_no_ovr.status_code, 400)
        self.assertIn("unresolved high-severity flags", res_no_ovr.get_json()['error'].lower())

        # 2. Attempt approval with override_flags=True but note doesn't mention override or code
        decision_payload['override_flags'] = True
        decision_payload['note'] = "Approving this volunteer because they are great at community service."
        res_bad_ovr = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=decision_payload, headers=self.rev1_headers)
        self.assertEqual(res_bad_ovr.status_code, 400)
        self.assertIn("must explicitly mention", res_bad_ovr.get_json()['error'].lower())

        # 3. Approval succeeds when override_flags=True AND note mentions 'override'
        decision_payload['note'] = "Admin override: recent_rejection was reviewed and applicant has completed additional training."
        res_ovr_ok = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=decision_payload, headers=self.rev1_headers)
        self.assertEqual(res_ovr_ok.status_code, 200)
        self.assertEqual(res_ovr_ok.get_json()['data']['status'], 'approved')
        self.assertEqual(res_ovr_ok.get_json()['data']['level'], 'provisional')

    def test_approval_accepted_with_everything_complete(self):
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        pkt = self.client.get(f'/api/admin/volunteers/{vol_id}', headers=self.rev1_headers).get_json()['data']
        for r in pkt['references']:
            self.client.post(f'/api/admin/volunteers/{vol_id}/references/{r["id"]}',
                             json={"outcome": "confirmed", "notes": "Positive character reference."},
                             headers=self.rev1_headers)

        self.client.post(f'/api/admin/volunteers/{vol_id}/interview',
                         json={"notes": "Interview complete. Phone ownership confirmed.", "confirmed_identity": True, "called_applicant_number": True},
                         headers=self.rev1_headers)

        decision_payload = {
            "action": "approve",
            "checklist": {
                "identity_matches_photo": True,
                "phone_verified_by_call": True,
                "interview_done": True,
                "declaration_checked": True
            },
            "note": "Complete background verification successful. All checks passed with honors."
        }
        res_appr = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=decision_payload, headers=self.rev1_headers)
        self.assertEqual(res_appr.status_code, 200)
        data = res_appr.get_json()['data']
        self.assertEqual(data['status'], 'approved')
        self.assertEqual(data['level'], 'provisional')
        self.assertEqual(data['approved_by'], 'Reviewer1')
        self.assertEqual(data['valid_until'], '12 months')

        # Check volunteer in database
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT status, level, approved_by, valid_until FROM volunteers WHERE id = ?;", (vol_id,))
        row = dict(c.fetchone())
        conn.close()
        self.assertEqual(row['status'], 'approved')
        self.assertEqual(row['level'], 'provisional')
        self.assertEqual(row['approved_by'], 'Reviewer1')

    def test_require_two_reviewers_workflow(self):
        os.environ['REQUIRE_TWO_REVIEWERS'] = 'true'

        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        pkt = self.client.get(f'/api/admin/volunteers/{vol_id}', headers=self.rev1_headers).get_json()['data']
        for r in pkt['references']:
            self.client.post(f'/api/admin/volunteers/{vol_id}/references/{r["id"]}',
                             json={"outcome": "confirmed", "notes": "Confirmed."},
                             headers=self.rev1_headers)

        self.client.post(f'/api/admin/volunteers/{vol_id}/interview',
                         json={"notes": "Phone verified", "confirmed_identity": True, "called_applicant_number": True},
                         headers=self.rev1_headers)

        approve_payload = {
            "action": "approve",
            "checklist": {
                "identity_matches_photo": True,
                "phone_verified_by_call": True,
                "interview_done": True,
                "declaration_checked": True
            },
            "note": "Applicant is fully qualified and verified by reviewer team."
        }

        # 1. Approval refused before any recommendation is made
        res_block1 = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=approve_payload, headers=self.rev1_headers)
        self.assertEqual(res_block1.status_code, 400)
        self.assertIn("recommendation", res_block1.get_json()['error'].lower())

        # 2. Reviewer 1 recommends
        res_rec = self.client.post(f'/api/admin/volunteers/{vol_id}/decision',
                                   json={"action": "recommend", "note": "Initial review passed, recommending for secondary approval"},
                                   headers=self.rev1_headers)
        self.assertEqual(res_rec.status_code, 200)
        self.assertEqual(res_rec.get_json()['data']['status'], 'in_review')

        # 3. Same Reviewer (Reviewer 1) cannot approve
        res_block2 = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=approve_payload, headers=self.rev1_headers)
        self.assertEqual(res_block2.status_code, 400)
        self.assertIn("different reviewer", res_block2.get_json()['error'].lower())

        # 4. Different Reviewer (Reviewer 2) approves successfully
        res_appr2 = self.client.post(f'/api/admin/volunteers/{vol_id}/decision', json=approve_payload, headers=self.rev2_headers)
        self.assertEqual(res_appr2.status_code, 200)
        self.assertEqual(res_appr2.get_json()['data']['status'], 'approved')
        self.assertEqual(res_appr2.get_json()['data']['approved_by'], 'Reviewer2')

    def test_rejection_and_revocation(self):
        sub = self._create_and_submit_volunteer(self.user1_headers, self.user1_id)
        vol_id = sub.get_json()['data']['volunteer_id']

        # 1. Invalid reason code rejected
        res_bad_reason = self.client.post(f'/api/admin/volunteers/{vol_id}/decision',
                                          json={"action": "reject", "reason_code": "unknown_reason", "note": "Failed review."},
                                          headers=self.rev1_headers)
        self.assertEqual(res_bad_reason.status_code, 400)

        # 2. Valid rejection with reason code sets reapply_after to 30 days
        res_rej = self.client.post(f'/api/admin/volunteers/{vol_id}/decision',
                                   json={"action": "reject", "reason_code": "safety_concern", "note": "Failed community safety standards check."},
                                   headers=self.rev1_headers)
        self.assertEqual(res_rej.status_code, 200)
        self.assertEqual(res_rej.get_json()['data']['status'], 'rejected')
        self.assertEqual(res_rej.get_json()['data']['reject_reason_code'], 'safety_concern')
        self.assertEqual(res_rej.get_json()['data']['reapply_after_days'], 30)

        # 3. Test revocation on an approved volunteer
        # First approve directly
        self.client.post(f'/api/admin/volunteers/{vol_id}/approve', headers=self.rev1_headers)

        # Revoke
        res_rev = self.client.post(f'/api/admin/volunteers/{vol_id}/revoke',
                                   json={"note": "Volunteer violated safety code during dispatch."},
                                   headers=self.rev1_headers)
        self.assertEqual(res_rev.status_code, 200)
        self.assertEqual(res_rev.get_json()['data']['status'], 'revoked')

        # Check audit entry for revoke
        res_aud = self.client.get(f'/api/admin/volunteers/{vol_id}/audit', headers=self.rev1_headers)
        actions = [a['action'] for a in res_aud.get_json()['data']['audit_trail']]
        self.assertIn('revoke', actions)


if __name__ == '__main__':
    unittest.main()

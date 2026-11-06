# backend/test_volunteer_application.py – Verification of Volunteer Application & KYC System
import sys
import os
import io
import unittest
import json
import sqlite3
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app
from db import get_db, init_db
from scheduler import cleanup_old_volunteer_id_images


class TestVolunteerApplication(unittest.TestCase):
    def setUp(self):
        init_db()
        self.client = app.test_client()

        # Create test user
        conn = get_db()
        c = conn.cursor()
        c.execute("DELETE FROM users WHERE phone IN ('9911223344', '9911223345');")
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Sunita Verma', '9911223344', 'sunita.test@example.com', 'dummy_hash');
        """)
        self.user_id = c.lastrowid
        conn.commit()
        conn.close()

        # Login to obtain JWT token
        # For our test client, we can pass user_id or Authorization token
        import jwt
        from routes.auth import SECRET_KEY
        token = jwt.encode({"user_id": self.user_id}, SECRET_KEY, algorithm="HS256")
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        self.raw_auth_header = {"Authorization": f"Bearer {token}"}

    def test_full_volunteer_application_workflow(self):
        # 1. Save draft details via PUT /api/volunteers/application
        draft_payload = {
            "full_name": "Sunita Verma",
            "dob": "1998-05-15",
            "locality": "Indiranagar, Bengaluru",
            "id_type": "Voter ID",
            "id_last4": "4821",
            "motivation": "I want to help women travel safely in my neighborhood.",
            "availability_text": "Evenings 6 PM to 11 PM and weekends",
            "declaration_accepted": True,
            "declaration_version": "v1.0",
            "typed_signature": "Sunita Verma",
            "references": [
                {"name": "Anita Rao", "phone": "9887766551", "relation": "Colleague"},
                {"name": "Dr. Ramesh Gupta", "phone": "9887766552", "relation": "Teacher"}
            ]
        }
        res_draft = self.client.put('/api/volunteers/application', json=draft_payload, headers=self.headers)
        self.assertEqual(res_draft.status_code, 200)
        data = res_draft.get_json()['data']
        self.assertEqual(data['status'], 'draft')
        self.assertEqual(data['id_last4'], '4821')
        self.assertEqual(len(data['references']), 2)

        # 2. Reject full ID numbers (> 4 characters)
        res_bad_id = self.client.put('/api/volunteers/application', json={"id_last4": "ABC12345678"}, headers=self.headers)
        self.assertEqual(res_bad_id.status_code, 400)
        self.assertIn("at most 4 digits", res_bad_id.get_json()['error'])

        # 3. Test image uploads with magic byte validation
        # (a) Reject text or fake file disguised as image
        fake_file = (io.BytesIO(b"This is just plain text, not a real image"), "fake.jpg")
        res_fake = self.client.post('/api/volunteers/application/id-image',
                                    data={'file': fake_file},
                                    content_type='multipart/form-data',
                                    headers=self.raw_auth_header)
        self.assertEqual(res_fake.status_code, 400)
        self.assertIn("Only real JPEG or PNG", res_fake.get_json()['error'])

        # (b) Reject file exceeding 2 MB
        oversized = (io.BytesIO(b'\xff\xd8\xff' + b'0' * (2 * 1024 * 1024 + 10)), "big.jpg")
        res_over = self.client.post('/api/volunteers/application/id-image',
                                    data={'file': oversized},
                                    content_type='multipart/form-data',
                                    headers=self.raw_auth_header)
        self.assertEqual(res_over.status_code, 413)

        # (c) Valid JPEG ID Image (starts with \xff\xd8\xff)
        valid_jpeg = (io.BytesIO(b'\xff\xd8\xff\xe0\x00\x10JFIF' + b'\x00' * 50), "id.jpg")
        res_id = self.client.post('/api/volunteers/application/id-image',
                                  data={'file': valid_jpeg},
                                  content_type='multipart/form-data',
                                  headers=self.raw_auth_header)
        self.assertEqual(res_id.status_code, 200)
        id_path = res_id.get_json()['data']['path']
        self.assertTrue(id_path.startswith("private_uploads/"))

        # (d) Valid PNG Selfie (starts with \x89PNG\r\n\x1a\n)
        valid_png = (io.BytesIO(b'\x89PNG\r\n\x1a\n\x00\x00' + b'\x00' * 50), "selfie.png")
        res_selfie = self.client.post('/api/volunteers/application/selfie',
                                      data={'file': valid_png},
                                      content_type='multipart/form-data',
                                      headers=self.raw_auth_header)
        self.assertEqual(res_selfie.status_code, 200)
        selfie_path = res_selfie.get_json()['data']['path']
        self.assertTrue(selfie_path.startswith("private_uploads/"))

        # 4. Training Questionnaire
        # (a) GET /api/volunteers/training (8 questions without answers)
        res_train = self.client.get('/api/volunteers/training', headers=self.headers)
        self.assertEqual(res_train.status_code, 200)
        train_data = res_train.get_json()['data']
        self.assertEqual(train_data['total_questions'], 8)
        self.assertEqual(len(train_data['questions']), 8)
        # Verify answers are NOT in the response
        for q in train_data['questions']:
            self.assertNotIn('correct_answer', q)
            self.assertEqual(len(q['options']), 4)

        # (b) Submit failing training (< 80%)
        # Only answer 2 correctly
        fail_answers = {
            "1": "Call 112 first and don’t confront anyone",
            "2": "Physically intervene immediately between the person and the threat",  # wrong
            "3": "You can post photos of the incident if you blur their face",  # wrong
            "4": "Never contact the person afterwards without their clear consent",
            "5": "Proceed to the alert location anyway because the victim needs help",  # wrong
            "6": "Call her phone immediately to ask what the situation is",  # wrong
            "7": "Insist that she enters your private vehicle immediately",  # wrong
            "8": "Your profile, ID details, and phone number are publicly visible to all app users"  # wrong
        }
        res_fail_train = self.client.post('/api/volunteers/training/submit', json={"answers": fail_answers}, headers=self.headers)
        self.assertEqual(res_fail_train.status_code, 400)
        self.assertFalse(res_fail_train.get_json()['data']['passed'])
        self.assertEqual(res_fail_train.get_json()['data']['score'], 25.0)

        # (c) Attempting retry immediately triggers 24-hr lockout
        res_retry_blocked = self.client.post('/api/volunteers/training/submit', json={"answers": fail_answers}, headers=self.headers)
        self.assertEqual(res_retry_blocked.status_code, 429)
        self.assertIn("retry after 24 hours", res_retry_blocked.get_json()['error'])

        # Reset attempt for testing passing score: update taken_at to > 24 hours ago
        conn = get_db()
        c = conn.cursor()
        c.execute("UPDATE volunteer_training_attempts SET taken_at = datetime('now', '-25 hours');")
        conn.commit()
        conn.close()

        # (d) Submit passing training (100% >= 80%)
        pass_answers = {
            "1": "Call 112 first and don’t confront anyone",
            "2": "If the person is with someone threatening, stay at a distance and call 112",
            "3": "Never post the person’s location, photo or story on social media",
            "4": "Never contact the person afterwards without their clear consent",
            "5": "If you are alone in an unsafe place, use “Can’t help” and don’t go",
            "6": "A silent-mode alert (screen dark, no sound) is high risk, so call 112 and don’t call or message her",
            "7": "Never go alone with her to a private place or vehicle unless she asks and it is safe",
            "8": "Your data is used only to verify you and to match you with nearby alerts"
        }
        res_pass_train = self.client.post('/api/volunteers/training/submit', json={"answers": pass_answers}, headers=self.headers)
        self.assertEqual(res_pass_train.status_code, 200)
        self.assertTrue(res_pass_train.get_json()['data']['passed'])
        self.assertEqual(res_pass_train.get_json()['data']['score'], 100.0)

        # 5. Validation on Submit
        # (a) Test Age under 18 rejection
        self.client.put('/api/volunteers/application', json={"dob": "2015-01-01"}, headers=self.headers)
        res_underage = self.client.post('/api/volunteers/application/submit', headers=self.headers)
        self.assertEqual(res_underage.status_code, 400)
        self.assertIn("at least 18 years of age", res_underage.get_json()['error'])

        # Restore valid adult dob
        self.client.put('/api/volunteers/application', json={"dob": "1998-05-15"}, headers=self.headers)

        # (b) Test Signature mismatch rejection
        self.client.put('/api/volunteers/application', json={"typed_signature": "Jane Doe"}, headers=self.headers)
        res_bad_sig = self.client.post('/api/volunteers/application/submit', headers=self.headers)
        self.assertEqual(res_bad_sig.status_code, 400)
        self.assertIn("Typed signature", res_bad_sig.get_json()['error'])

        # Restore correct signature
        self.client.put('/api/volunteers/application', json={"typed_signature": "Sunita Verma"}, headers=self.headers)

        # (c) Test Reference phone matching applicant's phone rejection
        bad_refs = [
            {"name": "Anita Rao", "phone": "9911223344", "relation": "Self Phone"},  # same as user
            {"name": "Dr. Ramesh", "phone": "9887766552", "relation": "Teacher"}
        ]
        self.client.put('/api/volunteers/application', json={"references": bad_refs}, headers=self.headers)
        res_self_ref = self.client.post('/api/volunteers/application/submit', headers=self.headers)
        self.assertEqual(res_self_ref.status_code, 400)
        self.assertIn("cannot be the applicant's own phone", res_self_ref.get_json()['error'])

        # Restore valid references with different phone numbers
        good_refs = [
            {"name": "Anita Rao", "phone": "9887766551", "relation": "Colleague"},
            {"name": "Dr. Ramesh Gupta", "phone": "9887766552", "relation": "Teacher"}
        ]
        self.client.put('/api/volunteers/application', json={"references": good_refs}, headers=self.headers)

        # (d) Valid Submit
        res_submit = self.client.post('/api/volunteers/application/submit', headers=self.headers)
        self.assertEqual(res_submit.status_code, 200)
        sub_data = res_submit.get_json()['data']
        self.assertEqual(sub_data['status'], 'submitted')
        self.assertEqual(sub_data['full_name'], 'Sunita Verma')

        # 6. Admin Rejection & 30-day Cooldown
        admin_key = os.getenv('ADMIN_KEY', 'safeher_admin_secret_key_2026')
        admin_headers = {"X-Admin-Key": admin_key, "Content-Type": "application/json"}
        vol_id = sub_data['volunteer_id']

        res_reject = self.client.post(f'/api/admin/volunteers/{vol_id}/reject',
                                      json={"reason_code": "failed_background_check"},
                                      headers=admin_headers)
        self.assertEqual(res_reject.status_code, 200)
        self.assertEqual(res_reject.get_json()['data']['status'], 'rejected')

        # Attempting to save draft or submit during 30-day cooldown triggers 403
        res_blocked_draft = self.client.put('/api/volunteers/application', json={"motivation": "Please reconsider"}, headers=self.headers)
        self.assertEqual(res_blocked_draft.status_code, 403)
        self.assertIn("cooldown active", res_blocked_draft.get_json()['error'].lower())

        res_blocked_sub = self.client.post('/api/volunteers/application/submit', headers=self.headers)
        self.assertEqual(res_blocked_sub.status_code, 403)

        # 7. Scheduler 7-day ID Image Retention Deletion
        # Create a dummy image file and assign to this rejected volunteer
        conn = get_db()
        c = conn.cursor()
        test_img_path = "private_uploads/test_id_scheduler.jpg"
        abs_img_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), test_img_path)
        with open(abs_img_path, 'wb') as f:
            f.write(b'\xff\xd8\xff\xe0\x00\x10test')

        c.execute("""
            UPDATE volunteers
            SET id_image_path = ?,
                id_last4 = '4821',
                id_type = 'Voter ID',
                updated_at = datetime('now', '-8 days')
            WHERE id = ?;
        """, (test_img_path, vol_id))
        conn.commit()
        conn.close()

        self.assertTrue(os.path.exists(abs_img_path))

        # Run scheduler cleanup
        purged = cleanup_old_volunteer_id_images()
        self.assertGreaterEqual(purged, 1)

        # Verify on-disk file is removed
        self.assertFalse(os.path.exists(abs_img_path))

        # Verify database has cleared id_image_path to NULL while keeping id_last4 and id_type intact
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id_image_path, id_last4, id_type FROM volunteers WHERE id = ?;", (vol_id,))
        final_row = c.fetchone()
        conn.close()

        self.assertIsNone(final_row['id_image_path'])
        self.assertEqual(final_row['id_last4'], '4821')
        self.assertEqual(final_row['id_type'], 'Voter ID')


if __name__ == '__main__':
    unittest.main()

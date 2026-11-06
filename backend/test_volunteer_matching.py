# backend/test_volunteer_matching.py – Tests for Volunteer Matching, Proximity Masking & Accountability
import os
import sys
import json
import unittest
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app
from db import get_db, init_db
import jwt
from routes.auth import SECRET_KEY
from scheduler import promote_eligible_volunteers_to_trusted, expire_outdated_volunteer_validity


class TestVolunteerMatching(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        os.environ['ADMIN_KEY'] = 'safeher-admin-secret-key-123'
        os.environ['ADMIN_REVIEWERS'] = 'Admin:safeher-admin-secret-key-123'

    def setUp(self):
        init_db()
        self.client = app.test_client()

        # Clean prior test users
        conn = get_db()
        c = conn.cursor()
        c.execute("DELETE FROM users WHERE phone IN ('9900112201', '9900112202', '9900112203', '9900112204');")
        c.execute("DELETE FROM alerts WHERE user_id < 20000;")
        c.execute("DELETE FROM volunteers WHERE user_id < 20000;")

        # 1. Alert owner
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Aarohi Roy', '9900112201', 'aarohi@test.local', 'dummy');
        """)
        self.victim_user_id = c.lastrowid

        # 2. Provisional Volunteer
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Rahul Dravid', '9900112202', 'rahul@test.local', 'dummy');
        """)
        self.provisional_user_id = c.lastrowid

        # 3. Trusted Volunteer
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Deepa Malik', '9900112203', 'deepa@test.local', 'dummy');
        """)
        self.trusted_user_id = c.lastrowid
        conn.commit()

        # Setup Provisional Volunteer record (Approved, 12 months validity)
        c.execute("""
            INSERT INTO volunteers (user_id, available, status, level, lat, lng, full_name, valid_until, approved_at)
            VALUES (?, 1, 'approved', 'provisional', 12.9716, 77.5946, 'Rahul Dravid', datetime('now', '+1 year'), CURRENT_TIMESTAMP);
        """, (self.provisional_user_id,))
        self.provisional_vol_id = c.lastrowid

        # Setup Trusted Volunteer record
        c.execute("""
            INSERT INTO volunteers (user_id, available, status, level, lat, lng, full_name, valid_until, approved_at)
            VALUES (?, 1, 'approved', 'trusted', 12.9716, 77.5946, 'Deepa Malik', datetime('now', '+1 year'), CURRENT_TIMESTAMP);
        """, (self.trusted_user_id,))
        self.trusted_vol_id = c.lastrowid
        conn.commit()
        conn.close()

        # Auth tokens
        token_victim = jwt.encode({"user_id": self.victim_user_id}, SECRET_KEY, algorithm="HS256")
        self.victim_headers = {"Authorization": f"Bearer {token_victim}", "Content-Type": "application/json"}

        token_prov = jwt.encode({"user_id": self.provisional_user_id}, SECRET_KEY, algorithm="HS256")
        self.prov_headers = {"Authorization": f"Bearer {token_prov}", "Content-Type": "application/json"}

        token_trust = jwt.encode({"user_id": self.trusted_user_id}, SECRET_KEY, algorithm="HS256")
        self.trust_headers = {"Authorization": f"Bearer {token_trust}", "Content-Type": "application/json"}

        self.admin_headers = {"X-Admin-Key": "safeher-admin-secret-key-123", "Content-Type": "application/json"}

    def _create_alert(self, mode="normal", lat=12.9750, lng=77.5980):
        # Coordinates ~500m to 1km away from 12.9716, 77.5946
        res = self.client.post('/api/alerts', json={
            "mode": mode,
            "lat": lat,
            "lng": lng
        }, headers=self.victim_headers)
        self.assertEqual(res.status_code, 201)
        return res.get_json()['data']['id']

    def test_suspended_and_expired_volunteers_not_matched(self):
        alert_id = self._create_alert(mode="normal")

        # 1. Suspended volunteer is NOT matched
        conn = get_db()
        c = conn.cursor()
        c.execute("UPDATE volunteers SET status = 'suspended' WHERE id = ?;", (self.provisional_vol_id,))
        conn.commit()
        conn.close()

        res_susp = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        self.assertEqual(res_susp.status_code, 200)
        self.assertEqual(len(res_susp.get_json()['data']), 0)
        self.assertEqual(res_susp.get_json()['approval_status'], 'suspended')

        # 2. Expired volunteer is NOT matched
        conn = get_db()
        c = conn.cursor()
        c.execute("""
            UPDATE volunteers
            SET status = 'approved',
                valid_until = datetime('now', '-2 days')
            WHERE id = ?;
        """, (self.provisional_vol_id,))
        conn.commit()
        conn.close()

        res_exp = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        self.assertEqual(res_exp.status_code, 200)
        self.assertEqual(len(res_exp.get_json()['data']), 0)
        self.assertEqual(res_exp.get_json()['approval_status'], 'expired')

    def test_provisional_volunteer_gets_no_silent_alerts(self):
        # Create silent alert
        silent_alert_id = self._create_alert(mode="silent")

        # Provisional volunteer queries -> receives 0 alerts
        res_prov = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        self.assertEqual(res_prov.status_code, 200)
        prov_alerts = res_prov.get_json()['data']
        self.assertNotIn(silent_alert_id, [a['id'] for a in prov_alerts])

        # Trusted volunteer queries -> receives the silent alert
        res_trust = self.client.get('/api/volunteers/nearby-alerts', headers=self.trust_headers)
        self.assertEqual(res_trust.status_code, 200)
        trust_alerts = res_trust.get_json()['data']
        self.assertIn(silent_alert_id, [a['id'] for a in trust_alerts])

    def test_exact_location_hidden_until_coming(self):
        alert_lat = 12.975432
        alert_lng = 77.598765
        alert_id = self._create_alert(mode="normal", lat=alert_lat, lng=alert_lng)

        # 1. Provisional volunteer before "coming":
        res_prov = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        self.assertEqual(res_prov.status_code, 200)
        alerts = res_prov.get_json()['data']
        self.assertEqual(len(alerts), 1)
        a = alerts[0]

        # Exact coordinates hidden
        self.assertIsNone(a['lat'])
        self.assertIsNone(a['lng'])
        self.assertIsNone(a['maps_link'])

        # Approximate coordinates rounded to 0.003 degrees
        self.assertIsNotNone(a.get('approximate_lat'))
        self.assertIsNotNone(a.get('approximate_lng'))
        expected_approx_lat = round(round(alert_lat / 0.003) * 0.003, 5)
        self.assertAlmostEqual(a['approximate_lat'], expected_approx_lat, places=4)
        self.assertIn("about", a['distance_band'])

        # 2. Trusted volunteer before "coming":
        res_trust = self.client.get('/api/volunteers/nearby-alerts', headers=self.trust_headers)
        t_alert = res_trust.get_json()['data'][0]
        self.assertIsNone(t_alert['lat'])
        self.assertIsNone(t_alert['lng'])
        self.assertIsNone(t_alert.get('approximate_lat'))
        self.assertIsNotNone(t_alert.get('distance_band'))

        # 3. Volunteer taps "coming"
        res_coming = self.client.post(f'/api/alerts/{alert_id}/respond',
                                      json={"status": "coming"},
                                      headers=self.prov_headers)
        self.assertEqual(res_coming.status_code, 200)
        coming_data = res_coming.get_json()['data']

        # Verification code returned
        verification_code = coming_data.get('verification_code')
        self.assertTrue(verification_code and len(verification_code) == 4 and verification_code.isdigit())

        # Exact location returned ONLY upon responding "coming"
        exact_loc = coming_data.get('exact_location')
        self.assertIsNotNone(exact_loc)
        self.assertEqual(exact_loc['lat'], alert_lat)
        self.assertEqual(exact_loc['lng'], alert_lng)

        # Volunteer view log contains audit record
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM volunteer_view_log WHERE alert_id = ? AND volunteer_id = ?;", (alert_id, self.provisional_vol_id))
        self.assertIsNotNone(c.fetchone())

        # Incident events contains anonymous label ("Volunteer 1")
        c.execute("SELECT actor_label FROM incident_events WHERE alert_id = ? AND event_type = 'volunteer_coming';", (alert_id,))
        inc_row = c.fetchone()
        self.assertIsNotNone(inc_row)
        self.assertEqual(inc_row['actor_label'], 'Volunteer 1')
        conn.close()

        # Subsequent nearby-alerts call now returns exact location to this volunteer
        res_prov_after = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        a_after = res_prov_after.get_json()['data'][0]
        self.assertEqual(a_after['lat'], alert_lat)
        self.assertEqual(a_after['lng'], alert_lng)
        self.assertTrue(a_after['responded'])

    def test_alert_status_responders_list_and_verification_code(self):
        alert_id = self._create_alert(mode="normal")

        # Fake a selfie path for provisional volunteer
        conn = get_db()
        c = conn.cursor()
        dummy_selfie_rel = "private_uploads/selfie_dummy_test.png"
        dummy_selfie_abs = os.path.abspath(os.path.join(os.path.dirname(__file__), dummy_selfie_rel))
        os.makedirs(os.path.dirname(dummy_selfie_abs), exist_ok=True)
        with open(dummy_selfie_abs, 'wb') as f:
            f.write(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')
        c.execute("UPDATE volunteers SET selfie_path = ? WHERE id = ?;", (dummy_selfie_rel, self.provisional_vol_id))
        conn.commit()
        conn.close()

        # Volunteer responds coming
        res_coming = self.client.post(f'/api/alerts/{alert_id}/respond', json={"status": "coming"}, headers=self.prov_headers)
        volunteer_code = res_coming.get_json()['data']['verification_code']

        # Alert owner checks status
        res_status = self.client.get(f'/api/alerts/{alert_id}/status', headers=self.victim_headers)
        self.assertEqual(res_status.status_code, 200)
        data = res_status.get_json()['data']
        self.assertEqual(data['volunteers_coming'], 1)
        responders = data['responders']
        self.assertEqual(len(responders), 1)
        r = responders[0]

        # Verify responder packet fields
        self.assertEqual(r['first_name'], 'Rahul')
        self.assertEqual(r['badge'], 'Provisional')
        self.assertEqual(r['verification_code'], volunteer_code)
        self.assertIn(f"/api/alerts/{alert_id}/responder-selfie/{self.provisional_vol_id}", r['selfie_url'])

        # 4. Fetch selfie as alert owner -> 200 OK
        res_selfie = self.client.get(r['selfie_url'], headers=self.victim_headers)
        self.assertEqual(res_selfie.status_code, 200)

        # 5. Fetch selfie as another user -> 403 Forbidden
        other_token = jwt.encode({"user_id": 99999}, SECRET_KEY, algorithm="HS256")
        other_hdr = {"Authorization": f"Bearer {other_token}"}
        res_selfie_forbidden = self.client.get(r['selfie_url'], headers=other_hdr)
        self.assertEqual(res_selfie_forbidden.status_code, 403)

    def test_volunteer_feedback_and_immediate_suspension(self):
        alert_id = self._create_alert(mode="normal")
        self.client.post(f'/api/alerts/{alert_id}/respond', json={"status": "coming"}, headers=self.prov_headers)

        # 1. Alert owner submits unsafe feedback
        fb_payload = {
            "volunteer_id": self.provisional_vol_id,
            "helpful": False,
            "respectful": False,
            "report_type": "unsafe",
            "comment": "Volunteer exhibited erratic and threatening behavior near the victim."
        }
        res_fb = self.client.post(f'/api/alerts/{alert_id}/volunteer-feedback', json=fb_payload, headers=self.victim_headers)
        self.assertEqual(res_fb.status_code, 200)
        self.assertTrue(res_fb.get_json()['data']['volunteer_suspended'])

        # Volunteer status is now suspended
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT status FROM volunteers WHERE id = ?;", (self.provisional_vol_id,))
        self.assertEqual(c.fetchone()['status'], 'suspended')
        conn.close()

        # Cannot submit feedback twice
        res_dup_fb = self.client.post(f'/api/alerts/{alert_id}/volunteer-feedback', json=fb_payload, headers=self.victim_headers)
        self.assertEqual(res_dup_fb.status_code, 400)

        # 2. Admin resolves suspension
        resolve_payload = {
            "action": "resolve",
            "note": "Incident was investigated with victim and volunteer. Safety protocols refreshed."
        }
        res_res = self.client.post(f'/api/admin/volunteers/{self.provisional_vol_id}/decision',
                                   json=resolve_payload,
                                   headers=self.admin_headers)
        self.assertEqual(res_res.status_code, 200)
        self.assertEqual(res_res.get_json()['data']['status'], 'approved')

        # Volunteer status restored
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT status FROM volunteers WHERE id = ?;", (self.provisional_vol_id,))
        self.assertEqual(c.fetchone()['status'], 'approved')
        conn.close()

    def test_scheduler_promotion_and_expiration(self):
        # Setup candidate volunteer for promotion:
        # - approved > 30 days ago
        # - 3 completed responses from ended alerts
        # - helpful/respectful feedback
        conn = get_db()
        c = conn.cursor()
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Priya Sen', '9900112204', 'priya@test.local', 'dummy');
        """)
        cand_user_id = c.lastrowid
        c.execute("""
            INSERT INTO volunteers (user_id, available, status, level, approved_at, valid_until)
            VALUES (?, 1, 'approved', 'provisional', datetime('now', '-35 days'), datetime('now', '+6 months'));
        """, (cand_user_id,))
        cand_vol_id = c.lastrowid

        # Insert 3 completed responses on ended alerts
        for i in range(3):
            c.execute("""
                INSERT INTO alerts (user_id, mode, status, lat, lng, share_token)
                VALUES (?, 'normal', 'ended', 12.97, 77.59, ?);
            """, (self.victim_user_id, f"token_cand_{i}_{cand_vol_id}"))
            ended_aid = c.lastrowid
            c.execute("""
                INSERT INTO responses (alert_id, volunteer_id, status)
                VALUES (?, ?, 'coming');
            """, (ended_aid, cand_vol_id))
            c.execute("""
                INSERT INTO volunteer_feedback (alert_id, volunteer_id, user_id, helpful, respectful, report_type)
                VALUES (?, ?, ?, 1, 1, 'none');
            """, (ended_aid, cand_vol_id, self.victim_user_id))

        conn.commit()
        conn.close()

        # Run scheduler promotion
        promoted = promote_eligible_volunteers_to_trusted()
        self.assertGreaterEqual(promoted, 1)

        # Check level
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT level FROM volunteers WHERE id = ?;", (cand_vol_id,))
        self.assertEqual(c.fetchone()['level'], 'trusted')

        # Test expiration
        c.execute("UPDATE volunteers SET valid_until = datetime('now', '-5 minutes') WHERE id = ?;", (cand_vol_id,))
        conn.commit()
        conn.close()

        expired = expire_outdated_volunteer_validity()
        self.assertGreaterEqual(expired, 1)

        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT status FROM volunteers WHERE id = ?;", (cand_vol_id,))
        self.assertEqual(c.fetchone()['status'], 'expired')
        conn.close()

    def test_nearby_alert_query_rate_limit(self):
        # Rapidly query 21 times
        for i in range(20):
            res = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
            self.assertEqual(res.status_code, 200)

        # 21st query hits 429
        res_limit = self.client.get('/api/volunteers/nearby-alerts', headers=self.prov_headers)
        self.assertEqual(res_limit.status_code, 429)
        self.assertIn("rate limit exceeded", res_limit.get_json()['error'].lower())


if __name__ == '__main__':
    unittest.main()

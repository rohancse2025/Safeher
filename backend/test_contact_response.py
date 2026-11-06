# backend/test_contact_response.py – Unit and integration tests for contact tokens and responses
import sys
import os
import unittest
import json
import sqlite3

# Add backend directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app
from db import get_db, init_db


class TestContactResponses(unittest.TestCase):
    def setUp(self):
        init_db()
        self.client = app.test_client()

        # Create a test user and contact directly
        conn = get_db()
        c = conn.cursor()

        # Clean prior test user
        c.execute("DELETE FROM users WHERE phone = '9998887771';")
        conn.commit()

        # Insert user
        c.execute("""
            INSERT INTO users (name, phone, email, password_hash)
            VALUES ('Priya Sharma', '9998887771', 'priya.test@example.com', 'dummy_hash');
        """)
        self.user_id = c.lastrowid

        # Insert emergency contact
        c.execute("""
            INSERT INTO contacts (user_id, name, phone, email, relationship)
            VALUES (?, 'Ananya Sharma', '9998887772', 'ananya.test@example.com', 'Sister');
        """, (self.user_id,))
        self.contact_id = c.lastrowid

        conn.commit()
        conn.close()

    def test_alert_contact_tokens_and_responses_flow(self):
        # 1. Create an active alert for the user
        res = self.client.post('/api/alerts', json={
            "user_id": self.user_id,
            "mode": "normal",
            "lat": 12.9716,
            "lng": 77.5946
        })
        self.assertEqual(res.status_code, 201)
        data = res.get_json()['data']
        alert_id = data['id']
        share_token = data['share_token']

        # 2. Verify alert_contacts has a unique token for the contact
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT token FROM alert_contacts WHERE alert_id = ? AND contact_id = ?;", (alert_id, self.contact_id))
        row = c.fetchone()
        self.assertIsNotNone(row, "alert_contacts entry must be created")
        contact_token = row['token']
        self.assertNotEqual(contact_token, share_token)
        conn.close()

        # 3. GET /api/track/<share_token> (read-only view)
        res_share = self.client.get(f'/api/track/{share_token}')
        self.assertEqual(res_share.status_code, 200)
        track_share = res_share.get_json()['data']
        self.assertEqual(track_share['first_name'], 'Priya')
        self.assertFalse(track_share['is_contact'])
        self.assertNotIn('contact_first_name', track_share)

        # 4. GET /api/track/<contact_token> (contact view)
        res_contact = self.client.get(f'/api/track/{contact_token}')
        self.assertEqual(res_contact.status_code, 200)
        track_contact = res_contact.get_json()['data']
        self.assertEqual(track_contact['first_name'], 'Priya')
        self.assertTrue(track_contact['is_contact'])
        self.assertEqual(track_contact['contact_first_name'], 'Ananya')
        self.assertEqual(track_contact['contact_name'], 'Ananya Sharma')

        # 5. POST /api/track/<share_token>/respond must fail (only contact tokens can respond)
        res_fail_share = self.client.post(f'/api/track/{share_token}/respond', json={
            "status": "on_my_way"
        })
        self.assertEqual(res_fail_share.status_code, 403)

        # 6. POST /api/track/<contact_token>/respond with invalid status must fail (400)
        res_bad_status = self.client.post(f'/api/track/{contact_token}/respond', json={
            "status": "sleeping"
        })
        self.assertEqual(res_bad_status.status_code, 400)

        # 7. POST /api/track/<contact_token>/respond with valid status ("on_my_way")
        res_resp1 = self.client.post(f'/api/track/{contact_token}/respond', json={
            "status": "on_my_way"
        })
        self.assertEqual(res_resp1.status_code, 200)
        self.assertEqual(res_resp1.get_json()['data']['status'], 'on_my_way')
        self.assertEqual(res_resp1.get_json()['data']['contact_name'], 'Ananya Sharma')

        # 8. POST /api/track/<contact_token>/respond with another valid status ("called")
        res_resp2 = self.client.post(f'/api/track/{contact_token}/respond', json={
            "status": "called"
        })
        self.assertEqual(res_resp2.status_code, 200)

        # 9. GET /api/alerts/<id>/status returns contact_responses and volunteers_coming
        res_status = self.client.get(f'/api/alerts/{alert_id}/status')
        self.assertEqual(res_status.status_code, 200)
        status_data = res_status.get_json()['data']
        self.assertIn('volunteers_coming', status_data)
        self.assertIn('contact_responses', status_data)
        responses = status_data['contact_responses']
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0]['name'], 'Ananya Sharma')
        self.assertEqual(responses[0]['status'], 'called')
        self.assertEqual(responses[1]['name'], 'Ananya Sharma')
        self.assertEqual(responses[1]['status'], 'on_my_way')

        # 10. Rate limiting test: up to 10 responses per hour
        for i in range(8):
            r = self.client.post(f'/api/track/{contact_token}/respond', json={"status": "alerted_police"})
            self.assertEqual(r.status_code, 200)
        # 11th response should trigger 429
        res_limit = self.client.post(f'/api/track/{contact_token}/respond', json={"status": "cannot_reach"})
        self.assertEqual(res_limit.status_code, 429)

        # 11. End alert directly in DB, then response returns 400 (inactive)
        conn = get_db()
        c = conn.cursor()
        c.execute("UPDATE alerts SET status = 'resolved' WHERE id = ?;", (alert_id,))
        conn.commit()
        conn.close()

        res_ended = self.client.post(f'/api/track/{contact_token}/respond', json={"status": "called"})
        self.assertEqual(res_ended.status_code, 400)
        self.assertIn("no longer active", res_ended.get_json()['error'])


if __name__ == '__main__':
    unittest.main()

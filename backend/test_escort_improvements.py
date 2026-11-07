# backend/test_escort_improvements.py – Tests for Escort Mode Improvements
# 1. Ask-to-check-in (POST /api/track/<token>/ping-checkin, rate limiting, timeout escalation, event logging without personal data)
# 2. Night defaults (8 PM to 6 AM IST: 5 min checkin, 150 m deviation)
# 3. Journey summary (GET /api/escorts/<id>/summary, summary in end response, POST /api/escorts/<id>/notify-arrived)

import os
import sys
import unittest
import json
import jwt
import datetime
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app import app
from db import get_db, init_db
from routes.auth import SECRET_KEY
from routes.escorts import check_active_escorts


class EscortImprovementsTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.client = app.test_client()
        self.conn = get_db()
        self.cursor = self.conn.cursor()

        # Create test owner user
        self.cursor.execute("DELETE FROM users WHERE id = 88888;")
        self.cursor.execute("""
            INSERT INTO users (id, name, phone, email, password_hash)
            VALUES (88888, 'Aaradhya Sen', '9876543210', 'aaradhya@test.com', 'testpw');
        """)

        # Create test contacts
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 88888;")
        self.cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, close)
            VALUES (8801, 88888, 'Rhea Sen', '9876543211', 'rhea@test.com', 1);
        """)
        self.cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, close)
            VALUES (8802, 88888, 'Meera Kapoor', '9876543212', 'meera@test.com', 1);
        """)

        self.conn.commit()

        # Generate owner auth headers via jwt
        self.token = jwt.encode(
            {"user_id": 88888, "phone": "9876543210", "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)},
            SECRET_KEY,
            algorithm="HS256"
        )
        self.auth_headers = {'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'}

    def tearDown(self):
        self.cursor.execute("DELETE FROM escort_checkin_pings WHERE escort_id IN (SELECT id FROM escorts WHERE user_id = 88888);")
        self.cursor.execute("DELETE FROM escort_contacts WHERE escort_id IN (SELECT id FROM escorts WHERE user_id = 88888);")
        self.cursor.execute("DELETE FROM incident_events WHERE user_id = 88888;")
        self.cursor.execute("DELETE FROM alerts WHERE user_id = 88888;")
        self.cursor.execute("DELETE FROM escorts WHERE user_id = 88888;")
        self.cursor.execute("DELETE FROM contacts WHERE user_id = 88888;")
        self.cursor.execute("DELETE FROM users WHERE id = 88888;")
        self.conn.commit()
        self.conn.close()

    def test_01_ask_to_checkin_ping_and_rate_limit(self):
        """
        Verify POST /api/track/<token>/ping-checkin marks check-in request,
        enforces 3 requests/hour limit, and logs event without personal details.
        """
        with patch('routes.escorts.send_email', return_value=(True, None)), \
             patch('routes.push.notify_escort_checkin_requested') as mock_push:

            res = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'MG Road Station',
                'dest_lat': 12.9750,
                'dest_lng': 77.6050,
                'route': [[12.9716, 77.5946], [12.9750, 77.6050]],
                'expected_minutes': 25,
                'contact_ids': [8801, 8802]
            })
            self.assertEqual(res.status_code, 201)
            escort_id = res.get_json()['data']['id']
            tokens = res.get_json()['data']['tokens']
            rhea_token = tokens.get('8801') or tokens.get(8801)
            self.assertIsNotNone(rhea_token)

            # 1. First ping from Rhea
            ping1 = self.client.post(f'/api/track/{rhea_token}/ping-checkin')
            self.assertEqual(ping1.status_code, 200)
            p1_data = ping1.get_json()
            self.assertTrue(p1_data['ok'])
            self.assertEqual(p1_data['data']['contact_first_name'], 'Rhea')
            mock_push.assert_called_once_with(88888, escort_id, 'Rhea')

        # Check escort state in DB
        self.cursor.execute("SELECT checkin_requested_at, checkin_requested_by FROM escorts WHERE id = ?;", (escort_id,))
        row = self.cursor.fetchone()
        self.assertIsNotNone(row['checkin_requested_at'])
        self.assertEqual(row['checkin_requested_by'], 'Rhea')

        # Check incident event: "log nothing personal"
        self.cursor.execute("""
            SELECT type, actor, detail_json FROM incident_events
            WHERE user_id = 88888 AND type = 'checkin_requested';
        """)
        evt = self.cursor.fetchone()
        self.assertIsNotNone(evt)
        self.assertEqual(evt['actor'], 'contact')
        details = json.loads(evt['detail_json'])
        self.assertNotIn('9876543211', str(details))
        self.assertNotIn('rhea@test.com', str(details))

        # 2. Second ping
        ping2 = self.client.post(f'/api/track/{rhea_token}/ping-checkin')
        self.assertEqual(ping2.status_code, 200)

        # 3. Third ping
        ping3 = self.client.post(f'/api/track/{rhea_token}/ping-checkin')
        self.assertEqual(ping3.status_code, 200)

        # 4. Fourth ping -> must exceed rate limit (limit 3 per hour)
        ping4 = self.client.post(f'/api/track/{rhea_token}/ping-checkin')
        self.assertEqual(ping4.status_code, 429)
        self.assertIn("Rate limit", ping4.get_json()['error'])

        # Invalid token check
        bad_ping = self.client.post('/api/track/invalid_token_xyz/ping-checkin')
        self.assertEqual(bad_ping.status_code, 403)

    def test_02_checkin_clears_pending_ping(self):
        """
        Verify owner check-in (POST /api/escorts/<id>/checkin) clears checkin_requested_at.
        """
        with patch('routes.escorts.send_email', return_value=(True, None)), \
             patch('routes.push.notify_escort_checkin_requested'):

            res = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'Brigade Road',
                'dest_lat': 12.9730,
                'dest_lng': 77.6080,
                'route': [[12.9716, 77.5946], [12.9730, 77.6080]],
                'checkin_interval': 10,
                'contact_ids': [8801]
            })
            escort_id = res.get_json()['data']['id']
            token = res.get_json()['data']['tokens'][str(8801)]

            # Contact pings
            self.client.post(f'/api/track/{token}/ping-checkin')

            self.cursor.execute("SELECT checkin_requested_at FROM escorts WHERE id = ?;", (escort_id,))
            self.assertIsNotNone(self.cursor.fetchone()['checkin_requested_at'])

            # Owner checks in
            chk_res = self.client.post(f'/api/escorts/{escort_id}/checkin', headers=self.auth_headers)
            self.assertEqual(chk_res.status_code, 200)

            # DB must have cleared request
            self.cursor.execute("SELECT checkin_requested_at, checkin_requested_by FROM escorts WHERE id = ?;", (escort_id,))
            row = self.cursor.fetchone()
            self.assertIsNone(row['checkin_requested_at'])
            self.assertIsNone(row['checkin_requested_by'])

    def test_03_ping_checkin_timeout_raises_missed_checkin_alert(self):
        """
        Verify background monitor raises missed_checkin alert if contact ping
        is not answered within 60 seconds.
        """
        with patch('routes.escorts.send_email', return_value=(True, None)), \
             patch('routes.alerts.send_alert_notifications_background'), \
             patch('routes.alerts.send_whatsapp_notifications_background'), \
             patch('routes.push.dispatch_push_to_users'):

            res = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'Commercial Street',
                'dest_lat': 12.9820,
                'dest_lng': 77.6110,
                'route': [[12.9716, 77.5946], [12.9820, 77.6110]],
                'contact_ids': [8801]
            })
            escort_id = res.get_json()['data']['id']

            # Set checkin_requested_at to 70 seconds ago
            past_str = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=70)).strftime("%Y-%m-%d %H:%M:%S")
            self.cursor.execute("""
                UPDATE escorts
                SET checkin_requested_at = ?,
                    checkin_requested_by = 'Rhea'
                WHERE id = ?;
            """, (past_str, escort_id))
            self.conn.commit()

            # Run monitor check
            check_active_escorts()

            # Escort should now be alerted with missed_checkin
            self.cursor.execute("SELECT status, alert_id, checkin_requested_at FROM escorts WHERE id = ?;", (escort_id,))
            esc = self.cursor.fetchone()
            self.assertEqual(esc['status'], 'alerted')
            self.assertIsNotNone(esc['alert_id'])
            self.assertIsNone(esc['checkin_requested_at'])

            self.cursor.execute("SELECT reason, mode FROM alerts WHERE id = ?;", (esc['alert_id'],))
            alt = self.cursor.fetchone()
            self.assertEqual(alt['reason'], 'missed_checkin')
            self.assertEqual(alt['mode'], 'emergency')

    def test_04_night_mode_defaults_and_override(self):
        """
        Verify between 8 PM and 6 AM IST, default checkin is 5 min and deviation is 150 m.
        Verify user can still override them.
        """
        with patch('routes.escorts.send_email', return_value=(True, None)), \
             patch('routes.escorts.datetime') as mock_esc_dt:

            # 22:30 IST is 17:00 UTC
            night_now = datetime.datetime(2026, 11, 7, 17, 0, 0, tzinfo=datetime.timezone.utc)
            mock_esc_dt.datetime.now.return_value = night_now
            mock_esc_dt.datetime.fromisoformat = datetime.datetime.fromisoformat
            mock_esc_dt.datetime.strptime = datetime.datetime.strptime
            mock_esc_dt.timezone = datetime.timezone
            mock_esc_dt.timedelta = datetime.timedelta

            res = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'Night Journey Destination',
                'dest_lat': 12.9716,
                'dest_lng': 77.5946,
                'route': [[12.9716, 77.5946], [12.9750, 77.6000]],
                'contact_ids': [8801]
            })
            self.assertEqual(res.status_code, 201)
            data = res.get_json()['data']
            self.assertEqual(data['checkin_interval_min'], 5)
            self.assertEqual(data['deviation_m'], 150.0)

            # Test night time with user override (15 min checkin, 300 m deviation)
            res_override = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'Night Journey With Override',
                'dest_lat': 12.9716,
                'dest_lng': 77.5946,
                'route': [[12.9716, 77.5946], [12.9750, 77.6000]],
                'checkin_interval': 15,
                'deviation_distance': 300,
                'contact_ids': [8801]
            })
            self.assertEqual(res_override.status_code, 201)
            data_override = res_override.get_json()['data']
            self.assertEqual(data_override['checkin_interval_min'], 15)
            self.assertEqual(data_override['deviation_m'], 300.0)

    def test_05_journey_summary_and_notify_arrived(self):
        """
        Verify POST /api/escorts/<id>/end returns summary packet,
        GET /api/escorts/<id>/summary returns statistics,
        and POST /api/escorts/<id>/notify-arrived notifies contacts.
        """
        with patch('routes.escorts.send_email', return_value=(True, None)) as mock_email:
            # Start journey
            res = self.client.post('/api/escorts', headers=self.auth_headers, json={
                'destination': 'Phoenix Marketcity',
                'dest_lat': 12.9950,
                'dest_lng': 77.6950,
                'route': [[12.9716, 77.5946], [12.9950, 77.6950]],
                'checkin_interval': 10,
                'contact_ids': [8801, 8802]
            })
            self.assertEqual(res.status_code, 201)
            escort_id = res.get_json()['data']['id']

            # Simulate 2 check-ins
            self.client.post(f'/api/escorts/{escort_id}/checkin', headers=self.auth_headers)
            self.client.post(f'/api/escorts/{escort_id}/checkin', headers=self.auth_headers)

            # End journey (arrived: True)
            end_res = self.client.post(f'/api/escorts/{escort_id}/end', headers=self.auth_headers, json={'arrived': True})
            self.assertEqual(end_res.status_code, 200)
            end_data = end_res.get_json()['data']
            self.assertIn('summary', end_data)
            summary = end_data['summary']
            self.assertEqual(summary['dest_name'], 'Phoenix Marketcity')
            self.assertEqual(summary['checkins_done'], 2)
            self.assertEqual(summary['checkins_missed'], 0)
            self.assertFalse(summary['alert_happened'])
            self.assertTrue(summary['arrived'])

            # GET /api/escorts/<id>/summary
            sum_res = self.client.get(f'/api/escorts/{escort_id}/summary', headers=self.auth_headers)
            self.assertEqual(sum_res.status_code, 200)
            s_data = sum_res.get_json()['data']
            self.assertEqual(s_data['dest_name'], 'Phoenix Marketcity')
            self.assertEqual(s_data['checkins_done'], 2)
            self.assertEqual(s_data['checkins_missed'], 0)

            # POST /api/escorts/<id>/notify-arrived
            notify_res = self.client.post(f'/api/escorts/{escort_id}/notify-arrived', headers=self.auth_headers)
            self.assertEqual(notify_res.status_code, 200)
            self.assertTrue(notify_res.get_json()['ok'])
            self.assertEqual(notify_res.get_json()['data']['sent_count'], 2)
            self.assertGreaterEqual(mock_email.call_count, 2)


if __name__ == '__main__':
    unittest.main()

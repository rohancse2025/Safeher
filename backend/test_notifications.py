# backend/test_notifications.py – Comprehensive unit & integration tests for notification engine
import os
import sys

# Set isolated test database and test environment before importing backend modules
os.environ['TESTING'] = 'true'
os.environ['DATABASE_PATH'] = 'test_safeher.db'
os.environ['BREVO_API_KEY'] = 'xkeysib-mock-key-12345'
os.environ['BREVO_WEBHOOK_SECRET'] = 'test_webhook_secret_999'

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

import unittest
from unittest.mock import patch, MagicMock
import json
import sqlite3
import datetime
import urllib.error
import jwt

from db import get_db, init_db, DB_PATH
from app import app
from services.notify import notify, process_outbox, mask_email
from services.templates import render_template, format_ist_time


class NotificationSystemTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    @classmethod
    def tearDownClass(cls):
        try:
            if os.path.exists(DB_PATH):
                os.remove(DB_PATH)
        except Exception:
            pass

    def setUp(self):
        app.config['TESTING'] = True
        app.config['SECRET_KEY'] = 'test-secret-key-123456789012345678901234'
        self.client = app.test_client()

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM notifications;")
        cursor.execute("DELETE FROM notification_settings;")
        cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
        cursor.execute("DELETE FROM users WHERE id = 99999;")
        
        # Create test user
        cursor.execute("""
            INSERT INTO users (id, name, phone, password_hash)
            VALUES (99999, 'Priya Sharma', '919876543210', 'dummy_hash');
        """)

        # Create test contacts:
        # 1: Normal with valid email
        # 2: Opted-out contact
        # 3: Contact without email
        # 4: Contact with bounced email
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99001, 99999, 'Rohit Sharma', '919876543211', 'rohit@example.com', 0, 'ok', 'tok_rohit_123');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99002, 99999, 'Anita Sharma', '919876543212', 'anita@example.com', 1, 'ok', 'tok_anita_456');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99003, 99999, 'Sunil Sharma', '919876543213', NULL, 0, 'unknown', 'tok_sunil_789');
        """)
        cursor.execute("""
            INSERT INTO contacts (id, user_id, name, phone, email, opted_out, email_status, optout_token)
            VALUES (99004, 99999, 'Bounced Contact', '919876543214', 'bounced@example.com', 0, 'bounced', 'tok_bounce_000');
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("DELETE FROM notifications WHERE user_id = 99999;")
            cursor.execute("DELETE FROM notification_settings WHERE user_id = 99999;")
            cursor.execute("DELETE FROM contacts WHERE user_id = 99999;")
            cursor.execute("DELETE FROM users WHERE id = 99999;")
            conn.commit()
            conn.close()
        except Exception:
            pass

    # ─── 1. Template Rendering & Privacy ─────────────────────
    def test_templates_and_masking(self):
        """Verify calm subject, IST time, 112 notice, and email masking."""
        subject, text_body, html_body = render_template('sos', {
            'user_name': 'Priya',
            'time_str': '9:42 PM IST, 9 Nov 2026',
            'lat': 12.9716,
            'lng': 77.5946,
            'track_url': 'https://safeher.org/track.html?t=abc123xyz'
        })

        self.assertIn('SafeHer: Priya needs help', subject)
        self.assertNotIn('URGENT', subject)
        self.assertNotIn('HELP ME', subject)
        self.assertIn('call 112', text_body.lower())
        self.assertIn('112', html_body)
        self.assertIn('google.com/maps', text_body)

        # Masking verification
        self.assertEqual(mask_email('rohit.sharma@example.com'), 'r***a@example.com')
        self.assertEqual(mask_email('ab@test.com'), 'a***@test.com')
        self.assertEqual(mask_email(None), 'N/A')

    # ─── 2. Idempotency Test ─────────────────────────────────
    @patch('services.notify.process_outbox')
    def test_idempotent_event_key(self, mock_outbox):
        """Verify the exact same event_key never creates duplicate queued rows for the same contact."""
        created1 = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya', 'lat': 12.9716, 'lng': 77.5946},
            contact_ids=[99001],
            event_key='test_sos_unique_001'
        )
        self.assertEqual(len(created1), 1)

        # Second notify with identical event_key
        created2 = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya', 'lat': 12.9716, 'lng': 77.5946},
            contact_ids=[99001],
            event_key='test_sos_unique_001'
        )
        self.assertEqual(len(created2), 0)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS count FROM notifications WHERE event_key = 'test_sos_unique_001';")
        count = cursor.fetchone()['count']
        conn.close()
        self.assertEqual(count, 1)

    # ─── 3. Skipped Contacts Handling ────────────────────────
    @patch('services.notify.process_outbox')
    def test_skipped_reasons_visible(self, mock_outbox):
        """Opted-out, no email, and bounced contacts must be recorded as 'skipped' with visible reason."""
        created = notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001, 99002, 99003, 99004],
            event_key='test_sos_skipped_check'
        )

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT contact_id, status, last_error FROM notifications WHERE event_key = 'test_sos_skipped_check';")
        rows = {r['contact_id']: dict(r) for r in cursor.fetchall()}
        conn.close()

        # Normal contact should be queued
        self.assertEqual(rows[99001]['status'], 'queued')

        # Opted-out contact should be skipped with visible reason
        self.assertEqual(rows[99002]['status'], 'skipped')
        self.assertIn('Opted out', rows[99002]['last_error'])

        # No email contact should be skipped with visible reason
        self.assertEqual(rows[99003]['status'], 'skipped')
        self.assertIn('No email address', rows[99003]['last_error'])

        # Bounced contact should be skipped
        self.assertEqual(rows[99004]['status'], 'skipped')
        self.assertIn('bounced', rows[99004]['last_error'])

    # ─── 4. Outbox Sending & Retries ─────────────────────────
    @patch('services.notify._trigger_outbox_background')
    @patch('urllib.request.urlopen')
    def test_process_outbox_success(self, mock_urlopen, mock_bg):
        """Verify successful Brevo dispatch records provider_message_id and sets sent status."""
        mock_response = MagicMock()
        mock_response.getcode.return_value = 201
        mock_response.read.return_value = json.dumps({"messageId": "<brevo-test-msg-12345@smtp-relay.mailin.fr>"}).encode('utf-8')
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001],
            event_key='test_sos_send_success'
        )

        sent_count = process_outbox(limit=10)
        self.assertGreaterEqual(sent_count, 1)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, attempts, provider_message_id FROM notifications WHERE event_key = 'test_sos_send_success';")
        row = cursor.fetchone()
        conn.close()

        self.assertEqual(row['status'], 'sent')
        self.assertEqual(row['attempts'], 1)
        self.assertIn('brevo-test-msg-12345', row['provider_message_id'])

    @patch('services.notify._trigger_outbox_background')
    @patch('urllib.request.urlopen')
    def test_process_outbox_failure_and_retry(self, mock_urlopen, mock_bg):
        """Verify failed HTTP dispatch increments attempts, records last_error, and schedules next_attempt_at."""
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url='https://api.brevo.com/v3/smtp/email',
            code=500,
            msg='Internal Server Error',
            hdrs={},
            fp=MagicMock(read=lambda: b'{"message": "Brevo internal server error"}')
        )

        notify(
            event_type='sos',
            user_id=99999,
            context={'user_name': 'Priya'},
            contact_ids=[99001],
            event_key='test_sos_send_fail'
        )

        process_outbox(limit=10)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, attempts, last_error, next_attempt_at FROM notifications WHERE event_key = 'test_sos_send_fail';")
        row = cursor.fetchone()
        conn.close()

        self.assertEqual(row['status'], 'queued')
        self.assertEqual(row['attempts'], 1)
        self.assertIn('Brevo internal server error', row['last_error'])
        self.assertIsNotNone(row['next_attempt_at'])

    # ─── 5. Brevo Webhook Handling ───────────────────────────
    def test_brevo_webhook_hard_bounce(self):
        """Brevo hard_bounce event must update notification status to bounced and contact email_status to bounced."""
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO notifications (user_id, event_type, event_key, contact_id, channel, recipient_masked, recipient_email, subject, body_text, body_html, status, provider_message_id)
            VALUES (99999, 'sos', 'test_key_wb', 99001, 'email', 'r***t@example.com', 'rohit@example.com', 'Subject', 'Text', '<p>Html</p>', 'sent', '<msg-bounce-test-999@relay>');
        """)
        conn.commit()
        conn.close()

        secret = os.getenv('BREVO_WEBHOOK_SECRET', 'test_webhook_secret_999')
        payload = {
            "event": "hard_bounce",
            "email": "rohit@example.com",
            "message-id": "<msg-bounce-test-999@relay>",
            "reason": "Mailbox does not exist"
        }

        resp = self.client.post(
            f'/api/brevo/webhook/{secret}',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 200)

        # Check DB state
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status, last_error FROM notifications WHERE event_key = 'test_key_wb';")
        notif_row = cursor.fetchone()
        self.assertEqual(notif_row['status'], 'bounced')
        self.assertIn('Mailbox does not exist', notif_row['last_error'])

        cursor.execute("SELECT email_status FROM contacts WHERE id = 99001;")
        contact_row = cursor.fetchone()
        self.assertEqual(contact_row['email_status'], 'bounced')
        conn.close()

    # ─── 6. Notification Settings (SOS Cannot Be Disabled) ───
    def test_notification_settings_sos_locked(self):
        """Notification settings must not allow disabling SOS events."""
        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        # Attempt to disable SOS and timer
        resp = self.client.put(
            '/api/notification-settings',
            headers=headers,
            data=json.dumps({
                'settings': {
                    'sos': False,
                    'timer_start': False
                }
            }),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 200)

        # Verify persisted settings via GET
        get_resp = self.client.get('/api/notification-settings', headers=headers)
        self.assertEqual(get_resp.status_code, 200)
        settings = get_resp.get_json()['data']['settings']
        self.assertTrue(settings['sos'], "SOS event must remain enabled despite client request")
        self.assertFalse(settings['timer_start'], "Non-SOS event should be allowed to disable")

    # ─── 7. Opt-Out Endpoint ─────────────────────────────────
    def test_optout_endpoint(self):
        """GET /api/optout/<token> must mark contact as opted_out=1 and return HTML."""
        resp = self.client.get('/api/optout/tok_rohit_123')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Opt-Out Confirmed', resp.data)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT opted_out FROM contacts WHERE id = 99001;")
        row = cursor.fetchone()
        conn.close()
        self.assertEqual(row['opted_out'], 1)

    # ─── 8. Contact Coverage Endpoint ────────────────────────
    def test_contacts_coverage_endpoint(self):
        """GET /api/contacts/coverage returns coverage metrics and warnings."""
        token = jwt.encode({'user_id': 99999, 'phone': '919876543210'}, app.config['SECRET_KEY'], algorithm='HS256')
        headers = {'Authorization': f'Bearer {token}'}

        resp = self.client.get('/api/contacts/coverage', headers=headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()['data']

        self.assertEqual(data['total_contacts'], 4)
        self.assertEqual(data['with_email'], 3)
        self.assertEqual(data['opted_out'], 1)
        self.assertEqual(data['bounced'], 1)
        self.assertEqual(data['active_email_contacts'], 1)


if __name__ == '__main__':
    unittest.main()

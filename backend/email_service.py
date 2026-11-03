# backend/email_service.py – Email notifications via Gmail SMTP with background threading
import os
import smtplib
import threading
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

from db import get_db
from logger import app_logger, mask_email

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()


def send_email(to_email, subject, body_text):
    """
    Send an email using Gmail SMTP (smtp.gmail.com:587 with STARTTLS).
    Returns (True, None) on success, or (False, error_message) on failure.
    """
    smtp_user = os.getenv('EMAIL_ADDRESS', '').strip()
    smtp_pass = os.getenv('EMAIL_APP_PASSWORD', '').strip()

    if not smtp_user or not smtp_pass:
        return False, "EMAIL_ADDRESS or EMAIL_APP_PASSWORD is not configured in .env"

    try:
        msg = MIMEMultipart()
        msg['From'] = smtp_user
        msg['To'] = to_email
        msg['Subject'] = subject
        msg.attach(MIMEText(body_text, 'plain', 'utf-8'))

        with smtplib.SMTP('smtp.gmail.com', 587, timeout=15) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)

        return True, None
    except Exception as e:
        err_msg = str(e)
        print(f"[EmailService Error] Failed to send email to {to_email}: {err_msg}")
        return False, err_msg


def send_alert_notifications_background(alert_id, user_name, mode, started_at_str, lat, lng, share_token, recipient_emails):
    """
    Send emergency alert emails to contacts in a background thread so the HTTP API responds immediately.
    Logs failures without crashing and updates notified_count in SQLite.
    """
    if not recipient_emails:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={share_token}"
        maps_link = f"https://www.google.com/maps?q={lat},{lng}"

        subject = f"EMERGENCY: {user_name} has triggered an SOS"
        body = (
            f"{user_name} has triggered an SOS alert on SafeHer.\n\n"
            f"Alert Mode: {mode.upper()}\n"
            f"Time: {started_at_str}\n"
            f"Google Maps Location: {maps_link}\n"
            f"Live Tracking Link: {track_link}\n\n"
            f"Please check on {user_name} immediately or contact emergency services (112)."
        )

        sent_count = 0
        for email in recipient_emails:
            masked_to = mask_email(email)
            success, err_msg = send_email(email, subject, body)
            if success:
                sent_count += 1
                app_logger.info(f"[EMAIL SENT] alert_id={alert_id}, to={masked_to}")
            else:
                app_logger.error(f"[EMAIL FAILED] alert_id={alert_id}, to={masked_to}, error={err_msg}")

        # Update notified_count in database in this thread's own connection
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute('UPDATE alerts SET notified_count = ? WHERE id = ?;', (sent_count, alert_id))
            conn.commit()
            conn.close()
        except Exception as db_err:
            print(f"[EmailService DB Error] Could not update notified_count for alert {alert_id}: {db_err}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

# backend/whatsapp_service.py – Automated WhatsApp dispatch via Twilio / Meta Cloud API with background threading
import os
import re
import threading
import requests
from dotenv import load_dotenv

from logger import app_logger

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))
load_dotenv()


def normalize_phone_number(phone_str):
    """
    Normalize a phone number to standard E.164 format (+91XXXXXXXXXX).
    Defaults to Indian country code (+91) if 10 digits are provided without a code.
    """
    if not phone_str:
        return ''
    cleaned = re.sub(r'[^\d+]', '', str(phone_str).strip())
    if not cleaned:
        return ''
    if cleaned.startswith('+'):
        return cleaned
    if len(cleaned) == 10:
        return f"+91{cleaned}"
    if len(cleaned) == 12 and cleaned.startswith('91'):
        return f"+{cleaned}"
    return f"+{cleaned}"


def mask_phone(phone_str):
    """Mask middle digits of a phone number for privacy logging."""
    p = str(phone_str)
    if len(p) <= 5:
        return '***'
    return p[:3] + '****' + p[-3:]


def send_whatsapp(to_phone, message_text):
    """
    Send an automated WhatsApp message to a recipient.
    Supports:
      1. Twilio WhatsApp REST API (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER)
      2. Meta WhatsApp Cloud API (WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID)
      3. CallMeBot Free API (CALLMEBOT_API_KEY)
      4. Safe fallback simulation when API keys are not yet configured.

    Returns (True, None) on success or simulated success, or (False, error_message) on failure.
    """
    normalized = normalize_phone_number(to_phone)
    if not normalized:
        return False, "Invalid phone number"

    # ─── Option 1: Green-API (WhatsApp QR Linked Devices) ───────
    green_id = (os.getenv('GREEN_API_ID_INSTANCE') or os.getenv('idInstance') or '710722792283').strip()
    green_token = (os.getenv('GREEN_API_TOKEN_INSTANCE') or os.getenv('apiTokenInstance') or '91404fbc7c814f549f0cd6b1cc741a9a6d841e05734f4aaeb7').strip()
    green_host = (os.getenv('GREEN_API_HOST_URL') or os.getenv('hostUrl') or '').strip().rstrip('/')
    if not green_host and green_id:
        cluster = green_id[:4]
        green_host = f"https://{cluster}.api.greenapi.com"

    if green_id and green_token:
        try:
            clean_digits = re.sub(r'\D', '', normalized)
            if len(clean_digits) == 10:
                clean_digits = '91' + clean_digits

            # Send WhatsApp message directly via Green API (100% automated background delivery)
            chat_id = f"{clean_digits}@c.us"
            url = f"{green_host}/waInstance{green_id}/sendMessage/{green_token}"
            payload = {
                'chatId': chat_id,
                'message': message_text
            }
            resp = requests.post(url, json=payload, timeout=15)
            if resp.status_code in (200, 201):
                app_logger.info(f"[GREEN-API WHATSAPP DELIVERED] to={mask_phone(normalized)}")
                return True, None
            app_logger.warning(f"[GREEN-API WHATSAPP FAILED] to={mask_phone(normalized)} code={resp.status_code}: {resp.text}")
        except Exception as e:
            app_logger.warning(f"[GREEN-API EXCEPTION] to={mask_phone(normalized)}: {e}")

    # ─── Option 2: Twilio WhatsApp REST API ───────────────────
    twilio_sid = os.getenv('TWILIO_ACCOUNT_SID', '').strip()
    twilio_token = os.getenv('TWILIO_AUTH_TOKEN', '').strip()
    twilio_from = os.getenv('TWILIO_WHATSAPP_NUMBER', 'whatsapp:+14155238886').strip()

    if twilio_sid and twilio_token:
        try:
            url = f"https://api.twilio.com/2010-04-01/Accounts/{twilio_sid}/Messages.json"
            from_param = twilio_from if twilio_from.startswith('whatsapp:') else f"whatsapp:{twilio_from}"
            to_param = f"whatsapp:{normalized}"
            payload = {
                'From': from_param,
                'To': to_param,
                'Body': message_text
            }
            resp = requests.post(url, data=payload, auth=(twilio_sid, twilio_token), timeout=15)
            if resp.status_code in (200, 201):
                return True, None
            return False, f"Twilio WhatsApp error {resp.status_code}: {resp.text}"
        except Exception as e:
            return False, f"Twilio request exception: {str(e)}"

    # ─── Option 2: Meta WhatsApp Cloud API ─────────────────────
    meta_token = os.getenv('WHATSAPP_API_TOKEN', '').strip()
    meta_phone_id = os.getenv('WHATSAPP_PHONE_NUMBER_ID', '').strip()

    if meta_token and meta_phone_id:
        try:
            url = f"https://graph.facebook.com/v19.0/{meta_phone_id}/messages"
            headers = {
                'Authorization': f"Bearer {meta_token}",
                'Content-Type': 'application/json'
            }
            payload = {
                "messaging_product": "whatsapp",
                "to": normalized.lstrip('+'),
                "type": "text",
                "text": {"body": message_text}
            }
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code in (200, 201):
                return True, None
            return False, f"Meta WhatsApp error {resp.status_code}: {resp.text}"
        except Exception as e:
            return False, f"Meta WhatsApp exception: {str(e)}"

    # ─── Option 3: CallMeBot Free API ──────────────────────────
    callmebot_key = os.getenv('CALLMEBOT_API_KEY', '').strip()
    if callmebot_key:
        try:
            url = f"https://api.callmebot.com/whatsapp.php"
            params = {
                'phone': normalized.lstrip('+'),
                'text': message_text,
                'apikey': callmebot_key
            }
            resp = requests.get(url, params=params, timeout=15)
            if resp.status_code == 200:
                return True, None
            return False, f"CallMeBot error {resp.status_code}: {resp.text}"
        except Exception as e:
            return False, f"CallMeBot exception: {str(e)}"

    # ─── Option 4: Simulation & Logging ────────────────────────
    # When external credentials are not set, log the simulated dispatch cleanly without crashing
    app_logger.info(
        f"[WHATSAPP DISPATCH SIMULATED] to={mask_phone(normalized)}, "
        f"body_preview={message_text[:60]}... "
        f"(Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in backend/.env for live delivery)"
    )
    return True, "simulated"


def send_whatsapp_notifications_background(alert_id, user_name, mode, started_at_str, lat, lng, share_token, recipient_phones, contact_tokens=None):
    """
    Send emergency WhatsApp messages to contacts in a background thread so the HTTP API responds instantly.
    """
    if not recipient_phones:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_link = f"{frontend_url}/track.html?t={share_token}"
        maps_link = f"https://www.google.com/maps?q={lat},{lng}"

        for phone in recipient_phones:
            tok = share_token
            if contact_tokens and isinstance(contact_tokens, dict):
                tok = contact_tokens.get(phone) or share_token
            per_track_link = f"{frontend_url}/track.html?t={tok}"

            per_message = (
                f"🚨 *EMERGENCY SOS ALERT - SafeHer* 🚨\n\n"
                f"*{user_name}* has triggered an urgent SOS alert!\n\n"
                f"⚠️ *Mode*: {mode.upper()}\n"
                f"🕒 *Time*: {started_at_str}\n"
                f"📍 *Google Maps Location*:\n{maps_link}\n\n"
                f"🔴 *Live Tracking Map*:\n{per_track_link}\n\n"
                f"⚡ *Quick 1-Tap Response (No app needed):*\n"
                f"🏃 On my way: {per_track_link}&action=on_my_way\n"
                f"📞 Called her: {per_track_link}&action=called\n"
                f"🚓 Alerted Police: {per_track_link}&action=police_alerted\n"
                f"✅ Safe with me: {per_track_link}&action=safe_with_me\n\n"
                f"Please contact {user_name} immediately or call Police (112)."
            )
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, per_message)
            if success:
                app_logger.info(f"[WHATSAPP SENT] alert_id={alert_id}, to={masked}, status={err_msg or 'delivered'}")
            else:
                app_logger.error(f"[WHATSAPP FAILED] alert_id={alert_id}, to={masked}, error={err_msg}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


def send_safe_update_whatsapp_notifications_background(alert_id, user_name, safe_time_str, recipient_phones):
    """
    Send WhatsApp message confirming the user has cancelled the alert and is safe.
    """
    if not recipient_phones:
        return

    def worker():
        message = (
            f"✅ *SAFE UPDATE - SafeHer* ✅\n\n"
            f"*{user_name}* has cancelled the emergency SOS alert and confirmed she is *SAFE*.\n\n"
            f"🕒 *Time*: {safe_time_str}\n"
            f"🛡️ *Status*: Safe & Resolved\n\n"
            f"Thank you for watching out for her safety! Everything is under control."
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[SAFE WHATSAPP SENT] alert_id={alert_id}, to={masked}")
            else:
                app_logger.error(f"[SAFE WHATSAPP FAILED] alert_id={alert_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_escort_whatsapp_notifications_background(escort_id, user_name, dest_name, expected_end_str, recipient_phones, tokens_map=None):
    """
    Send WhatsApp notification to emergency contacts when user starts an Escort Mode journey.
    """
    if not recipient_phones:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        for phone in recipient_phones:
            tok = ''
            if tokens_map and isinstance(tokens_map, dict):
                tok = tokens_map.get(phone) or ''
            track_url = f"{frontend_url}/track.html?t={tok}" if tok else f"{frontend_url}/track.html"
            message = (
                f"🚶‍♀️ *SafeHer Escort Mode Started* 🚶‍♀️\n\n"
                f"*{user_name}* has started an escorted journey to *{dest_name}*.\n\n"
                f"🕒 *Expected Arrival*: {expected_end_str}\n"
                f"🔴 *Live Journey Tracking*:\n{track_url}\n\n"
                f"SafeHer is actively monitoring her route and check-ins."
            )
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[ESCORT WHATSAPP SENT] escort_id={escort_id}, to={masked}")
            else:
                app_logger.error(f"[ESCORT WHATSAPP FAILED] escort_id={escort_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_escort_arrived_whatsapp_notifications_background(escort_id, user_name, dest_name, recipient_phones):
    """
    Send WhatsApp notification to emergency contacts when user safely arrives at their destination.
    """
    if not recipient_phones:
        return

    def worker():
        message = (
            f"✅ *JOURNEY COMPLETED - SafeHer* ✅\n\n"
            f"*{user_name}* has arrived safely at *{dest_name}*.\n\n"
            f"The live escort tracking session has ended. Thank you for your support!"
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[ESCORT ARRIVED WHATSAPP SENT] escort_id={escort_id}, to={masked}")
            else:
                app_logger.error(f"[ESCORT ARRIVED WHATSAPP FAILED] escort_id={escort_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_timer_started_whatsapp_notifications_background(timer_id, user_name, minutes, deadline_str, recipient_phones):
    """
    Send WhatsApp notification to contacts when user starts a Safe Timer.
    """
    if not recipient_phones:
        return

    def worker():
        message = (
            f"⏱️ *SafeHer Safety Timer Activated* ⏱️\n\n"
            f"*{user_name}* has started a *{minutes}-minute* safety timer.\n\n"
            f"🕒 *Check-in Deadline*: {deadline_str}\n"
            f"🛡️ *Status*: Actively Monitored\n\n"
            f"If {user_name} does not check in or enter her safety PIN before {deadline_str}, "
            f"an urgent SOS alert will be triggered automatically to all emergency contacts with live GPS coordinates."
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[TIMER START WHATSAPP SENT] timer_id={timer_id}, to={masked}")
            else:
                app_logger.error(f"[TIMER START WHATSAPP FAILED] timer_id={timer_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_timer_safe_whatsapp_notifications_background(timer_id, user_name, recipient_phones):
    """
    Send WhatsApp notification to contacts when user safely cancels/disarms the timer.
    """
    if not recipient_phones:
        return

    def worker():
        message = (
            f"✅ *SAFE CHECK-IN - SafeHer* ✅\n\n"
            f"*{user_name}* has arrived safely and checked in with her PIN.\n\n"
            f"The safety timer is now disarmed. All clear!"
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[TIMER SAFE WHATSAPP SENT] timer_id={timer_id}, to={masked}")
            else:
                app_logger.error(f"[TIMER SAFE WHATSAPP FAILED] timer_id={timer_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_location_share_whatsapp_notifications_background(share_id, user_name, duration_str, lat, lng, recipient_phones, token=None):
    """
    Send WhatsApp notification to contacts when user starts Live Location Sharing.
    """
    if not recipient_phones:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_url = f"{frontend_url}/track.html?t={token}" if token else f"{frontend_url}/track.html"
        maps_url = f"https://www.google.com/maps?q={lat},{lng}"
        message = (
            f"📍 *SafeHer Live Location Shared* 📍\n\n"
            f"*{user_name}* is sharing her live real-time GPS location with you ({duration_str}).\n\n"
            f"🔴 *Live Tracking Map*:\n{track_url}\n\n"
            f"📍 *Google Maps Location*:\n{maps_url}\n\n"
            f"Follow her movement live in your browser."
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[SHARE LOCATION WHATSAPP SENT] share_id={share_id}, to={masked}")
            else:
                app_logger.error(f"[SHARE LOCATION WHATSAPP FAILED] share_id={share_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_ride_started_whatsapp_notifications_background(ride_id, user_name, vehicle_type, vehicle_number, driver_name, driver_phone, app_used, pickup, destination, eta_mins, lat, lng, share_token, recipient_phones):
    """
    Send automated WhatsApp notifications to contacts when user starts a monitored Ride.
    """
    if not recipient_phones:
        return

    def worker():
        frontend_url = os.getenv('FRONTEND_URL', 'https://rohancse2025.github.io/Safeher').rstrip('/')
        track_url = f"{frontend_url}/track.html?t={share_token}" if share_token else f"{frontend_url}/track.html"
        driver_str = driver_name or 'Driver'
        if driver_phone:
            driver_str += f" (Tel: {driver_phone})"

        message = (
            f"🚖 *SAFEHER RIDE SAFETY ALERT* 🚖\n\n"
            f"*{user_name}* has boarded a *{vehicle_type}* ({app_used}) and shared live trip details:\n\n"
            f"• *Vehicle:* {vehicle_number} ({vehicle_type})\n"
            f"• *Driver:* {driver_str}\n"
            f"• *From:* {pickup}\n"
            f"• *To:* {destination}\n"
            f"• *ETA:* ~{eta_mins} mins\n\n"
            f"🔴 *Live GPS Location & Route*:\n{track_url}\n\n"
            f"⚡ SafeHer is actively monitoring this ride. You will be alerted automatically if any emergency SOS occurs."
        )

        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[RIDE START WHATSAPP SENT] ride_id={ride_id}, to={masked}")
            else:
                app_logger.error(f"[RIDE START WHATSAPP FAILED] ride_id={ride_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()


def send_ride_arrived_whatsapp_notifications_background(ride_id, user_name, destination, vehicle_number, recipient_phones):
    """
    Send automated WhatsApp notification when user marks ride as reached safely.
    """
    if not recipient_phones:
        return

    def worker():
        message = (
            f"✅ *REACHED SAFELY - SafeHer Ride* ✅\n\n"
            f"*{user_name}* has arrived safely at *{destination}*!\n\n"
            f"The monitored ride session ({vehicle_number}) has concluded. All clear!"
        )
        for phone in recipient_phones:
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, message)
            if success:
                app_logger.info(f"[RIDE ARRIVED WHATSAPP SENT] ride_id={ride_id}, to={masked}")
            else:
                app_logger.error(f"[RIDE ARRIVED WHATSAPP FAILED] ride_id={ride_id}, to={masked}, error={err_msg}")

    threading.Thread(target=worker, daemon=True).start()

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
    green_id = (os.getenv('GREEN_API_ID_INSTANCE') or os.getenv('idInstance') or '').strip()
    green_token = (os.getenv('GREEN_API_TOKEN_INSTANCE') or os.getenv('apiTokenInstance') or '').strip()
    green_host = (os.getenv('GREEN_API_HOST_URL') or os.getenv('hostUrl') or '').strip().rstrip('/')
    if not green_host and green_id:
        cluster = green_id[:4]
        green_host = f"https://{cluster}.api.greenapi.com"

    if green_id and green_token:
        try:
            clean_digits = re.sub(r'\D', '', normalized)
            if len(clean_digits) == 10:
                clean_digits = '91' + clean_digits

            # Verify if recipient is registered on WhatsApp
            try:
                chk_url = f"{green_host}/waInstance{green_id}/checkWhatsapp/{green_token}"
                chk_resp = requests.post(chk_url, json={'phoneNumber': clean_digits}, timeout=5)
                if chk_resp.status_code == 200:
                    chk_data = chk_resp.json()
                    if not chk_data.get('existsWhatsapp', True):
                        app_logger.warning(f"[WHATSAPP NOT DELIVERED: {mask_phone(normalized)} is not registered on WhatsApp]")
                        return False, f"Phone number {clean_digits} does not have a WhatsApp account"
            except Exception:
                pass

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
            return False, f"Green-API error {resp.status_code}: {resp.text}"
        except Exception as e:
            return False, f"Green-API exception: {str(e)}"

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

        message = (
            f"🚨 *EMERGENCY SOS ALERT - SafeHer* 🚨\n\n"
            f"*{user_name}* has triggered an urgent SOS alert!\n\n"
            f"⚠️ *Mode*: {mode.upper()}\n"
            f"🕒 *Time*: {started_at_str}\n"
            f"📍 *Google Maps Location*:\n{maps_link}\n\n"
            f"🔴 *Live Tracking Link*:\n{track_link}\n\n"
            f"Please contact {user_name} immediately or call Police (112)."
        )

        for phone in recipient_phones:
            tok = share_token
            if contact_tokens and isinstance(contact_tokens, dict):
                tok = contact_tokens.get(phone) or share_token
            per_track_link = f"{frontend_url}/track.html?t={tok}"
            per_message = message.replace(track_link, per_track_link)
            masked = mask_phone(phone)
            success, err_msg = send_whatsapp(phone, per_message)
            if success:
                app_logger.info(f"[WHATSAPP SENT] alert_id={alert_id}, to={masked}, status={err_msg or 'delivered'}")
            else:
                app_logger.error(f"[WHATSAPP FAILED] alert_id={alert_id}, to={masked}, error={err_msg}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

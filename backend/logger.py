# backend/logger.py – Centralized rotating file logger with sensitive data masking
import os
import re
import logging
from logging.handlers import RotatingFileHandler

# Path to backend/logs/app.log
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOGS_DIR = os.path.join(BASE_DIR, 'logs')
os.makedirs(LOGS_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOGS_DIR, 'app.log')

# Masking utilities
def mask_phone(phone):
    """
    Mask all digits except the last 2 digits of a phone number.
    e.g. "9876543210" -> "********10"
         "+91 9876543210" -> "+91 ********10"
    """
    if not phone:
        return ""
    phone_str = str(phone).strip()
    digits = [c for c in phone_str if c.isdigit()]
    if len(digits) <= 2:
        return "**"

    total_digits = len(digits)
    seen = 0
    result = []
    for char in phone_str:
        if char.isdigit():
            seen += 1
            if seen <= total_digits - 2:
                result.append('*')
            else:
                result.append(char)
        else:
            result.append(char)
    return "".join(result)


def mask_email(email):
    """
    Mask email address username for privacy:
    e.g. "contact@domain.com" -> "c***@domain.com"
    """
    if not email:
        return ""
    email_str = str(email).strip()
    if '@' not in email_str:
        return "***"
    user_part, domain_part = email_str.split('@', 1)
    if len(user_part) <= 1:
        masked_user = "*"
    else:
        masked_user = user_part[0] + "*" * (len(user_part) - 1)
    return f"{masked_user}@{domain_part}"


def mask_token(token):
    """
    Mask authorization/share tokens completely.
    """
    if not token:
        return ""
    return "[TOKEN]"


def sanitize_text(text):
    """
    Scan string for sensitive details such as 10-digit phone numbers and tokens.
    """
    if not text:
        return ""
    # Mask any standalone 10-digit number
    text = re.sub(r'\b(\d{8})(\d{2})\b', r'********\2', str(text))
    return text


# Initialize rotating logger
app_logger = logging.getLogger("safeher_app")
app_logger.setLevel(logging.INFO)

# Avoid duplicate handlers on server reloads
if not app_logger.handlers:
    file_handler = RotatingFileHandler(
        LOG_FILE,
        maxBytes=2 * 1024 * 1024, # 2 MB per file
        backupCount=5,
        encoding='utf-8'
    )
    formatter = logging.Formatter('[%(asctime)s] %(levelname)s: %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
    file_handler.setFormatter(formatter)
    app_logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    app_logger.addHandler(console_handler)

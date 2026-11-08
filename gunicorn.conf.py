# gunicorn.conf.py - Automatic Gunicorn Configuration for Render Cloud Deployment
import os

# Render dynamically sets PORT (defaults to 10000 on Render, 5000 elsewhere)
port = os.environ.get("PORT", "10000")
bind = f"0.0.0.0:{port}"

# Concurrency and timeout configuration
workers = 2
timeout = 120
worker_class = "sync"
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = "info"

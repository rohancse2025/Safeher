# backend/wsgi.py - WSGI entrypoint for production cloud deployment
from app import app

if __name__ == "__main__":
    app.run()

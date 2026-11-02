# SafeHer Backend – Rules

Follow these rules in every backend task.

## Stack
- Python 3
- Flask
- flask-cors
- Built-in `sqlite3` module (no ORM)
- `werkzeug.security` for password and PIN hashing
- `PyJWT` for authentication tokens
- `python-dotenv` for configuration settings

## Files & Structure
- `backend/app.py` – Application entry point and server setup
- `backend/db.py` – Database connection and schema migrations
- `backend/routes/` – Route handlers (one file per feature)
- `backend/requirements.txt` – Python package dependencies
- `backend/.env.example` – Example environment configuration
- `backend/README.md` – Backend instructions and endpoint reference

## API Response Format
All JSON responses must follow this standard format:
- Success: `{"ok": true, "data": ...}`
- Error: `{"ok": false, "error": "message"}`

## Code & Security Guidelines
- Validate all inputs and return clear error messages.
- Keep code simple, clean, and beginner-friendly with short comments.
- Never write secrets into code; read them strictly from environment variables via `.env`.
- Add `.env` and `*.db` to `.gitignore`.
- Configure CORS to allow `http://localhost` (and `http://127.0.0.1`) and the GitHub Pages origin defined in `.env`.
- Don't add features that weren't requested.
- Don't run git commands.

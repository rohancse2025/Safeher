# app.py (Root entrypoint for Render and cloud WSGI deployment)
import sys
import os

backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'backend'))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import backend.app as _backend_module
app = _backend_module.app
create_app = _backend_module.create_app

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port)

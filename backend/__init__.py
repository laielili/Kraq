# backend package init: load project-root .env BEFORE any module builds
# endpoint requests (models_client.resolve_api_key reads os.environ).
from . import dotenv  # noqa: F401  (side-effect import: populates os.environ)

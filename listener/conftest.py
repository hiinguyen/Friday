import os

# Entry points run by the tests (tts.py, enroll.py) must not pick up the owner's
# .env: a setting there would change what they do. See env.py.
os.environ["FRIDAY_ENV_FILE"] = ""

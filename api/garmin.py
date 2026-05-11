import json
import os
import time
import logging
import sys
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from garminconnect import Garmin


CACHE_TTL_SECONDS = 30 * 60
TOKEN_STORE = os.path.expanduser(os.getenv("GARMINTOKENS", "~/.garminconnect"))
_MEMORY_CACHE = {}
_CLIENT = None
_CLIENT_TS = 0
_CLIENT_TTL_SECONDS = 10 * 60
_MAX_RETRIES = 3
_LOG_PATH = os.getenv("GARMIN_LOG")


def _cache_get(key):
    entry = _MEMORY_CACHE.get(key)
    if not entry:
        return None
    if time.time() - entry["timestamp"] > CACHE_TTL_SECONDS:
        _MEMORY_CACHE.pop(key, None)
        return None
    return entry["value"]


def _cache_set(key, value):
    _MEMORY_CACHE[key] = {"value": value, "timestamp": time.time()}


def _get_logger():
    logger = logging.getLogger("garmin_api")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    if _LOG_PATH:
        log_dir = os.path.dirname(_LOG_PATH)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        handler = logging.FileHandler(_LOG_PATH)
    else:
        handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def _is_rate_limited(err):
    return "429" in str(err)


def _with_backoff(fn, *args, **kwargs):
    delay = 1
    for attempt in range(_MAX_RETRIES):
        try:
            return fn(*args, **kwargs)
        except Exception as err:
            _get_logger().warning("Garmin request failed attempt=%s error=%s", attempt + 1, err)
            if not _is_rate_limited(err) or attempt == _MAX_RETRIES - 1:
                raise
            time.sleep(delay)
            delay *= 2


def _get_client(email, password):
    global _CLIENT, _CLIENT_TS
    now = time.time()
    if _CLIENT and now - _CLIENT_TS < _CLIENT_TTL_SECONDS:
        return _CLIENT
    os.makedirs(TOKEN_STORE, exist_ok=True)
    client = Garmin(email, password)
    _with_backoff(client.login, TOKEN_STORE)
    _CLIENT = client
    _CLIENT_TS = now
    return client


def _resolve_date(query_date):
    if query_date and len(query_date) == 10:
        return query_date
    return (date.today() - timedelta(days=1)).isoformat()


def _build_date_range(days):
    days = min(14, max(3, days))
    return [(date.today() - timedelta(days=i)).isoformat() for i in range(1, days + 1)]


def _read_query(path):
    parsed = urlparse(path or "")
    return parse_qs(parsed.query)


def _send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        logger = _get_logger()
        email = os.getenv("GARMIN_EMAIL")
        password = os.getenv("GARMIN_PASSWORD")
        if not email or not password:
            _send_json(self, 500, {"error": "Missing GARMIN_EMAIL or GARMIN_PASSWORD"})
            return

        params = _read_query(self.path)
        date_str = _resolve_date((params.get("date") or params.get("day") or [None])[0])
        range_raw = (params.get("range") or [""])[0]
        range_days = int(range_raw) if range_raw.isdigit() else 0
        cache_key = f"range:{range_days}" if range_days else f"date:{date_str}"
        cached = _cache_get(cache_key)
        if cached:
            cached["cached"] = True
            _send_json(self, 200, cached)
            return

        try:
            logger.info("Garmin request start date=%s range=%s", date_str, range_days or 0)
            client = _get_client(email, password)

            sleep = _with_backoff(client.get_sleep_data, date_str)
            summary = None
            body_battery = None

            try:
                summary = _with_backoff(client.get_stats, date_str)
            except Exception:
                summary = None

            try:
                body_battery = _with_backoff(client.get_body_battery, date_str)
            except Exception:
                body_battery = None

            range_data = None
            if range_days:
                range_data = []
                for day in _build_date_range(range_days):
                    try:
                        day_sleep = _with_backoff(client.get_sleep_data, day)
                        range_data.append({"date": day, "sleep": day_sleep})
                    except Exception:
                        range_data.append({"date": day, "sleep": None, "error": True})

            payload = {
                "date": date_str,
                "sleep": sleep,
                "summary": summary,
                "bodyBattery": body_battery,
                "range": range_data,
            }
            logger.info(
                "Garmin request ok date=%s range=%s has_sleep=%s has_summary=%s has_body_battery=%s",
                date_str,
                range_days or 0,
                sleep is not None,
                summary is not None,
                body_battery is not None,
            )
            _cache_set(cache_key, payload)
            _send_json(self, 200, payload)
        except Exception as err:
            logger.error("Garmin request failed date=%s range=%s error=%s", date_str, range_days or 0, err)
            _send_json(self, 500, {"error": str(err)})

    def do_POST(self):
        _send_json(self, 405, {"error": "Method not allowed"})

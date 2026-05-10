import json
import os
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from garminconnect import Garmin


CACHE_TTL_SECONDS = 10 * 60
TOKEN_STORE = "/tmp/garmin_tokens.json"
_MEMORY_CACHE = {}


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
            client = Garmin(email, password)
            client.login(TOKEN_STORE)

            sleep = client.get_sleep_data(date_str)
            summary = None
            body_battery = None

            try:
                summary = client.get_stats(date_str)
            except Exception:
                summary = None

            try:
                body_battery = client.get_body_battery(date_str)
            except Exception:
                body_battery = None

            range_data = None
            if range_days:
                range_data = []
                for day in _build_date_range(range_days):
                    try:
                        day_sleep = client.get_sleep_data(day)
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
            _cache_set(cache_key, payload)
            _send_json(self, 200, payload)
        except Exception as err:
            _send_json(self, 500, {"error": str(err)})

    def do_POST(self):
        _send_json(self, 405, {"error": "Method not allowed"})

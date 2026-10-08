#!/usr/bin/env python3
"""Black-box tests for an isolated PingUp development instance.

This suite creates five random accounts and real conversations/files. Never run
it against a production database. Only loopback URLs are accepted by default.

Example server environment:
    PINGUP_STORAGE_PATH=/tmp/pingup-test PINGUP_SECURE_COOKIES=0
    PINGUP_MAX_USERS=0 PINGUP_INVITE_CODE=<temporary-invite>

Run:
    python3 tests/integration.py --base-url http://127.0.0.1:8080 \
        --invite-code <temporary-invite>

Optional admin verification uses PINGUP_TEST_ADMIN_USER and
PINGUP_TEST_ADMIN_PASSWORD from the environment. Credentials are never logged.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import secrets
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class Response:
    status: int
    body: bytes
    headers: Any

    def json(self) -> dict[str, Any]:
        try:
            value = json.loads(self.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AssertionError(
                f"Expected JSON, got HTTP {self.status}, "
                f"Content-Type {self.headers.get('Content-Type', '(missing)')}"
            ) from error
        if not isinstance(value, dict):
            raise AssertionError("Expected a JSON object")
        return value


class Client:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/") + "/"
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.csrf = ""
        self.user: dict[str, Any] | None = None

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> Response:
        request = urllib.request.Request(
            urllib.parse.urljoin(self.base_url, path),
            data=body,
            headers=headers or {},
            method=method,
        )
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return Response(response.status, response.read(), response.headers)

    def api(
        self,
        action: str,
        payload: dict[str, Any] | None = None,
        *,
        query: dict[str, Any] | None = None,
        csrf: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Response:
        url = "api.php?" + urllib.parse.urlencode({"action": action, **(query or {})})
        headers = dict(extra_headers or {})
        body = None
        method = "GET"
        if payload is not None:
            method = "POST"
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["X-CSRF-Token"] = self.csrf if csrf is None else csrf
        return self.request(url, method=method, body=body, headers=headers)

    def ok(self, action: str, payload: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        response = self.api(action, payload, **kwargs)
        result = response.json()
        if not 200 <= response.status < 300 or result.get("ok") is not True:
            code = result.get("error", {}).get("code", "unknown")
            raise AssertionError(f"{action}: HTTP {response.status}, {code}")
        data = result["data"]
        if isinstance(data, dict) and "csrf" in data:
            self.csrf = data["csrf"]
        if isinstance(data, dict) and "user" in data:
            self.user = data["user"]
        return data

    def bootstrap(self) -> dict[str, Any]:
        return self.ok("bootstrap")

    def upload(self, filename: str, content: bytes, mime: str = "text/plain", purpose: str = "file") -> Response:
        boundary = "pingup-test-" + secrets.token_hex(12)
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\n{purpose}\r\n".encode(),
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
            ).encode(),
            content,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        return self.request(
            "api.php?action=files.upload",
            method="POST",
            body=b"".join(parts),
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "X-CSRF-Token": self.csrf,
            },
        )


OPTIONS: argparse.Namespace


class PingUpIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.prefix = "qa" + secrets.token_hex(4)
        cls.password = secrets.token_urlsafe(24) + "A1!"
        cls.clients: list[Client] = []
        cls.ids: list[int] = []
        for index in range(5):
            client = Client(OPTIONS.base_url)
            guest = client.bootstrap()
            if guest.get("user") is not None or not client.csrf:
                raise AssertionError("Guest bootstrap must return csrf and null user")
            data = client.ok("auth.register", {
                "username": f"{cls.prefix}_{index}",
                "name": ["QA Alice", "QA Bob", "QA Carol", "QA Dave", "QA Eve"][index],
                "password": cls.password,
                "invite_code": OPTIONS.invite_code,
                "locale": ["en", "uk", "ru", "en", "uk"][index],
                "role": "admin",
                "is_verified": True,
            })
            user = data["user"]
            if user["role"] != "user" or user["is_verified"]:
                raise AssertionError("Registration accepted a forged admin role")
            cls.clients.append(client)
            cls.ids.append(user["id"])
        cls.alice, cls.bob, cls.carol, cls.dave, cls.eve = cls.clients
        cls.direct = cls.alice.ok("conversations.create", {
            "type": "direct", "user_id": cls.ids[1],
        })
        cls.group = cls.alice.ok("conversations.create", {
            "type": "group", "name": "QA private group " + cls.prefix,
            "user_ids": [cls.ids[1], cls.ids[3], cls.ids[4]],
        })

    def error(self, response: Response, status: int, code: str | None = None) -> dict[str, Any]:
        result = response.json()
        self.assertEqual(response.status, status, result.get("error", {}).get("code"))
        self.assertIs(result.get("ok"), False)
        self.assertNotIn("data", result)
        if code:
            self.assertEqual(result["error"]["code"], code)
        # SQL errors, filesystem paths and stack traces should stay server-side.
        wire = response.body.decode("utf-8")
        self.assertNotIn("SQLSTATE", wire)
        self.assertNotIn("Stack trace", wire)
        self.assertNotIn("password_hash", wire)
        return result

    def send(self, client: Client, conversation: int, text: str, **extra: Any) -> dict[str, Any]:
        return client.ok("messages.send", {
            "conversation_id": conversation,
            "text": text,
            "client_id": "test:" + secrets.token_hex(16),
            **extra,
        })

    def messages(self, client: Client, conversation: int, **params: Any) -> list[dict[str, Any]]:
        return client.ok("messages.list", query={"conversation_id": conversation, **params})["messages"]

    def conversation(self, client: Client, conversation_id: int) -> dict[str, Any]:
        matches = [row for row in client.ok("conversations.list") if row["id"] == conversation_id]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_01_authentication_sessions_and_csrf(self) -> None:
        guest = Client(OPTIONS.base_url)
        guest.bootstrap()
        self.error(guest.api("conversations.list"), 401, "unauthorized")
        self.error(guest.api("auth.login", {
            "username": self.prefix + "_0", "password": self.password,
        }, csrf="wrong-token"), 403, "csrf_invalid")
        self.error(guest.api("auth.login", {
            "username": self.prefix + "_0", "password": secrets.token_urlsafe(24),
        }), 401)
        old_session_ids = [cookie.value for cookie in guest.cookies]
        login = guest.ok("auth.login", {
            "username": self.prefix + "_0", "password": self.password,
        })
        self.assertEqual(login["user"]["id"], self.ids[0])
        self.assertTrue(guest.csrf)
        self.assertNotEqual(old_session_ids, [cookie.value for cookie in guest.cookies], "Login must rotate the session ID")
        cookies = list(guest.cookies)
        self.assertTrue(cookies)
        self.assertTrue(any(cookie.has_nonstandard_attr("HttpOnly") for cookie in cookies))
        self.error(guest.api("profile.update", {"name": "Should not change"}, csrf=""), 403, "csrf_invalid")
        before = guest.bootstrap()["user"]["name"]
        self.assertEqual(before, "QA Alice")
        guest.ok("auth.logout", {})
        self.assertIsNone(guest.bootstrap()["user"])
        self.error(guest.api("messages.list", query={"conversation_id": self.direct["id"]}), 401, "unauthorized")

    def test_02_duplicate_registration_and_secret_filtering(self) -> None:
        guest = Client(OPTIONS.base_url)
        guest.bootstrap()
        self.error(guest.api("auth.register", {
            "username": (self.prefix + "_0").upper(), "name": "Duplicate",
            "password": self.password, "invite_code": OPTIONS.invite_code,
        }), 409)
        if OPTIONS.invite_code:
            self.error(guest.api("auth.register", {
                "username": self.prefix + "_new", "name": "Wrong invite",
                "password": self.password, "invite_code": "wrong-" + secrets.token_hex(12),
            }), 403)
        for client in self.clients:
            user = client.bootstrap()["user"]
            self.assertNotIn("password_hash", user)
            self.assertNotIn("password", user)
            self.assertNotIn("csrf", user)
            self.assertFalse(user["is_verified"])

    def test_03_profile_locales_themes_and_privilege_boundary(self) -> None:
        for locale, theme in [("uk", "light"), ("ru", "dark"), ("en", "system")]:
            data = self.carol.ok("profile.update", {
                "name": "QA Carol", "bio": "Привіт / Привет / Hello 👋",
                "location": "Kyiv", "website": "https://example.com/profile",
                "accent": "#35bbdd", "locale": locale, "theme": theme,
                "role": "admin", "is_verified": True, "user_id": self.ids[0],
            })
            user = data
            self.assertEqual(user["id"], self.ids[2])
            self.assertEqual(user["locale"], locale)
            self.assertEqual(user["theme"], theme)
            self.assertEqual(user["bio"], "Привіт / Привет / Hello 👋")
            self.assertEqual(user["role"], "user")
            self.assertFalse(user["is_verified"])
        self.assertEqual(self.alice.bootstrap()["user"]["name"], "QA Alice")
        self.error(self.carol.api("profile.update", {"website": "javascript:alert(1)"}), 400)
        self.error(self.carol.api("profile.update", {"locale": "de"}), 400)
        self.error(self.carol.api("profile.update", {"theme": "unknown"}), 400)
        self.assertEqual(self.carol.bootstrap()["user"]["website"], "https://example.com/profile")

    def test_04_discovery_and_canonical_direct_conversation(self) -> None:
        results = self.alice.ok("users.search", query={"q": self.prefix})
        result_ids = {user["id"] for user in results}
        self.assertTrue(set(self.ids[1:]).issubset(result_ids))
        for user in results:
            self.assertNotIn("password_hash", user)
        reverse = self.bob.ok("conversations.create", {
            "type": "direct", "user_id": self.ids[0],
        })
        self.assertEqual(reverse["id"], self.direct["id"])
        repeat = self.alice.ok("conversations.create", {
            "type": "direct", "user_id": self.ids[1],
        })
        self.assertEqual(repeat["id"], self.direct["id"])
        self.assertEqual({u["id"] for u in repeat["participants"]}, set(self.ids[:2]))

    def test_05_real_delivery_idempotency_replies_reactions_and_unread(self) -> None:
        conversation_id = self.direct["id"]
        before = self.conversation(self.bob, conversation_id)["unread"]
        payload = {
            "conversation_id": conversation_id,
            "text": "Hello, Привіт, Привет 👋 <script>alert('inert text')</script>",
            "client_id": "retry:" + secrets.token_hex(16),
        }
        message = self.alice.ok("messages.send", payload)
        retry = self.alice.ok("messages.send", payload)
        self.assertEqual(message["id"], retry["id"])
        delivered = self.messages(self.bob, conversation_id)
        self.assertEqual(sum(row["client_id"] == payload["client_id"] for row in delivered), 1)
        self.assertEqual(next(row for row in delivered if row["id"] == message["id"])["text"], payload["text"])
        self.assertEqual(self.conversation(self.bob, conversation_id)["unread"], before + 1)
        reply = self.send(self.bob, conversation_id, "Got it", reply_to=message["id"])
        self.assertEqual(reply["reply_to"], message["id"])
        self.assertEqual(reply["reply"]["text"], payload["text"])
        self.bob.ok("messages.react", {"message_id": message["id"], "emoji": "💜"})
        updated = next(row for row in self.messages(self.alice, conversation_id) if row["id"] == message["id"])
        self.assertEqual(updated["reactions"], [{"emoji": "💜", "count": 1, "mine": False}])
        self.bob.ok("messages.react", {"message_id": message["id"], "emoji": "💜"})
        toggled = next(row for row in self.messages(self.bob, conversation_id) if row["id"] == message["id"])
        self.assertEqual(toggled["reactions"], [])
        self.bob.ok("conversations.read", {"conversation_id": conversation_id, "last_message_id": reply["id"]})
        self.assertEqual(self.conversation(self.bob, conversation_id)["unread"], 0)
        newer = self.send(self.alice, conversation_id, "A new message after read")
        incremental = self.messages(self.bob, conversation_id, after_id=reply["id"])
        self.assertEqual([row["id"] for row in incremental], [newer["id"]])
        self.assertEqual(self.conversation(self.bob, conversation_id)["unread"], 1)
        # A delayed old read request must not roll the marker back.
        self.bob.ok("conversations.read", {"conversation_id": conversation_id, "last_message_id": message["id"]})
        self.assertEqual(self.conversation(self.bob, conversation_id)["unread"], 1)
        # Polling returns new IDs separately from mutations of existing IDs.
        self.alice.ok("messages.edit", {"message_id": message["id"], "text": "Changed after delivery"})
        sync = self.bob.ok("sync", query={"conversation_id": conversation_id, "after_id": reply["id"]})
        self.assertEqual([row["id"] for row in sync["messages"]], [newer["id"]])
        changed = next(row for row in sync["updated_messages"] if row["id"] == message["id"])
        self.assertEqual(changed["text"], "Changed after delivery")

    def test_06_group_membership_and_message_ownership(self) -> None:
        conversation_id = self.group["id"]
        self.assertEqual({row["id"] for row in self.group["participants"]}, {self.ids[i] for i in (0, 1, 3, 4)})
        message = self.send(self.alice, conversation_id, "Members only")
        for member in (self.bob, self.dave, self.eve):
            self.assertIn(message["id"], [row["id"] for row in self.messages(member, conversation_id)])
        self.assertNotIn(conversation_id, [row["id"] for row in self.carol.ok("conversations.list")])
        self.error(self.carol.api("messages.list", query={"conversation_id": conversation_id}), 404)
        self.error(self.carol.api("messages.send", {
            "conversation_id": conversation_id, "text": "Intrusion", "client_id": "intrude:" + secrets.token_hex(12),
        }), 404)
        self.error(self.carol.api("messages.react", {"message_id": message["id"], "emoji": "💜"}), 404)
        self.error(self.carol.api("conversations.read", {"conversation_id": conversation_id, "last_message_id": message["id"]}), 404)
        self.error(self.bob.api("messages.edit", {"message_id": message["id"], "text": "Forged Alice"}), 403)
        self.error(self.bob.api("messages.delete", {"message_id": message["id"]}), 403)
        edited = self.alice.ok("messages.edit", {"message_id": message["id"], "text": "Edited by owner"})
        self.assertTrue(edited["edited"])
        self.assertEqual(edited["text"], "Edited by owner")
        self.alice.ok("messages.delete", {"message_id": message["id"]})
        tombstone = next(row for row in self.messages(self.bob, conversation_id) if row["id"] == message["id"])
        self.assertTrue(tombstone["deleted"])
        self.assertEqual(tombstone["text"], "")

    def test_07_forward_save_and_cross_conversation_reference_checks(self) -> None:
        message = self.send(self.alice, self.direct["id"], "Forwardable original")
        forwarded = self.bob.ok("messages.forward", {
            "message_id": message["id"], "conversation_id": self.group["id"],
            "client_id": "forward:" + secrets.token_hex(16),
        })
        self.assertTrue(forwarded["forwarded"])
        self.assertEqual(forwarded["text"], message["text"])
        saved = self.bob.ok("messages.save", {"message_id": message["id"]})
        self.assertTrue(saved["forwarded"])
        saved_id = saved["conversation_id"]
        self.assertEqual(self.conversation(self.bob, saved_id)["type"], "saved")
        self.error(self.alice.api("messages.list", query={"conversation_id": saved_id}), 404)
        self.error(self.carol.api("messages.forward", {
            "message_id": message["id"], "conversation_id": self.group["id"],
            "client_id": "badforward:" + secrets.token_hex(12),
        }), 404)
        self.error(self.alice.api("messages.send", {
            "conversation_id": self.group["id"], "text": "Cross-room reply",
            "reply_to": message["id"], "client_id": "badreply:" + secrets.token_hex(12),
        }), 400, "invalid_reply")
        self.error(self.alice.api("messages.send", {
            "conversation_id": self.group["id"], "text": "Wrong retry target",
            "client_id": message["client_id"],
        }), 409, "client_id_conflict")

    def test_08_safe_files_and_download_authorization(self) -> None:
        contents = ("Private attachment " + self.prefix + "\n").encode("utf-8")
        uploaded = self.alice.upload("notes.txt", contents)
        self.assertEqual(uploaded.status, 200, uploaded.json())
        file = uploaded.json()["data"]
        owner_download = self.alice.request(file["url"])
        self.assertEqual(owner_download.status, 200)
        self.assertEqual(owner_download.body, contents)
        self.assertEqual(owner_download.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("attachment", owner_download.headers.get("Content-Disposition", ""))
        ranged = self.alice.request(file["url"], headers={"Range": "bytes=2-8"})
        self.assertEqual(ranged.status, 206)
        self.assertEqual(ranged.body, contents[2:9])
        self.assertEqual(ranged.headers.get("Content-Range"), f"bytes 2-8/{len(contents)}")
        suffix = self.alice.request(file["url"], headers={"Range": "bytes=-4"})
        self.assertEqual(suffix.status, 206)
        self.assertEqual(suffix.body, contents[-4:])
        stranger_before = self.bob.request(file["url"])
        self.assertIn(stranger_before.status, (403, 404))
        self.error(self.bob.api("messages.send", {
            "conversation_id": self.direct["id"], "file_id": file["id"],
            "text": "Stolen file", "client_id": "stolen:" + secrets.token_hex(12),
        }), 404, "file_not_found")
        message = self.send(self.alice, self.group["id"], "Shared notes", file_id=file["id"])
        self.assertEqual(message["file"]["id"], file["id"])
        member_download = self.bob.request(file["url"])
        self.assertEqual(member_download.status, 200)
        self.assertEqual(member_download.body, contents)
        self.assertIn(self.carol.request(file["url"]).status, (403, 404))
        unauthenticated = Client(OPTIONS.base_url)
        self.assertEqual(unauthenticated.request(file["url"]).status, 401)
        pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
        pdf_response = self.alice.upload("document.pdf", pdf, "application/pdf")
        self.assertEqual(pdf_response.status, 200, pdf_response.json())
        pdf_file = pdf_response.json()["data"]
        self.assertEqual(pdf_file["mime"], "application/pdf")
        pdf_download = self.alice.request(pdf_file["url"])
        self.assertEqual(pdf_download.body, pdf)
        self.assertIn("attachment", pdf_download.headers.get("Content-Disposition", ""))
        dangerous = [
            ("evil.html", b"<!doctype html><script>alert(1)</script>", "text/html"),
            ("evil.svg", b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "image/svg+xml"),
            ("evil.php", b"<?php system($_GET['x']);", "application/x-httpd-php"),
            ("disguised.php", contents, "text/plain"),
        ]
        for filename, content, mime in dangerous:
            with self.subTest(filename=filename):
                response = self.alice.upload(filename, content, mime)
                self.assertIn(response.status, (400, 415))
                self.assertIs(response.json()["ok"], False)
        self.assertIn(self.alice.request("media.php?id=../../config.php").status, (400, 404))
        self.error(self.alice.api("profile.update", {"avatar_file_id": file["id"]}), 400)

    def test_08b_typing_search_and_pin_visibility(self) -> None:
        conversation_id = self.group["id"]
        marker = "unique-search-" + secrets.token_hex(8)
        message = self.send(self.dave, conversation_id, marker)
        self.dave.ok("typing.set", {"conversation_id": conversation_id, "typing": True})
        sync = self.bob.ok("sync", query={"conversation_id": conversation_id, "after_id": message["id"]})
        self.assertIn(self.ids[3], [row["id"] for row in sync["typing"]])
        self.dave.ok("typing.set", {"conversation_id": conversation_id, "typing": False})
        stopped = self.bob.ok("sync", query={"conversation_id": conversation_id, "after_id": message["id"]})
        self.assertNotIn(self.ids[3], [row["id"] for row in stopped["typing"]])
        self.error(self.carol.api("typing.set", {"conversation_id": conversation_id}), 404)
        found = self.eve.ok("messages.search", query={"q": marker})
        self.assertEqual([row["id"] for row in found], [message["id"]])
        self.assertEqual(self.carol.ok("messages.search", query={"q": marker}), [])
        self.error(self.bob.api("messages.pin", {"message_id": message["id"], "pinned": True}), 403)
        pinned = self.alice.ok("messages.pin", {"message_id": message["id"], "pinned": True})
        self.assertTrue(pinned["pinned"])
        pins = self.eve.ok("messages.list", query={"conversation_id": conversation_id})["pinned_messages"]
        self.assertIn(message["id"], [row["id"] for row in pins])
        self.alice.ok("messages.pin", {"message_id": message["id"], "pinned": False})
        self.bob.ok("conversations.pin", {"conversation_id": conversation_id, "pinned": True})
        self.assertTrue(self.conversation(self.bob, conversation_id)["pinned"])
        self.assertFalse(self.conversation(self.alice, conversation_id)["pinned"])

    def test_09_channel_posting_policy(self) -> None:
        channel = self.alice.ok("conversations.create", {
            "type": "channel", "name": "QA announcements " + self.prefix,
            "user_ids": [self.ids[1]],
        })
        message = self.send(self.alice, channel["id"], "Owner announcement")
        self.assertIn(message["id"], [row["id"] for row in self.messages(self.bob, channel["id"])])
        self.error(self.bob.api("messages.send", {
            "conversation_id": channel["id"], "text": "Not an owner",
            "client_id": "channel:" + secrets.token_hex(12),
        }), 403, "posting_forbidden")

    def test_10_verified_admin_is_server_controlled(self) -> None:
        username = os.environ.get("PINGUP_TEST_ADMIN_USER", "")
        password = os.environ.get("PINGUP_TEST_ADMIN_PASSWORD", "")
        if not username or not password:
            self.skipTest("Optional admin credentials not supplied through environment")
        admin = Client(OPTIONS.base_url)
        admin.bootstrap()
        user = admin.ok("auth.login", {"username": username, "password": password})["user"]
        self.assertEqual(user["role"], "admin")
        self.assertTrue(user["is_verified"])
        unchanged = admin.ok("profile.update", {"role": "user", "is_verified": False})
        self.assertEqual(unchanged["role"], "admin")
        self.assertTrue(unchanged["is_verified"])
        found = self.alice.ok("users.search", query={"q": username})
        selected = next(row for row in found if row["id"] == user["id"])
        self.assertTrue(selected["is_verified"])
        admin.ok("auth.logout", {})


def main() -> int:
    global OPTIONS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True, help="Isolated loopback PHP server URL; subdirectories supported")
    parser.add_argument("--invite-code", default=os.environ.get("PINGUP_TEST_INVITE_CODE", ""))
    OPTIONS, unittest_args = parser.parse_known_args()
    parsed = urllib.parse.urlsplit(OPTIONS.base_url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Tests create persistent accounts and messages; use an isolated loopback server")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("The base URL must not contain credentials, a query, or a fragment")
    try:
        program = unittest.main(argv=[sys.argv[0], *unittest_args], exit=False, verbosity=2)
    except urllib.error.URLError as error:
        print(f"Cannot reach the isolated test server: {error.reason}", file=sys.stderr)
        return 2
    return 0 if program.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

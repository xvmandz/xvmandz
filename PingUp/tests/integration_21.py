#!/usr/bin/env python3
"""Black-box tests for PingUp 2.1 features on an isolated development instance.

Covers contacts, privacy, blocks, delivery/read receipts, global search, Premium,
uploads (limits, chunked), feedback centre, e-mail verification/recovery,
communities (roles, bans, invites, comments, views, stats) and message features.

Server environment (in addition to tests/integration.py):
    PINGUP_SMTP_HOST=127.0.0.1 PINGUP_SMTP_PORT=<port> PINGUP_SMTP_SECURE=none
    PINGUP_MAIL_FROM=no-reply@pingup.test
The test starts a local SMTP sink on PINGUP_TEST_SMTP_PORT and runs
`php bin/mail-worker.php --once` with the current environment, so the database
variables must point to the same isolated database as the server.
Admin checks need PINGUP_TEST_ADMIN_USER / PINGUP_TEST_ADMIN_PASSWORD (bin/create-admin.php).

Run:
    python3 tests/integration_21.py --base-url http://127.0.0.1:8080
"""

from __future__ import annotations

import argparse
import base64
import email
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from integration import Client, Response  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
)
OPTIONS: argparse.Namespace


class SmtpSink(threading.Thread):
    """Accepts mail from the worker on loopback and keeps the raw messages in memory."""

    def __init__(self, port: int):
        super().__init__(daemon=True)
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", port))
        self.server.listen(5)
        self.messages: list[tuple[str, email.message.Message]] = []

    def run(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(connection,), daemon=True).start()

    def handle(self, connection: socket.socket) -> None:
        stream = connection.makefile("rwb")

        def reply(line: str) -> None:
            stream.write((line + "\r\n").encode())
            stream.flush()

        reply("220 sink ESMTP")
        recipient = ""
        while True:
            line = stream.readline().decode().rstrip("\r\n")
            if not line:
                break
            verb = line.split(" ")[0].upper()
            if verb == "EHLO":
                reply("250-sink")
                reply("250 8BITMIME")
            elif verb == "MAIL":
                reply("250 ok")
            elif verb == "RCPT":
                recipient = line.split("<", 1)[1].split(">", 1)[0]
                reply("250 ok")
            elif verb == "DATA":
                reply("354 go")
                lines = []
                while True:
                    data = stream.readline().decode()
                    if data.rstrip("\r\n") == ".":
                        break
                    lines.append(data)
                self.messages.append((recipient, email.message_from_string("".join(lines))))
                reply("250 queued")
            elif verb == "QUIT":
                reply("221 bye")
                break
            else:
                reply("500 unknown")
        connection.close()

    def code_for(self, recipient: str) -> str:
        for to, message in reversed(self.messages):
            if to == recipient:
                for part in message.walk():
                    if part.get_content_type() in ("text/plain", "text/html"):
                        text = part.get_payload(decode=True).decode()
                        found = re.search(r"\b(\d{6})\b", text)
                        if found:
                            return found.group(1)
        raise AssertionError("No code delivered to " + recipient)


def run_mail_worker() -> None:
    subprocess.run([os.environ.get("PINGUP_TEST_PHP", "php"), str(ROOT / "bin/mail-worker.php"), "--once"], check=True, capture_output=True, timeout=60)


class PingUp21(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.prefix = "qb" + secrets.token_hex(3)
        cls.password = secrets.token_urlsafe(18) + "A1!"
        cls.clients: list[Client] = []
        cls.ids: list[int] = []
        for index in range(5):
            client = Client(OPTIONS.base_url)
            client.bootstrap()
            data = client.ok("auth.register", {
                "username": f"{cls.prefix}_{index}", "name": f"Tester {'ABCDE'[index]} {cls.prefix}",
                "password": cls.password, "invite_code": OPTIONS.invite_code, "locale": ["en", "uk", "ru", "en", "uk"][index],
            })
            cls.clients.append(client)
            cls.ids.append(data["user"]["id"])
        cls.a, cls.b, cls.c, cls.d, cls.e = cls.clients
        cls.admin = None
        user, password = os.environ.get("PINGUP_TEST_ADMIN_USER", ""), os.environ.get("PINGUP_TEST_ADMIN_PASSWORD", "")
        if user and password:
            cls.admin = Client(OPTIONS.base_url)
            cls.admin.bootstrap()
            cls.admin.ok("auth.login", {"username": user, "password": password})

    def error(self, response: Response, status: int, code: str | None = None) -> None:
        result = response.json()
        self.assertEqual(response.status, status, result.get("error", {}).get("code"))
        if code:
            self.assertEqual(result["error"]["code"], code)
        self.assertNotIn("SQLSTATE", response.body.decode())

    def send(self, client: Client, conversation: int, text: str = "hello", **extra: Any) -> dict[str, Any]:
        return client.ok("messages.send", {"conversation_id": conversation, "text": text, "client_id": "t21:" + secrets.token_hex(12), **extra})

    def conversation(self, client: Client, conversation_id: int) -> dict[str, Any]:
        return next(c for c in client.ok("conversations.list") if c["id"] == conversation_id)

    def need_admin(self) -> Client:
        if not self.admin:
            self.skipTest("Admin credentials not supplied")
        return self.admin

    # Contacts, privacy, blocks ---------------------------------------------------------------
    def test_01_contacts_lifecycle_and_privacy(self) -> None:
        a, b, c = self.a, self.b, self.c
        state = a.ok("contacts.request", {"user_id": self.ids[1]})
        self.assertEqual(state["state"], "outgoing")
        incoming = b.ok("contacts.list")["incoming"]
        self.assertIn(self.ids[0], [u["id"] for u in incoming])
        self.assertEqual(b.ok("contacts.respond", {"user_id": self.ids[0], "accept": True})["state"], "accepted")
        self.assertIn(self.ids[1], [u["id"] for u in a.ok("contacts.list")["contacts"]])
        # Bootstrap contacts are real contacts, never the user directory.
        boot_ids = {u["id"] for u in c.bootstrap()["contacts"]}
        self.assertNotIn(self.ids[0], boot_ids)
        # Last seen visible to contacts only; hidden profile from strangers.
        b.ok("privacy.update", {"last_seen": "contacts", "online": "contacts", "bio": "contacts", "searchable": False})
        b.ok("profile.update", {"bio": "secret bio"})
        a.ok("conversations.create", {"type": "direct", "user_id": self.ids[1]})
        seen_by_contact = a.ok("users.profile", query={"user_id": self.ids[1]})
        self.assertIsNotNone(seen_by_contact["last_seen"])
        self.assertEqual(seen_by_contact["bio"], "secret bio")
        self.error(c.api("users.profile", query={"user_id": self.ids[1]}), 404, "user_not_found")
        found_by_stranger = c.ok("search.global", query={"q": f"{self.prefix}_1", "type": "people"})["people"]
        self.assertEqual(found_by_stranger, [])
        found_by_contact = a.ok("search.global", query={"q": f"{self.prefix}_1", "type": "people"})["people"]
        self.assertEqual([u["id"] for u in found_by_contact], [self.ids[1]])
        # Decline and cooldown.
        c.ok("contacts.request", {"user_id": self.ids[3]})
        self.d.ok("contacts.respond", {"user_id": self.ids[2], "accept": False})
        self.assertEqual(c.ok("contacts.list")["outgoing"], [])
        self.error(c.api("contacts.request", {"user_id": self.ids[3]}), 429, "contact_request_cooldown")
        # Requests closed by privacy.
        self.e.ok("privacy.update", {"contact_requests": "nobody"})
        self.error(c.api("contacts.request", {"user_id": self.ids[4]}), 403, "contact_request_forbidden")
        self.error(a.api("privacy.update", {"last_seen": "friends"}), 400, "invalid_settings")

    def test_02_blocks_are_enforced_server_side(self) -> None:
        a, d = self.a, self.d
        direct = a.ok("conversations.create", {"type": "direct", "user_id": self.ids[3]})
        self.send(a, direct["id"], "before block")
        d.ok("users.block", {"user_id": self.ids[0]})
        self.error(a.api("messages.send", {"conversation_id": direct["id"], "text": "x", "client_id": "blk:" + secrets.token_hex(8)}), 403, "user_blocked")
        self.error(a.api("calls.start", {"user_id": self.ids[3], "kind": "audio", "device_id": "dev" + secrets.token_hex(8)}), 403, "user_blocked")
        self.error(a.api("contacts.request", {"user_id": self.ids[3]}), 403, "contact_request_forbidden")
        hidden = a.ok("users.profile", query={"user_id": self.ids[3]})
        self.assertIsNone(hidden["last_seen"])
        self.assertFalse(hidden["online"])
        self.assertEqual(hidden["contact_state"], "none")
        self.assertEqual(d.ok("users.profile", query={"user_id": self.ids[0]})["contact_state"], "blocked")
        self.assertIn(self.ids[0], [u["id"] for u in d.ok("contacts.list")["blocked"]])
        d.ok("users.unblock", {"user_id": self.ids[0]})
        self.send(a, direct["id"], "after unblock")

    def test_03_first_message_and_calls_privacy(self) -> None:
        self.e.ok("privacy.update", {"message_first": "nobody", "calls": "nobody"})
        self.error(self.c.api("conversations.create", {"type": "direct", "user_id": self.ids[4]}), 403, "privacy_restricted")
        self.error(self.c.api("calls.start", {"user_id": self.ids[4], "kind": "audio", "device_id": "dev" + secrets.token_hex(8)}), 403, "privacy_restricted")
        # An existing conversation keeps working when the setting changes later.
        self.e.ok("privacy.update", {"message_first": "everyone"})
        direct = self.c.ok("conversations.create", {"type": "direct", "user_id": self.ids[4]})
        self.send(self.c, direct["id"], "hi E")
        self.e.ok("privacy.update", {"message_first": "nobody"})
        self.send(self.c, direct["id"], "still allowed")
        self.e.ok("privacy.update", {"message_first": "everyone", "calls": "everyone"})

    def test_04_delivery_and_read_receipts(self) -> None:
        a, b = self.a, self.b
        direct = a.ok("conversations.create", {"type": "direct", "user_id": self.ids[1]})
        message = self.send(a, direct["id"], "receipt check")
        before = self.conversation(a, direct["id"])
        self.assertLess(before["peer_delivered"], message["id"])
        b.ok("sync")  # B's device receives the chat list including this message.
        delivered = self.conversation(a, direct["id"])
        self.assertGreaterEqual(delivered["peer_delivered"], message["id"])
        self.assertLess(delivered["peer_read"], message["id"])
        b.ok("conversations.read", {"conversation_id": direct["id"], "last_message_id": message["id"]})
        self.assertGreaterEqual(self.conversation(a, direct["id"])["peer_read"], message["id"])
        b.ok("privacy.update", {"read_receipts": "nobody"})
        self.assertEqual(self.conversation(a, direct["id"])["peer_read"], 0)
        # Reciprocity: B hides its receipts and therefore sees none either.
        reply = self.send(b, direct["id"], "answer")
        a.ok("conversations.read", {"conversation_id": direct["id"], "last_message_id": reply["id"]})
        self.assertEqual(self.conversation(b, direct["id"])["peer_read"], 0)
        b.ok("privacy.update", {"read_receipts": "everyone"})

    def test_05_global_search_rules(self) -> None:
        c = self.c
        self.assertTrue(c.ok("search.global", query={"q": "a"})["too_short"])
        self.assertEqual(c.ok("search.global", query={"q": "", "type": "people"})["people"], [])
        slug = "pub" + secrets.token_hex(4)
        channel = self.a.ok("conversations.create", {"type": "channel", "name": "Searchable " + slug, "visibility": "public", "slug": slug})
        self.a.ok("conversations.create", {"type": "channel", "name": "Hidden " + slug, "visibility": "private"})
        found = c.ok("search.global", query={"q": slug, "type": "channels"})["channels"]
        self.assertEqual([x["id"] for x in found], [channel["id"]])
        self.assertFalse(found[0]["joined"])
        group_slug = "grp" + secrets.token_hex(4)
        group = self.a.ok("conversations.create", {"type": "group", "name": "Open group " + group_slug, "visibility": "public", "slug": group_slug})
        groups = c.ok("search.global", query={"q": group_slug, "type": "groups"})["groups"]
        self.assertEqual([x["id"] for x in groups], [group["id"]])
        joined = c.ok("channels.join", {"slug": group_slug})
        self.send(c, joined["id"], "joined open group")
        for user in c.ok("search.global", query={"q": self.prefix, "type": "people"})["people"]:
            self.assertNotIn("email", user)

    # Premium -----------------------------------------------------------------------------------
    def test_06_premium_admin_lifecycle(self) -> None:
        admin = self.need_admin()
        self.error(self.a.api("admin.premium.grant", {"user_id": self.ids[0], "days": 30}), 403, "admin_only")
        self.assertFalse(self.a.ok("premium.status")["active"])
        self.error(self.a.api("notifications.settings", {"theme_name": "aurora"}), 402, "premium_required")
        self.error(admin.api("admin.premium.grant", {"user_id": self.ids[0], "days": 12}), 400, "invalid_duration")
        admin.ok("admin.premium.grant", {"user_id": self.ids[0], "days": 30, "note": "beta tester"})
        status = self.a.ok("premium.status")
        self.assertTrue(status["active"])
        self.assertAlmostEqual(status["ends_at"], time.time() + 30 * 86400, delta=120)
        self.assertEqual(status["upload_limit"], 200 * 1048576)
        history = admin.ok("admin.premium.grant", {"user_id": self.ids[0], "days": 7})
        self.assertAlmostEqual(history["premium"]["ends_at"], time.time() + 37 * 86400, delta=120)
        self.assertEqual([x["action"] for x in history["audit"]][:2], ["premium.extend", "premium.grant"])
        settings = self.a.ok("notifications.settings", {"theme_name": "aurora", "wallpaper": "stardust"})
        self.assertEqual(settings["effective"]["theme_name"], "aurora")
        self.assertTrue(self.b.ok("users.profile", query={"user_id": self.ids[0]})["premium"])
        admin.ok("admin.premium.revoke", {"user_id": self.ids[0]})
        after = self.a.ok("sync")["notification_settings"]
        self.assertEqual(after["theme_name"], "aurora")  # choice remembered
        self.assertEqual(after["effective"]["theme_name"], "pingup")  # but not applied
        self.assertFalse(self.a.ok("premium.status")["active"])
        admin.ok("admin.premium.grant", {"user_id": self.ids[4], "days": None})
        self.assertTrue(self.e.ok("premium.status")["forever"])
        self.error(admin.api("admin.premium.grant", {"user_id": self.ids[4], "days": 7}), 409, "premium_already_forever")

    # Uploads -----------------------------------------------------------------------------------
    def test_07_uploads_limits_formats_chunks(self) -> None:
        a = self.c
        self.error(a.api("files.upload_init", {"name": "big.zip", "size": 60 * 1048576}), 413, "file_too_large_premium")
        self.error(a.api("files.upload_init", {"name": "virus.exe", "size": 100}), 415, "file_type_forbidden")
        bad = a.upload("page.html", b"<script>alert(1)</script>", "text/html")
        self.error(bad, 415, "file_type_forbidden")
        fake_pdf = a.upload("doc.pdf", b"not a pdf at all", "application/pdf")
        self.error(fake_pdf, 415, "file_type_forbidden")
        import io, zipfile
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr("data.bin", os.urandom(3 * 1024 * 1024))
        payload = buffer.getvalue()
        abandoned = a.ok("files.upload_init", {"name": "abandoned.zip", "size": len(payload)})
        a.ok("files.upload_cancel", {"upload_id": abandoned["upload_id"]})
        self.error(a.api("files.upload_finish", {"upload_id": abandoned["upload_id"]}), 404, "upload_not_found")
        init = a.ok("files.upload_init", {"name": "archive.zip", "size": len(payload)})
        half = len(payload) // 2
        for offset, chunk in ((0, payload[:half]), (half, payload[half:])):
            response = a.request(f"api.php?action=files.upload_chunk&upload_id={init['upload_id']}&offset={offset}", method="POST", body=chunk, headers={"Content-Type": "application/octet-stream", "X-CSRF-Token": a.csrf})
            self.assertEqual(response.status, 200, response.body[:200])
        file = a.ok("files.upload_finish", {"upload_id": init["upload_id"]})
        self.assertEqual(file["size"], len(payload))
        self.assertEqual(file["kind"], "archive")
        direct = a.ok("conversations.create", {"type": "direct", "user_id": self.ids[3]})
        self.send(a, direct["id"], "", file_id=file["id"])
        ranged = self.d.request(file["url"], headers={"Range": "bytes=0-9"})
        self.assertEqual(ranged.status, 206)
        self.assertEqual(ranged.body, payload[:10])
        self.assertEqual(self.e.request(file["url"]).status, 404)
        # Albums.
        images = [a.upload(f"p{i}.png", PNG, "image/png").json()["data"]["id"] for i in range(3)]
        album = self.send(a, direct["id"], "album", file_ids=images)
        self.assertEqual(album["kind"], "album")
        self.assertEqual(len(album["files"]), 3)
        self.assertEqual(self.d.request(album["files"][2]["url"]).status, 200)

    # Feedback ----------------------------------------------------------------------------------
    def test_08_feedback_centre(self) -> None:
        admin = self.need_admin()
        a, b = self.a, self.b
        screenshot = a.upload("screen.png", PNG, "image/png", purpose="feedback").json()["data"]
        self.error(a.api("messages.send", {"conversation_id": a.ok("conversations.create", {"type": "direct", "user_id": self.ids[1]})["id"], "file_id": screenshot["id"], "client_id": "fb:" + secrets.token_hex(8)}), 404, "file_not_found")
        self.error(a.api("feedback.create", {"type": "bug", "category": "telepathy", "title": "Bad", "description": "Something broke here"}), 400, "invalid_feedback")
        ticket = a.ok("feedback.create", {"type": "bug", "category": "messages", "title": "<img src=x onerror=alert(1)>", "description": "Messages vanish after reload", "file_ids": [screenshot["id"]], "tech_consent": True, "tech_info": {"user_agent": "UA", "viewport": "390x844", "evil": "x"}})["ticket"]
        self.assertEqual(ticket["status"], "new")
        self.assertNotIn("tech_info", ticket)
        self.error(b.api("feedback.get", query={"ticket_id": ticket["id"]}), 404, "feedback_not_found")
        self.assertEqual(b.request(screenshot["url"]).status, 404)
        self.error(a.api("admin.feedback.list"), 403, "admin_only")
        listed = admin.ok("admin.feedback.list", query={"q": "#" + str(ticket["id"])})
        self.assertEqual([t["id"] for t in listed["tickets"]], [ticket["id"]])
        self.assertEqual(listed["tickets"][0]["tech_info"], {"user_agent": "UA", "viewport": "390x844"})
        self.assertEqual(admin.request(screenshot["url"]).status, 200)
        admin.ok("admin.feedback.reply", {"ticket_id": ticket["id"], "body": "internal: likely sync bug", "internal": True})
        admin.ok("admin.feedback.reply", {"ticket_id": ticket["id"], "body": "Which device do you use?", "request_info": True})
        admin.ok("admin.feedback.update", {"ticket_id": ticket["id"], "priority": "high"})
        view = a.ok("feedback.get", query={"ticket_id": ticket["id"]})
        self.assertEqual(view["ticket"]["status"], "need_info")
        bodies = [m["body"] for m in view["messages"]]
        self.assertIn("Which device do you use?", bodies)
        self.assertNotIn("internal: likely sync bug", bodies)
        self.assertNotIn("high", bodies)
        self.assertEqual(len(view["attachments"]), 1)
        events = a.ok("notifications.list", query={"after_event_id": 0})["events"]
        self.assertIn("feedback", [e["kind"] for e in events])
        a.ok("feedback.reply", {"ticket_id": ticket["id"], "body": "Android 14, PWA"})
        self.assertEqual(a.ok("feedback.get", query={"ticket_id": ticket["id"]})["ticket"]["status"], "review")
        admin.ok("admin.feedback.update", {"ticket_id": ticket["id"], "status": "closed"})
        self.error(a.api("feedback.reply", {"ticket_id": ticket["id"], "body": "more"}), 409, "feedback_closed")
        mine = a.ok("feedback.list", query={"status": "closed"})["tickets"]
        self.assertEqual([t["id"] for t in mine], [ticket["id"]])
        idea = a.ok("feedback.create", {"type": "idea", "category": "privacy", "title": "Secret chats", "description": "End-to-end encrypted chats please"})["ticket"]
        counts = admin.ok("admin.feedback.list", query={"type": "idea", "sort": "priority"})
        self.assertIn(idea["id"], [t["id"] for t in counts["tickets"]])
        self.assertGreaterEqual(counts["counts"]["ideas"], 1)

    # E-mail ------------------------------------------------------------------------------------
    def test_09_email_verify_login_recover(self) -> None:
        port = int(os.environ.get("PINGUP_TEST_SMTP_PORT", "0"))
        if not port:
            self.skipTest("SMTP sink port not configured")
        sink = SmtpSink(port)
        sink.start()
        c = self.c
        address = f"{self.prefix}.c@example.test"
        self.error(c.api("email.set", {"email": address, "password": "wrong-password"}), 403, "current_password_invalid")
        status = c.ok("email.set", {"email": address, "password": self.password})
        self.assertEqual(status["pending_email"], address)
        self.assertFalse(status["verified"])
        run_mail_worker()
        code = sink.code_for(address)
        self.error(c.api("email.verify", {"code": "000000" if code != "000000" else "111111"}), 400, "email_code_invalid")
        verified = c.ok("email.verify", {"code": code})
        self.assertTrue(verified["verified"])
        self.error(c.api("email.verify", {"code": code}), 410, "email_code_expired")  # single use
        login = Client(OPTIONS.base_url)
        login.bootstrap()
        self.assertEqual(login.ok("auth.login", {"identifier": address, "password": self.password})["user"]["id"], self.ids[2])
        guest = Client(OPTIONS.base_url)
        guest.bootstrap()
        self.assertEqual(guest.ok("auth.recover_request", {"identifier": "nobody_" + self.prefix}), {"requested": True})
        guest.ok("auth.recover_request", {"identifier": address})
        run_mail_worker()
        recovery = sink.code_for(address)
        new_password = secrets.token_urlsafe(16) + "Z9!"
        guest.ok("auth.recover_confirm", {"identifier": address, "code": recovery, "new_password": new_password})
        self.error(c.api("sync"), 401, "unauthorized")  # old sessions revoked
        c.bootstrap()
        c.ok("auth.login", {"username": f"{self.prefix}_2", "password": new_password})
        type(self).password_c = new_password

    # Communities -------------------------------------------------------------------------------
    def test_10_channel_management(self) -> None:
        a, b, c, d = self.a, self.b, self.c, self.d
        slug = "ch" + secrets.token_hex(4)
        channel = a.ok("conversations.create", {"type": "channel", "name": "News " + slug, "visibility": "public", "slug": slug, "settings": {"preset": "dark_neon", "accent": "#ff00aa", "comments_enabled": True, "tagline": "Daily"}})
        self.assertEqual(channel["settings"]["preset"], "dark_neon")
        self.assertEqual(channel["role"], "owner")
        self.error(a.api("channels.update", {"conversation_id": channel["id"], "settings": {"accent": "red"}}), 400, "invalid_color")
        self.error(a.api("channels.update", {"conversation_id": channel["id"], "settings": {"unknown": 1}}), 400, "invalid_settings")
        for client in (b, c, d):
            client.ok("channels.join", {"slug": slug})
        reader = self.conversation(b, channel["id"])
        self.assertEqual({p["id"] for p in reader["participants"]}, {self.ids[0], self.ids[1]})  # subscribers hidden
        self.error(b.api("channels.update", {"conversation_id": channel["id"], "name": "Hacked"}), 403, "channel_owner_only")
        self.error(b.api("channels.members", query={"conversation_id": channel["id"]}), 403, "channel_owner_only")
        a.ok("channels.set_role", {"conversation_id": channel["id"], "user_id": self.ids[1], "role": "admin", "permissions": {"change_info": False, "ban": True}})
        post = self.send(b, channel["id"], "Admin post")
        self.error(b.api("channels.update", {"conversation_id": channel["id"], "name": "Renamed"}), 403, "channel_owner_only")
        self.error(c.api("messages.send", {"conversation_id": channel["id"], "text": "reader post", "client_id": "rd:" + secrets.token_hex(8)}), 403, "posting_forbidden")
        comment = self.send(c, channel["id"], "Nice post", thread_root_id=post["id"])
        thread = d.ok("messages.thread", query={"message_id": post["id"]})
        self.assertEqual([m["id"] for m in thread["comments"]], [comment["id"]])
        feed = d.ok("messages.list", query={"conversation_id": channel["id"]})["messages"]
        self.assertNotIn(comment["id"], [m["id"] for m in feed])
        self.assertEqual(next(m for m in feed if m["id"] == post["id"])["comment_count"], 1)
        d.ok("conversations.read", {"conversation_id": channel["id"], "last_message_id": post["id"]})
        c.ok("conversations.read", {"conversation_id": channel["id"], "last_message_id": post["id"]})
        c.ok("conversations.read", {"conversation_id": channel["id"], "last_message_id": post["id"]})  # no double count
        views = next(m for m in a.ok("messages.list", query={"conversation_id": channel["id"]})["messages"] if m["id"] == post["id"])["views"]
        self.assertEqual(views, 2)
        b.ok("channels.ban", {"conversation_id": channel["id"], "user_id": self.ids[3], "reason": "spam"})
        self.error(d.api("channels.join", {"slug": slug}), 403, "community_banned")
        invites = a.ok("channels.invite_create", {"conversation_id": channel["id"], "name": "one-shot", "max_uses": 1})
        token = invites["invites"][0]["token"]
        # Opening a link only previews: no membership, no invite use, ban visible to the banned user.
        preview = self.e.ok("channels.preview", query={"invite_token": token})
        self.assertEqual((preview["id"], preview["joined"], preview["banned"]), (channel["id"], False, False))
        self.assertTrue(d.ok("channels.preview", query={"slug": slug})["banned"])
        self.assertNotIn(channel["id"], [x["id"] for x in self.e.ok("conversations.list")])
        self.e.ok("channels.preview", query={"invite_token": token})  # previews never consume max_uses
        self.error(self.e.api("channels.preview", query={"invite_token": "x" * 20}), 404, "channel_not_found")
        self.e.ok("channels.join", {"invite_token": token})
        self.e.ok("channels.leave", {"conversation_id": channel["id"]})
        self.error(self.e.api("channels.join", {"invite_token": token}), 410, "invite_expired")
        stats = a.ok("channels.stats", query={"conversation_id": channel["id"], "days": 7})
        self.assertEqual(len(stats["series"]), 7)
        self.assertGreaterEqual(stats["totals"]["joins"], 4)
        self.assertGreaterEqual(stats["totals"]["views"], 2)
        self.assertEqual(stats["totals"]["comments"], 1)
        audit = [e["action"] for e in a.ok("channels.audit", query={"conversation_id": channel["id"]})["entries"]]
        self.assertIn("member.ban", audit)
        self.assertIn("role.admin", audit)
        self.error(a.api("channels.transfer", {"conversation_id": channel["id"], "user_id": self.ids[1], "password": "nope"}), 403, "current_password_invalid")
        a.ok("channels.transfer", {"conversation_id": channel["id"], "user_id": self.ids[1], "password": self.password})
        self.assertEqual(self.conversation(b, channel["id"])["role"], "owner")
        b.ok("channels.archive", {"conversation_id": channel["id"], "archived": True})
        self.error(b.api("messages.send", {"conversation_id": channel["id"], "text": "late", "client_id": "ar:" + secrets.token_hex(8)}), 403, "community_archived")
        self.error(b.api("channels.delete", {"conversation_id": channel["id"], "password": self.password, "confirm_name": "wrong"}), 400, "confirm_name_mismatch")
        b.ok("channels.delete", {"conversation_id": channel["id"], "password": self.password, "confirm_name": "News " + slug})
        self.error(c.api("messages.list", query={"conversation_id": channel["id"]}), 404, "conversation_not_found")

    # Messages ----------------------------------------------------------------------------------
    def test_11_message_features(self) -> None:
        a, b = self.a, self.b
        group = a.ok("conversations.create", {"type": "group", "name": "Features " + self.prefix, "user_ids": [self.ids[1]]})
        message = self.send(a, group["id"], "React to me")
        for emoji in ("🦄", "👍🏽", "🇺🇦"):
            b.ok("messages.react", {"message_id": message["id"], "emoji": emoji})
        self.error(b.api("messages.react", {"message_id": message["id"], "emoji": "😀"}), 409, "reaction_limit")
        self.error(b.api("messages.react", {"message_id": message["id"], "emoji": "abc"}), 400, "invalid_emoji")
        reactors = a.ok("messages.reactors", query={"message_id": message["id"]})["reactors"]
        self.assertEqual(len(reactors), 3)
        poll = self.send(a, group["id"], "", poll={"question": "Lunch?", "options": ["Pizza", "Sushi"], "multiple": False, "anonymous": False})
        option = poll["poll"]["options"][1]["id"]
        voted = b.ok("polls.vote", {"message_id": poll["id"], "option_ids": [option]})
        self.assertEqual(voted["poll"]["options"][1]["votes"], 1)
        self.assertTrue(voted["poll"]["options"][1]["mine"])
        self.error(b.api("polls.vote", {"message_id": poll["id"], "option_ids": [poll["poll"]["options"][0]["id"], option]}), 400, "invalid_poll_vote")
        self.assertEqual(len(a.ok("polls.voters", query={"message_id": poll["id"]})["voters"]), 1)
        a.ok("polls.close", {"message_id": poll["id"]})
        self.error(b.api("polls.vote", {"message_id": poll["id"], "option_ids": []}), 409, "poll_closed")
        b.ok("messages.star", {"message_id": message["id"], "starred": True})
        self.assertEqual([m["id"] for m in b.ok("messages.starred")["messages"]], [message["id"]])
        packs = a.ok("stickers.packs")["packs"]
        sticker = packs[0]["stickers"][0]
        sent = self.send(a, group["id"], "", sticker_id=sticker["id"])
        self.assertEqual(sent["sticker"]["url"], sticker["url"])
        scheduled = a.ok("messages.send", {"conversation_id": group["id"], "text": "later", "client_id": "sc:" + secrets.token_hex(8), "send_at": int(time.time()) + 3600})["scheduled"]
        self.assertEqual([s["id"] for s in a.ok("messages.scheduled", query={"conversation_id": group["id"]})["scheduled"]], [scheduled["id"]])
        self.error(a.api("messages.send", {"conversation_id": group["id"], "text": "past", "client_id": "sc:" + secrets.token_hex(8), "send_at": int(time.time()) - 5}), 400, "invalid_schedule")
        now = a.ok("messages.scheduled_now", {"id": scheduled["id"]})
        self.assertEqual(now["status"], "sent")
        texts = [m["text"] for m in b.ok("messages.list", query={"conversation_id": group["id"]})["messages"]]
        self.assertIn("later", texts)
        a.ok("conversations.draft", {"conversation_id": group["id"], "text": "unsent thought"})
        self.assertEqual(self.conversation(a, group["id"])["draft"], "unsent thought")
        a.ok("conversations.archive", {"conversation_id": group["id"], "archived": True})
        self.assertTrue(self.conversation(a, group["id"])["archived"])
        folders = a.ok("folders.save", {"name": "Work", "types": ["group"], "conversation_ids": [group["id"]]})["folders"]
        self.assertEqual(folders[0]["name"], "Work")
        self.error(a.api("folders.save", {"name": "Bad", "conversation_ids": [999999999]}), 400, "invalid_folder")
        bulk = [self.send(b, group["id"], f"bulk {i}")["id"] for i in range(3)]
        self.error(b.api("messages.delete_many", {"message_ids": bulk + [message["id"]], "scope": "everyone"}), 403, "delete_forbidden")  # all-or-nothing
        b.ok("messages.delete_many", {"message_ids": bulk, "scope": "everyone"})
        remaining = {m["id"] for m in a.ok("messages.list", query={"conversation_id": group["id"]})["messages"] if not m["deleted"]}
        self.assertFalse(remaining & set(bulk))
        forwarded = a.ok("messages.forward_many", {"message_ids": [message["id"]], "conversation_id": group["id"], "client_id": "fw:" + secrets.token_hex(8)})["messages"]
        self.assertTrue(forwarded[0]["forwarded"])
        self.assertEqual(forwarded[0]["forward"]["type"], "user")
        typing = b.ok("typing.set", {"conversation_id": group["id"], "kind": "recording"})
        self.assertTrue(typing["typing"])
        self.assertEqual(a.ok("sync", query={"conversation_id": group["id"]})["typing"][0]["kind"], "recording")


def main() -> int:
    global OPTIONS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--invite-code", default=os.environ.get("PINGUP_TEST_INVITE_CODE", ""))
    OPTIONS, unittest_args = parser.parse_known_args()
    parsed = urllib.parse.urlsplit(OPTIONS.base_url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Tests create persistent data; use an isolated loopback server")
    program = unittest.main(argv=[sys.argv[0], *unittest_args], exit=False, verbosity=2)
    return 0 if program.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

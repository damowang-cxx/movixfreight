"""Offline tests: no production network calls and no real credentials."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

import test_open_api as api


def reply(shipment):
    return {"status": 1, "data": {"shipment": shipment}}


class Response(io.BytesIO):
    def __init__(self, data, code=200):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.code = code


class OpenApiTests(unittest.TestCase):
    def test_https_and_no_redirect(self):
        self.assertEqual(api.base_url("https://movixfreight.com/"), "https://movixfreight.com")
        for url in ("http://example.com", "https://user:pass@example.com", "https://example.com/api"):
            with self.assertRaises(api.TestError):
                api.base_url(url)
        self.assertIsNone(api.NoRedirect().redirect_request(None, None, 302, None, None, "https://other.example"))

    def test_template_rejected(self):
        body = json.loads(api.TEMPLATE.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(api.TestError, "占位"):
            api.validate_input(body)

    def test_creation_contract(self):
        opener = Mock()
        opener.open.return_value = Response(reply({"shipment_id": "ORD-1"}), 202)
        client = api.Client("https://example.com", "fake-key", opener)
        body = {"shipment": {"service": "UPS_STANDARD", "to_address": {"country": "荷兰"}}}
        self.assertEqual(client.request(api.PREFIX, body, "idem-1")["data"]["shipment"]["shipment_id"], "ORD-1")
        req = opener.open.call_args.args[0]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("X-api-key"), "fake-key")
        self.assertEqual(req.get_header("Idempotency-key"), "idem-1")
        self.assertEqual(json.loads(req.data), body)
        self.assertEqual(opener.open.call_count, 1)

    def test_ambiguous_create_not_retried(self):
        opener = Mock()
        opener.open.side_effect = URLError("timeout")
        client = api.Client("https://example.com", "fake-key", opener)
        with self.assertRaisesRegex(api.TestError, "可能已经受理"):
            client.request(api.PREFIX, body={}, idempotency_key="original")
        self.assertEqual(opener.open.call_count, 1)

    def test_errors_redacted_and_pdf_not_faked(self):
        opener = Mock()
        opener.open.side_effect = HTTPError("https://example.com", 401, "Unauthorized", {}, io.BytesIO(b'{"status":0,"info":{"message":"fake-key"}}'))
        client = api.Client("https://example.com", "fake-key", opener)
        with self.assertRaises(api.TestError) as ctx:
            client.request(api.PREFIX + "/ORD-1/label")
        self.assertNotIn("fake-key", str(ctx.exception))
        self.assertIn("401", str(ctx.exception))
        opener.open.side_effect = None
        opener.open.return_value = Response({"status": 0, "info": {"message": "Not ready"}}, 409)
        with self.assertRaisesRegex(api.TestError, "409.*Not ready"):
            client.request(api.PREFIX + "/ORD-1/label/download", pdf=True)

    def test_cross_origin_denied(self):
        opener = Mock()
        client = api.Client("https://example.com", "fake-key", opener)
        with self.assertRaises(api.TestError):
            client.request("//evil.example/api/open/v1/shipments")
        opener.open.assert_not_called()

    def test_monitor_pending_ready(self):
        client = Mock()
        client.request.side_effect = [reply({"label_status": "PENDING"}), reply({"label_status": "READY", "labels": [{"label_id": "a"}, {"label_id": "b"}]})]
        sleep = Mock()
        result = api.monitor(client, "ORD-1", wait=True, sleep=sleep)
        self.assertEqual(len(result["labels"]), 2)
        self.assertEqual(client.request.call_count, 2)
        sleep.assert_called_once_with(5)

    def test_terminal_states_stop(self):
        for state in ("FAILED", "UNKNOWN", "STALLED", "BLOCKED", "CANCELLED"):
            client = Mock()
            client.request.return_value = reply({"label_status": "PENDING", "dispatch": {"status": state}})
            with self.assertRaises(api.TestError):
                api.monitor(client, "ORD-1", wait=True)
            self.assertEqual(client.request.call_count, 1)

    def test_poll_bounded(self):
        client = Mock()
        client.request.return_value = reply({"label_status": "PENDING"})
        self.assertIsNone(api.monitor(client, "ORD-1"))
        self.assertEqual(client.request.call_count, 1)
        with self.assertRaisesRegex(api.TestError, "停止轮询"):
            api.monitor(client, "ORD-1", wait=True, sleep=Mock(), max_polls=2)
        self.assertEqual(client.request.call_count, 3)

    def test_multibox_download_uses_ids_not_server_urls(self):
        opener = Mock()
        opener.open.side_effect = [Response(b"%PDF-1.4\nfirst"), Response(b"%PDF-1.4\nsecond")]
        client = api.Client("https://example.com", "fake-key", opener)
        with tempfile.TemporaryDirectory() as folder:
            api.download_labels(client, "ORD-1", {"labels": [
                {"label_id": "label/a", "download_url": "https://evil.example"},
                {"label_id": "label-b"},
            ]}, Path(folder))
            self.assertEqual((Path(folder) / "label-001.pdf").read_bytes(), b"%PDF-1.4\nfirst")
            self.assertEqual((Path(folder) / "label-002.pdf").read_bytes(), b"%PDF-1.4\nsecond")
        self.assertIn("label_id=label%2Fa", opener.open.call_args_list[0].args[0].full_url)

    def test_decline_creation_sends_nothing(self):
        body = {"shipment": {"service": "EXAMPLE", "to_address": {"country": "NL"}, "parcel_count": 1}}
        with patch.object(Path, "read_text", return_value=json.dumps(body)), patch.object(api, "validate_input"), patch.object(api.sys.stdin, "isatty", return_value=True), patch("builtins.input", return_value="NO"), patch.object(api, "Client") as client:
            with self.assertRaisesRegex(api.TestError, "已取消"):
                api.main(["--create", "--file", "unused.json", "--idempotency-key", "unique"])
            client.assert_not_called()

    def test_init_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, "OUTPUT", Path(folder)), patch.object(api, "Client") as client:
            api.main(["--init"])
            first = (Path(folder) / "request.json").read_bytes()
            with self.assertRaisesRegex(api.TestError, "不覆盖"):
                api.main(["--init"])
            self.assertEqual((Path(folder) / "request.json").read_bytes(), first)
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()

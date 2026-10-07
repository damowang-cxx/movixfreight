#!/usr/bin/env python3
"""Windows/local Open API tester. Python 3.10+, standard library only."""
import argparse
import getpass
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4
import warnings

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "tmp" / "open-api-test"
TEMPLATE = Path(__file__).with_name("open-api-request.example.json")
PREFIX = "/api/open/v1/shipments"


class TestError(Exception):
    """A safe, user-readable failure; no raw request headers or credentials."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a customer key to a redirect target, even same-host.
        return None


def base_url(value):
    u = urlsplit(value)
    if (u.username or u.password or u.query or u.fragment or u.path not in ("", "/")
            or not u.hostname):
        raise TestError("站点必须是根地址，不含账号、路径或查询参数")
    if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
        raise TestError("线上接口必须使用 HTTPS；HTTP 仅限本机")
    return f"{u.scheme}://{u.netloc}"


def validate_input(body):
    if re.search(r"__REPLACE_[A-Z_]+__", json.dumps(body)):
        raise TestError("请替换请求模板中所有 __REPLACE_...__ 占位内容")
    s = body.get("shipment") if isinstance(body, dict) else None
    if not isinstance(s, dict) or not s.get("service") or "supplier" in s:
        raise TestError("需要 shipment.service（对外服务代码），不能传入内部 supplier 字段")
    a = s.get("to_address")
    if (not isinstance(a, dict) or not all(a.get(k) for k in ("name", "city", "country", "postcode"))
            or not any(a.get(k) for k in ("address_1", "address_2", "address_3"))
            or not (a.get("tel") or a.get("mobile"))):
        raise TestError("请填写完整的实际收件地址、姓名、城市、国家、邮编和电话/手机")
    parcels = s.get("parcels")
    if not isinstance(parcels, list) or not parcels or type(s.get("parcel_count")) is not int or s["parcel_count"] != len(parcels):
        raise TestError("parcel_count 必须等于 parcels 实际箱数")
    for p in parcels:
        if not isinstance(p, dict):
            raise TestError("每箱必须是 JSON 对象")
        for field in ("client_weight", "client_length", "client_width", "client_height"):
            value = p.get(field)
            if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                raise TestError(f"{field} 必须填写实际的正数（kg/cm）")
        if not isinstance(p.get("declarations"), list) or not p["declarations"]:
            raise TestError("每箱至少需要一条申报明细")
        # Remove unused optional properties, rather than sending null numeric values.
        for item in p["declarations"]:
            if not isinstance(item, dict):
                raise TestError("申报明细必须是 JSON 对象")
            for field in ("weight", "length", "width", "height", "quantity", "unit_price"):
                if field in item and (type(item[field]) not in (int, float) or not math.isfinite(item[field])):
                    raise TestError(f"申报 {field} 必须填写实际数值；不使用的可选字段请删除")
    # Country routes, current declaration settings, prices and balance are server-authoritative.


class Client:
    def __init__(self, base, key, opener=None):
        self.base = base_url(base)
        self.key = key
        self.opener = opener or build_opener(NoRedirect())

    def redact(self, value):
        return str(value).replace(self.key, "[REDACTED]")

    def request(self, path, body=None, idempotency_key=None, pdf=False):
        if not path.startswith("/api/open/v1/") or urlsplit(path).netloc:
            raise TestError("禁止向其他站点发送 API Key")
        headers = {"X-API-Key": self.key, "Accept": "application/pdf" if pdf else "application/json"}
        payload = None
        if body is not None:
            headers.update({"Content-Type": "application/json", "Idempotency-Key": idempotency_key})
            payload = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        req = Request(self.base + path, data=payload, headers=headers, method="POST" if body is not None else "GET")
        try:
            try:
                response = self.opener.open(req, timeout=30)
            except HTTPError as error:
                response = error
            with response:
                status, content = response.code, response.read()
        except (URLError, TimeoutError, OSError, HTTPException):
            message = ("创建请求网络失败/超时，可能已经受理！不要更换幂等键或自动重发；请先核查后台，保留原请求体与原键。"
                       if body is not None else "查询/下载网络失败，可以重新查询同一订单。")
            raise TestError(message) from None
        if pdf and 200 <= status < 300 and content.startswith(b"%PDF-"):
            return content
        try:
            data = json.loads(content)
        except (ValueError, UnicodeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        if not 200 <= status < 300 or data.get("status") != 1 or pdf:
            info = data.get("info") if isinstance(data.get("info"), dict) else {}
            detail = info.get("message") or data.get("message") or ("不是 PDF，未保存文件" if pdf else "非预期 Open API JSON 响应")
            if isinstance(detail, list):
                detail = "；".join(map(str, detail))
            caution = ""
            if 300 <= status < 400:
                caution = "；已阻止重定向，请核对站点域名"
            if body is not None and (status >= 500 or 200 <= status < 400):
                caution += "；受理结果待核查，不要换新幂等键重发"
            raise TestError(self.redact(f"HTTP {status} {info.get('code', '')}：{detail}{caution}"))
        return json.loads(self.redact(json.dumps(data, ensure_ascii=False)))


def monitor(client, shipment_id, wait=False, save=None, sleep=time.sleep, max_polls=120):
    path = f"{PREFIX}/{quote(shipment_id, safe='')}/label"
    for i in range(max_polls if wait else 1):
        result = client.request(path)
        if save:
            save("status.json", result)
        s = result.get("data", {}).get("shipment", {})
        if not isinstance(s, dict) or not s.get("label_status"):
            raise TestError("状态响应缺少 data.shipment.label_status")
        dispatch = s.get("dispatch") or {}
        print(f"{shipment_id} | {s['label_status']} / {dispatch.get('status', '')} | {dispatch.get('message') or s.get('label_status_message', '')}")
        if s.get("transfer_number"):
            print(f"转单号：{s['transfer_number']}")
        if s["label_status"] in ("FAILED", "UNKNOWN") or dispatch.get("status") in ("FAILED", "UNKNOWN", "STALLED", "BLOCKED", "CANCELLED"):
            raise TestError(f"停止轮询：{dispatch.get('reasonCode', '')} {s.get('failure_reason') or dispatch.get('message') or s.get('label_status_message', '')}。请核查后台，不要重新下单。")
        if s["label_status"] == "READY":
            return s
        if wait and i < max_polls - 1:
            sleep(5)
    if wait:
        raise TestError("等待约 10 分钟仍未完成，停止轮询；可以查询原订单，不要重新下单")
    return None


def download_labels(client, shipment_id, shipment, directory):
    labels = shipment.get("labels")
    if not labels:
        raise TestError("READY 但没有标签列表，请核查后台")
    for i, label in enumerate(labels, 1):
        if not label.get("label_id"):
            raise TestError("标签缺少 label_id")
        path = f"{PREFIX}/{quote(shipment_id, safe='')}/label/download?label_id={quote(label['label_id'], safe='')}"
        content = client.request(path, pdf=True)
        filename = directory / f"label-{i:03d}.pdf"
        with filename.open("xb") as handle:
            handle.write(content)
        print(f"已下载 {filename.name} | 箱号 {label.get('box_no') or '—'} | 转单号 {label.get('tracking_number') or '—'}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Windows 本地 Python 调用 Movix 线上接口；不需要 Node.js 或 pip 安装依赖")
    parser.add_argument("--base", default="https://movixfreight.com", help="站点根地址，默认线上系统")
    parser.add_argument("--init", action="store_true", help="仅初始化本地请求模板，不发送请求")
    parser.add_argument("--create", action="store_true", help="提交真实运单，需要输入 CREATE 确认")
    parser.add_argument("--file", type=Path, help="实际请求 JSON 文件")
    parser.add_argument("--idempotency-key", help="客户自定义唯一请求键；原请求重试必须保持不变")
    parser.add_argument("--shipment", help="已有系统订单号 ORD-…，不是转单号")
    parser.add_argument("--wait", action="store_true", help="每 5 秒查询，最多约 10 分钟")
    parser.add_argument("--download", action="store_true", help="就绪后下载全部逐箱 PDF")
    args = parser.parse_args(argv)
    base = base_url(args.base)
    if args.init:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        destination = OUTPUT / "request.json"
        try:
            with destination.open("xb") as handle:
                handle.write(TEMPLATE.read_bytes())
        except FileExistsError:
            raise TestError(f"模板已经存在，不覆盖：{destination}") from None
        print(f"已生成：{destination}\n请填写实际资料并替换全部占位符和空数值；未调用线上接口。")
        return
    body = None
    if args.create:
        key = args.idempotency_key or ""
        if not args.file or not key or len(key) > 256 or not re.fullmatch(r"[!-~]+", key):
            raise TestError("创建需要 --file 和 --idempotency-key（1–256 个无空格 ASCII 字符）")
        body = json.loads(args.file.read_text(encoding="utf-8-sig"))
        validate_input(body)
        s = body["shipment"]
        print(f"站点：{base}\n服务：{s['service']}\n目的国：{s['to_address']['country']}\n箱数：{s['parcel_count']}\n幂等键：{key}\n警告：这不是试算，会真实预扣并创建运单。请确认 JSON 内全部实际资料。")
        if not sys.stdin.isatty():
            raise TestError("创建必须在交互终端人工确认，不支持无人值守创建")
        if input("确认提交请输入 CREATE，其他输入取消：") != "CREATE":
            raise TestError("已取消，未发送请求")
    elif not args.shipment or not args.shipment.startswith("ORD-"):
        raise TestError("请用 --shipment ORD-系统订单号查询，或使用 --init / --create；详见 --help")
    api_key = os.environ.get("MOVIX_API_KEY", "").strip()
    if not api_key:
        # Refuse getpass's fallback to an echoed input stream.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            api_key = getpass.getpass("客户 API Key（隐藏输入，粘贴后回车）：").strip()
    if not re.fullmatch(r"mvx_[a-fA-F0-9]+\.[A-Za-z0-9_-]+", api_key):
        raise TestError("客户 API Key 格式错误，前面不要加 Bearer")
    client = Client(base, api_key)
    directory = OUTPUT / f"python-{int(time.time())}-{uuid4().hex[:8]}"
    directory.mkdir(parents=True, mode=0o700)
    print(f"结果目录：{directory}（含个人信息，请勿分享或提交 Git）")

    def save(name, value):
        text = client.redact(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
        with (directory / name).open("w", encoding="utf-8") as handle:
            handle.write(text)

    try:
        shipment_id = args.shipment
        if body is not None:
            # Persist before the only POST, for safe recovery after interruption.
            save("request.json", body)
            save("request-meta.json", {"base": base, "idempotencyKey": args.idempotency_key, "createdAt": time.time()})
            result = client.request(PREFIX, body=body, idempotency_key=args.idempotency_key)
            save("accepted.json", result)
            shipment_id = result.get("data", {}).get("shipment", {}).get("shipment_id")
            if not shipment_id or not shipment_id.startswith("ORD-"):
                raise TestError("创建响应缺少订单号，结果待核查，不要更换幂等键重发")
            print(f"已受理：{shipment_id}，等待面单生成。")
        shipment = monitor(client, shipment_id, wait=args.wait, save=save)
        if args.download and shipment:
            download_labels(client, shipment_id, shipment, directory)
        elif args.download:
            print("尚未生成面单。请使用相同订单号加 --wait --download 再查询。")
    except TestError as error:
        save("error.json", {"message": str(error), "time": time.time()})
        raise


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\n已中止。如已发送创建请求，请核查原订单/幂等键，不要直接重新下单。", file=sys.stderr)
        sys.exit(1)
    except getpass.GetPassWarning:
        print("当前终端不支持隐藏输入，请在 Windows PowerShell/CMD 中运行。", file=sys.stderr)
        sys.exit(1)
    except (TestError, OSError, ValueError) as error:
        print(f"错误：{error}", file=sys.stderr)
        sys.exit(1)

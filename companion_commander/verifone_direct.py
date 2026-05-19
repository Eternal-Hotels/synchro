from __future__ import annotations

from dataclasses import dataclass
import http.client
import pathlib
import ssl
from typing import Callable
from urllib.parse import urlencode, urlparse
import xml.etree.ElementTree as ET

try:
    from lxml import etree
except ImportError:
    etree = None


DEFAULT_TIMEOUT_SECONDS = 100
CGI_PATH = "/cgi-bin/CGILink"


class VerifoneDirectError(RuntimeError):
    pass


StatusCallback = Callable[[str], None]


@dataclass(frozen=True)
class ReportPair:
    pair_name: str
    parameter_type: str
    parameter_name: str


@dataclass(frozen=True)
class ReportTransform:
    url: str
    extension: str


@dataclass(frozen=True)
class ReportDefinition:
    display_name: str
    period_list_name: str
    pairs: tuple[ReportPair, ...]
    transforms: tuple[ReportTransform, ...]
    group_name: str = ""


@dataclass(frozen=True)
class PeriodMetadata:
    index: int
    name: str
    filename: str
    period: int = 0
    reg_number: int = 0
    cashier_number: int = 0


def _local_name(tag):
    text = str(tag or "")
    return text.split("}", 1)[-1]


def _iter_named(node, name):
    for child in node.iter():
        if _local_name(child.tag) == name:
            yield child


def _find_first(node, name):
    for child in _iter_named(node, name):
        return child
    return None


def _find_text(node, name, default=""):
    child = _find_first(node, name)
    if child is None or child.text is None:
        return default
    return child.text.strip()


def _find_report_parameter(node, parameter_name, default=""):
    wanted = str(parameter_name or "").strip().casefold()
    for parameters in _iter_named(node, "reportParameters"):
        for child in list(parameters):
            if _local_name(child.tag) != "reportParameter":
                continue
            current = str(child.attrib.get("name") or "").strip().casefold()
            if current == wanted:
                return str(child.text or "").strip()
    return default


def _as_bool(value):
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


def _as_int(value, default=0):
    try:
        return int(str(value or "").strip())
    except (TypeError, ValueError):
        return default


def _parse_xml(raw_xml, label):
    try:
        return ET.fromstring(raw_xml)
    except ET.ParseError as exc:
        raise VerifoneDirectError(f"Invalid XML returned for {label}: {exc}") from exc


def _extract_fault_message(root):
    fault = _find_first(root, "Fault")
    if fault is None:
        return ""

    parts = []
    for node in fault.iter():
        if node is fault:
            continue
        text = str(node.text or "").strip()
        if text:
            parts.append(text)

    if parts:
        return " | ".join(parts)
    return "The site controller returned a fault response."


def _normalize_report_lookup(name):
    normalized = str(name or "").strip().casefold()
    aliases = {
        "": "",
        "daily": "daily sales",
        "daily sales": "daily sales",
        "monthly": "monthly report",
        "monthly report": "monthly report"
    }
    return aliases.get(normalized, normalized)


class VerifoneCommanderSession:
    def __init__(
        self,
        host,
        username,
        password,
        assets_base_dir,
        cache_dir,
        timeout_seconds=DEFAULT_TIMEOUT_SECONDS
    ):
        parsed = urlparse(host if "://" in str(host or "") else f"https://{host}")
        self.host = parsed.hostname or str(host or "").strip()
        self.port = parsed.port or 443
        self.username = str(username or "").strip()
        self.password = str(password or "")
        self.assets_base_dir = pathlib.Path(assets_base_dir).resolve()
        self.cache_dir = pathlib.Path(cache_dir).resolve()
        self.timeout_seconds = timeout_seconds
        self.cookie = ""
        self.site = ""
        self._report_catalog = None
        self._ssl_context = ssl._create_unverified_context()

    def login(self, status_callback=None):
        if status_callback:
            status_callback(f"Connecting directly to Verifone Commander at {self.host}...")

        raw_xml = self._request(
            [
                ("cmd", "validate"),
                ("user", self.username),
                ("passwd", self.password)
            ],
            label="validate"
        )
        root = _parse_xml(raw_xml, "validate")
        fault_message = _extract_fault_message(root)
        if fault_message:
            raise VerifoneDirectError(fault_message)

        cookie = _find_text(root, "cookie")
        if not cookie:
            raise VerifoneDirectError("Login did not return a session cookie.")
        self.cookie = cookie
        self.site = _find_text(root, "site")

        passwd_node = _find_first(root, "passwd")
        if passwd_node is not None:
            days_remaining = _as_int(passwd_node.attrib.get("days"), default=1)
            if _as_bool(passwd_node.attrib.get("expire")) and days_remaining <= 0:
                raise VerifoneDirectError(
                    "Password is expired and must be changed interactively before automation can run."
                )

        if status_callback:
            status_callback("Verifone direct session established.")

    def export_report(self, report_name, export_path, prefer_previous=False, period_name=None, status_callback=None):
        report_definition = self._resolve_report_definition(report_name)
        period = self._select_period(report_definition, prefer_previous, period_name)

        if status_callback:
            status_callback(
                f'Selected period "{period.name}" for {report_definition.display_name}. '
                f'Controller filename is "{period.filename}".'
            )

        query_pairs = self._build_report_query_pairs(report_definition, period)
        raw_xml = self._request(query_pairs, label=report_definition.display_name)
        root = _parse_xml(raw_xml, report_definition.display_name)
        fault_message = _extract_fault_message(root)
        if fault_message:
            raise VerifoneDirectError(fault_message)

        output_bytes = self._render_report(root, report_definition)
        export_target = pathlib.Path(export_path)
        export_target.parent.mkdir(parents=True, exist_ok=True)
        export_target.write_bytes(output_bytes)
        return export_target

    def _request(self, query_pairs, label):
        pairs = list(query_pairs)
        if self.cookie and not any(name.casefold() == "cookie" for name, _ in pairs):
            pairs.append(("cookie", self.cookie))

        encoded_query = urlencode(pairs)
        path = CGI_PATH if not encoded_query else f"{CGI_PATH}?{encoded_query}"
        connection = http.client.HTTPSConnection(
            self.host,
            self.port,
            timeout=self.timeout_seconds,
            context=self._ssl_context
        )
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            payload = response.read()
        except OSError as exc:
            raise VerifoneDirectError(f"HTTPS request for {label} failed: {exc}") from exc
        finally:
            connection.close()

        if not (200 <= response.status < 300):
            raise VerifoneDirectError(
                f"Site controller returned HTTP {response.status} {response.reason} for {label}."
            )

        return payload.decode("utf-8", errors="replace")

    def _report_catalog_entries(self):
        if self._report_catalog is not None:
            return self._report_catalog

        root = _parse_xml(self._request([("cmd", "vreportlist")], label="vreportlist"), "vreportlist")
        fault_message = _extract_fault_message(root)
        if fault_message:
            raise VerifoneDirectError(fault_message)

        catalog = {}
        for report_node in _iter_named(root, "report"):
            display_name = _find_text(report_node, "reportName")
            period_list_name = _find_text(report_node, "reportPeriod")
            if not display_name or not period_list_name:
                continue

            pairs = []
            period_key = period_list_name.casefold()
            reptname = _find_report_parameter(report_node, "reptname")
            if period_key in {"vperiodpdlist", "vtlogpdlist", "vpayrollpdlist"} and reptname:
                pairs.append(ReportPair("reptname", "constant", reptname))
            elif period_key == "vreportpdlist":
                pairs.append(ReportPair("reptname", "constant", reptname))
            elif period_key == "vcashierpdlist":
                pairs.append(ReportPair("regNum", "variable", "regNum"))
                pairs.append(ReportPair("cashierNum", "variable", "cashierNum"))
            elif period_key == "vattendantpdlist":
                pairs.append(ReportPair("cashierNum", "variable", "cashierNum"))

            report_cmd = _find_text(report_node, "reportCMD")
            if report_cmd:
                pairs.append(ReportPair("cmd", "constant", report_cmd))
            pairs.extend(
                [
                    ReportPair("cookie", "variable", "cookie"),
                    ReportPair("period", "variable", "period"),
                    ReportPair("filename", "variable", "filename")
                ]
            )

            transforms = []
            for cooking in _iter_named(report_node, "reportCooking"):
                cooking_step = _find_text(cooking, "cookingStep")
                transforms.append(ReportTransform(cooking_step.lstrip("/"), "xml"))
            for html_node in _iter_named(report_node, "reportHTML"):
                transforms.append(ReportTransform(str(html_node.text or "").strip().lstrip("/"), "html"))

            catalog[display_name.casefold()] = ReportDefinition(
                display_name=display_name,
                period_list_name=period_list_name,
                pairs=tuple(pair for pair in pairs if pair.parameter_name),
                transforms=tuple(transform for transform in transforms if transform.url),
                group_name=_find_text(report_node, "reportGroup")
            )

        self._report_catalog = catalog
        return self._report_catalog

    def _resolve_report_definition(self, report_name):
        catalog = self._report_catalog_entries()
        wanted = _normalize_report_lookup(report_name)
        if wanted and wanted in catalog:
            return catalog[wanted]

        raw_wanted = str(report_name or "").strip().casefold()
        if raw_wanted in catalog:
            return catalog[raw_wanted]

        for report_definition in catalog.values():
            if report_definition.group_name.strip().casefold() == wanted:
                return report_definition

        available = ", ".join(sorted(report.display_name for report in catalog.values())[:10])
        raise VerifoneDirectError(
            f'Could not find a Verifone report definition for "{report_name}". '
            f"Available reports include: {available}"
        )

    def _select_period(self, report_definition, prefer_previous, period_name):
        root = _parse_xml(
            self._request([("cmd", report_definition.period_list_name)], label=report_definition.period_list_name),
            report_definition.period_list_name
        )
        fault_message = _extract_fault_message(root)
        if fault_message:
            raise VerifoneDirectError(fault_message)

        entries = [node for node in _iter_named(root, "periodInfo")]
        if not entries:
            raise VerifoneDirectError(
                f"The site controller returned no periods for {report_definition.period_list_name}."
            )

        selected_index = 0
        wanted_name = str(period_name or "").strip().casefold()
        if wanted_name:
            for index, entry in enumerate(entries):
                description = _find_text(entry, "desc").casefold()
                if description == wanted_name:
                    selected_index = index
                    break
        elif prefer_previous and len(entries) > 1:
            selected_index = 1

        selected = entries[selected_index]
        description = _find_text(selected, "desc") or f"index {selected_index}"
        filename = _find_report_parameter(selected, "filename")
        if not filename:
            raise VerifoneDirectError(
                f"Period metadata for {report_definition.display_name} did not provide a filename."
            )

        return PeriodMetadata(
            index=selected_index,
            name=description,
            filename=filename,
            period=_as_int(_find_report_parameter(selected, "period"), default=0),
            reg_number=_as_int(_find_report_parameter(selected, "regNum"), default=0),
            cashier_number=_as_int(_find_report_parameter(selected, "cashierNum"), default=0)
        )

    def _build_report_query_pairs(self, report_definition, period):
        pairs = []
        for pair in report_definition.pairs:
            parameter_type = pair.parameter_type.casefold()
            parameter_name = pair.parameter_name.casefold()
            if parameter_type == "constant":
                value = pair.parameter_name
            elif parameter_type == "variable":
                if parameter_name == "cookie":
                    value = self.cookie
                elif parameter_name == "period":
                    value = str(period.period)
                elif parameter_name == "filename":
                    value = period.filename
                elif parameter_name == "regnum":
                    value = str(period.reg_number)
                elif parameter_name == "cashiernum":
                    value = str(period.cashier_number)
                elif parameter_name == "user":
                    value = self.username
                elif parameter_name == "passwd":
                    value = self.password
                elif parameter_name == "base":
                    value = self.base_url
                elif parameter_name == "ssite":
                    value = self.site
                elif parameter_name == "cacheloc":
                    value = str(self.cache_dir)
                else:
                    value = ""
            else:
                value = ""

            if value == "" and pair.pair_name.casefold() not in {"cookie", "period", "filename"}:
                continue
            pairs.append((pair.pair_name, value))
        return pairs

    def _render_report(self, root, report_definition):
        xml_bytes = ET.tostring(root, encoding="utf-8")
        if not report_definition.transforms:
            return xml_bytes
        if etree is None:
            raise VerifoneDirectError(
                "lxml is required to apply Verifone report transforms. Install it into the Synchro virtual environment."
            )

        current_document = etree.fromstring(xml_bytes)
        rendered_bytes = xml_bytes
        for index, transform in enumerate(report_definition.transforms):
            transform_path = self._resolve_transform_path(transform.url)
            compiled_transform = etree.XSLT(etree.parse(str(transform_path)))
            result = compiled_transform(current_document)
            rendered_bytes = str(result).encode("utf-8")
            if index < len(report_definition.transforms) - 1:
                current_document = etree.fromstring(rendered_bytes)
        return rendered_bytes

    def _resolve_transform_path(self, transform_url):
        relative = pathlib.Path(str(transform_url).replace("\\", "/"))
        candidates = [
            self.assets_base_dir / relative,
            self.assets_base_dir / relative.relative_to("vfit") if relative.parts[:1] == ("vfit",) else None,
            self.assets_base_dir / "vfit" / relative,
        ]
        for candidate in candidates:
            if candidate is not None and candidate.exists():
                return candidate
        raise VerifoneDirectError(
            f"Missing XSLT asset for report transform: {transform_url}. Set SYNCHRO_VERIFONE_ASSETS_DIR to the ReportNavigator asset folder."
        )

    @property
    def base_url(self):
        if self.port == 443:
            return f"https://{self.host}"
        return f"https://{self.host}:{self.port}"
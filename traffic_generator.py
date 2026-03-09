#!/usr/bin/env python3
import argparse
import concurrent.futures
import datetime as dt
import json
import math
import random
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple

BASE_DISTRIBUTION: List[Tuple[str, float]] = [
    ("normal", 0.70),
    ("slow", 0.15),
    ("slow_hard", 0.05),
    ("error", 0.05),
    ("db", 0.03),
    ("validate", 0.02),
]

ERROR_SPIKE_DISTRIBUTION: List[Tuple[str, float]] = [
    ("normal", 0.35),
    ("slow", 0.15),
    ("slow_hard", 0.05),
    ("error", 0.40),
    ("db", 0.03),
    ("validate", 0.02),
]

LATENCY_SPIKE_DISTRIBUTION: List[Tuple[str, float]] = [
    ("normal", 0.45),
    ("slow", 0.15),
    ("slow_hard", 0.30),
    ("error", 0.05),
    ("db", 0.03),
    ("validate", 0.02),
]

STRICT_LOG_SCHEMA = [
    "timestamp",
    "request_id",
    "client_ip",
    "user_agent",
    "method",
    "path",
    "query",
    "payload_size_bytes",
    "response_size_bytes",
    "route_name",
    "status_code",
    "latency_ms",
    "severity",
    "error_category",
    "build_version",
    "host",
    "log_level",
    "log_channel",
    "log_message",
    "anomaly_start_iso",
    "anomaly_end_iso",
]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def weighted_choice(distribution: List[Tuple[str, float]]) -> str:
    roll = random.random()
    cursor = 0.0
    for endpoint, weight in distribution:
        cursor += weight
        if roll <= cursor:
            return endpoint
    return distribution[-1][0]


def endpoint_request(base_url: str, endpoint_key: str, timeout: float, run_id: str, idx: int) -> Dict[str, object]:
    headers = {
        "Content-Type": "application/json",
        "X-Loadtest-Run-Id": run_id,
        "X-Request-Id": f"{run_id}-{idx}",
    }

    method = "GET"
    data = None
    path = "/api/normal"

    if endpoint_key == "normal":
        path = "/api/normal"
    elif endpoint_key == "slow":
        path = "/api/slow"
    elif endpoint_key == "slow_hard":
        path = "/api/slow?hard=1"
    elif endpoint_key == "error":
        path = "/api/error"
    elif endpoint_key == "db":
        path = "/api/db"
    elif endpoint_key == "validate":
        path = "/api/validate"
        method = "POST"
        valid = random.random() >= 0.5
        payload = {"email": "valid@example.com", "age": 30} if valid else {"email": "not-an-email", "age": 12}
        data = json.dumps(payload).encode("utf-8")
    else:
        raise ValueError(f"Unsupported endpoint key: {endpoint_key}")

    url = f"{base_url.rstrip('/')}{path}"
    request = urllib.request.Request(url=url, method=method, headers=headers, data=data)

    start = time.perf_counter()
    status = None
    error = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.getcode()
            _ = response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        _ = exc.read()
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
    elapsed = time.perf_counter() - start

    return {
        "endpoint_key": endpoint_key,
        "status": status,
        "duration_seconds": elapsed,
        "error": error,
    }


def run_load(
    base_url: str,
    base_minutes: int,
    min_base_requests: int,
    anomaly_type: str,
    timeout: float,
    max_workers: int | None = None,
) -> Dict[str, object]:
    anomaly_distribution = ERROR_SPIKE_DISTRIBUTION if anomaly_type == "error_spike" else LATENCY_SPIKE_DISTRIBUTION

    base_duration = base_minutes * 60
    anomaly_duration = 120
    requests_per_second = max(1, math.ceil(min_base_requests / base_duration))
    total_duration = base_duration + anomaly_duration

    run_id = f"run-{int(time.time())}"
    experiment_start = time.time()
    anomaly_start = experiment_start + base_duration
    anomaly_end = anomaly_start + anomaly_duration
    experiment_end = experiment_start + total_duration

    stats = {
        "requested": 0,
        "base_requested": 0,
        "anomaly_requested": 0,
        "completed": 0,
        "transport_errors": 0,
        "by_endpoint": {},
        "status_code_counts": {},
    }
    lock = threading.Lock()

    worker_count = max_workers if max_workers is not None else max(16, requests_per_second * 3)
    futures: List[concurrent.futures.Future] = []

    def on_done(future: concurrent.futures.Future) -> None:
        result = future.result()
        endpoint_key = str(result["endpoint_key"])
        status = result.get("status")
        error = result.get("error")
        with lock:
            stats["completed"] += 1
            stats["by_endpoint"][endpoint_key] = stats["by_endpoint"].get(endpoint_key, 0) + 1
            if status is not None:
                code = str(status)
                stats["status_code_counts"][code] = stats["status_code_counts"].get(code, 0) + 1
            if error:
                stats["transport_errors"] += 1

    print(f"[{now_iso()}] experiment_start")
    print(f"[{dt.datetime.fromtimestamp(anomaly_start, tz=dt.timezone.utc).isoformat()}] anomaly_start ({anomaly_type})")
    print(f"[{dt.datetime.fromtimestamp(anomaly_end, tz=dt.timezone.utc).isoformat()}] anomaly_end")

    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        tick = experiment_start
        request_index = 0
        while time.time() < experiment_end:
            now = time.time()
            in_anomaly_window = anomaly_start <= now < anomaly_end
            phase_distribution = anomaly_distribution if in_anomaly_window else BASE_DISTRIBUTION

            for _ in range(requests_per_second):
                endpoint_key = weighted_choice(phase_distribution)
                future = executor.submit(endpoint_request, base_url, endpoint_key, timeout, run_id, request_index)
                future.add_done_callback(on_done)
                futures.append(future)
                request_index += 1
                with lock:
                    stats["requested"] += 1
                    if in_anomaly_window:
                        stats["anomaly_requested"] += 1
                    else:
                        stats["base_requested"] += 1

            tick += 1
            sleep_for = tick - time.time()
            if sleep_for > 0:
                time.sleep(sleep_for)

        concurrent.futures.wait(futures)

    summary = {
        "run_id": run_id,
        "experiment_start_iso": dt.datetime.fromtimestamp(experiment_start, tz=dt.timezone.utc).isoformat(),
        "experiment_end_iso": dt.datetime.fromtimestamp(experiment_end, tz=dt.timezone.utc).isoformat(),
        "anomaly_start_iso": dt.datetime.fromtimestamp(anomaly_start, tz=dt.timezone.utc).isoformat(),
        "anomaly_end_iso": dt.datetime.fromtimestamp(anomaly_end, tz=dt.timezone.utc).isoformat(),
        "anomaly_type": anomaly_type,
        "base_minutes": base_minutes,
        "requests_per_second": requests_per_second,
        "max_workers": worker_count,
        "stats": stats,
    }
    return summary


def write_ground_truth(output_dir: Path, run_summary: Dict[str, object]) -> Path:
    anomaly_type = str(run_summary["anomaly_type"])
    if anomaly_type == "error_spike":
        expected = "During anomaly window, SYSTEM_ERROR volume and error_rate% should spike due to /api/error increase."
    else:
        expected = (
            "During anomaly window, latency p95/p99 should spike due to /api/slow?hard=1 increase while error rate stays near baseline."
        )

    payload = {
        "anomaly_start_iso": run_summary["anomaly_start_iso"],
        "anomaly_end_iso": run_summary["anomaly_end_iso"],
        "anomaly_type": anomaly_type,
        "expected_behavior": expected,
    }

    target = output_dir / "ground_truth.json"
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return target


def parse_aiops_line(line: str) -> Dict[str, object]:
    raw = json.loads(line)
    context = raw.get("context", {}) if isinstance(raw, dict) else {}
    if not isinstance(context, dict):
        context = {}

    record = {
        "timestamp": context.get("timestamp"),
        "request_id": context.get("request_id"),
        "client_ip": context.get("client_ip"),
        "user_agent": context.get("user_agent"),
        "method": context.get("method"),
        "path": context.get("path"),
        "query": context.get("query"),
        "payload_size_bytes": context.get("payload_size_bytes"),
        "response_size_bytes": context.get("response_size_bytes"),
        "route_name": context.get("route_name"),
        "status_code": context.get("status_code"),
        "latency_ms": context.get("latency_ms"),
        "severity": context.get("severity"),
        "error_category": context.get("error_category"),
        "build_version": context.get("build_version"),
        "host": context.get("host"),
        "log_level": raw.get("level_name"),
        "log_channel": raw.get("channel"),
        "log_message": raw.get("message"),
    }
    return record


def export_logs_json(
    aiops_log_path: Path,
    output_path: Path,
    anomaly_start_iso: str,
    anomaly_end_iso: str,
) -> Dict[str, int]:
    if not aiops_log_path.exists():
        raise FileNotFoundError(f"aiops log not found: {aiops_log_path}")

    records: List[Dict[str, object]] = []
    errors = 0

    for line in aiops_log_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = parse_aiops_line(stripped)
        except json.JSONDecodeError:
            continue

        record["anomaly_start_iso"] = anomaly_start_iso
        record["anomaly_end_iso"] = anomaly_end_iso

        ordered_record = {key: record.get(key) for key in STRICT_LOG_SCHEMA}
        records.append(ordered_record)

        if ordered_record.get("severity") == "error":
            errors += 1

    output_path.write_text(json.dumps(records, indent=2), encoding="utf-8")
    return {"entries": len(records), "errors": errors}


def maybe_reset_log_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate controlled AIOps traffic experiment and export ground truth + logs dataset."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="Laravel app base URL.")
    parser.add_argument("--base-minutes", type=int, default=8, help="Base load duration in minutes (8-12 recommended).")
    parser.add_argument("--min-base-requests", type=int, default=3000, help="Minimum number of base-period requests.")
    parser.add_argument(
        "--anomaly-type",
        choices=["error_spike", "latency_spike"],
        default="latency_spike",
        help="Anomaly profile to inject for exactly 2 minutes.",
    )
    parser.add_argument("--timeout-seconds", type=float, default=45.0, help="Per-request HTTP timeout.")
    parser.add_argument("--max-workers", type=int, default=24, help="Thread pool size for outbound requests.")
    parser.add_argument(
        "--aiops-log-path",
        default="storage/logs/aiops.log",
        help="Path to aiops.log (relative to working directory).",
    )
    parser.add_argument("--output-dir", default=".", help="Directory for ground_truth.json, logs.json, and run summary.")
    parser.add_argument(
        "--reset-aiops-log",
        action="store_true",
        help="Truncate aiops.log before the experiment for a clean dataset.",
    )
    args = parser.parse_args()

    if args.base_minutes < 8 or args.base_minutes > 12:
        raise ValueError("--base-minutes must be between 8 and 12.")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    aiops_log_path = Path(args.aiops_log_path)
    if not aiops_log_path.is_absolute():
        aiops_log_path = Path.cwd() / aiops_log_path

    if args.reset_aiops_log:
        maybe_reset_log_file(aiops_log_path)
        print(f"[{now_iso()}] reset log file: {aiops_log_path}")

    run_summary = run_load(
        base_url=args.base_url,
        base_minutes=args.base_minutes,
        min_base_requests=args.min_base_requests,
        anomaly_type=args.anomaly_type,
        timeout=args.timeout_seconds,
        max_workers=args.max_workers,
    )

    # Allow last log flush before export.
    time.sleep(2)

    ground_truth_path = write_ground_truth(output_dir, run_summary)
    logs_json_path = output_dir / "logs.json"
    export_stats = export_logs_json(
        aiops_log_path=aiops_log_path,
        output_path=logs_json_path,
        anomaly_start_iso=str(run_summary["anomaly_start_iso"]),
        anomaly_end_iso=str(run_summary["anomaly_end_iso"]),
    )

    summary_path = output_dir / "traffic_run_summary.json"
    summary_payload = {
        **run_summary,
        "exported_logs_entries": export_stats["entries"],
        "exported_error_logs": export_stats["errors"],
        "requirements_check": {
            "logs_entries_ge_1500": export_stats["entries"] >= 1500,
            "error_logs_ge_100": export_stats["errors"] >= 100,
            "base_requests_ge_minimum": run_summary["stats"]["base_requested"] >= args.min_base_requests,
        },
    }
    summary_path.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")

    print(f"[{now_iso()}] wrote {ground_truth_path}")
    print(f"[{now_iso()}] wrote {logs_json_path}")
    print(f"[{now_iso()}] wrote {summary_path}")
    print(json.dumps(summary_payload["requirements_check"], indent=2))

    failed = not all(summary_payload["requirements_check"].values())
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

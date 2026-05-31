import base64
import json
import os
import urllib.parse
import urllib.error
import urllib.request

import boto3


cloudwatch = boto3.client("cloudwatch")
ecs = boto3.client("ecs")
secretsmanager = boto3.client("secretsmanager")


def handler(event, context):
    cluster_name = os.environ["ECS_CLUSTER_NAME"]
    service_name = os.environ["ECS_SERVICE_NAME"]
    api_key = _read_secret(os.environ["CURSOR_API_KEY_SECRET_ARN"])
    task_private_ips = _list_service_task_private_ips(
        cluster_name,
        service_name,
    )
    workers = _fetch_workers(os.environ["CURSOR_WORKERS_URL"], api_key)
    connected, in_use = _summarize_matching_workers(workers, task_private_ips)
    idle = max(connected - in_use, 0)
    utilization_percent = (in_use / connected * 100) if connected else 0.0
    service_capacity = _describe_service_capacity(cluster_name, service_name)
    target_idle_workers = int(os.environ.get("TARGET_IDLE_WORKERS", "1"))
    min_capacity = int(os.environ.get("MIN_CAPACITY", "1"))
    max_capacity = int(os.environ.get("MAX_CAPACITY", "5"))
    recommended_capacity = _recommended_capacity(
        connected=connected,
        in_use=in_use,
        idle=idle,
        service_capacity=service_capacity,
        target_idle_workers=target_idle_workers,
        min_capacity=min_capacity,
        max_capacity=max_capacity,
    )
    scale_out = _maybe_scale_out(
        cluster_name=cluster_name,
        service_name=service_name,
        service_capacity=service_capacity,
        recommended_capacity=recommended_capacity,
    )

    dimensions = [
        {"Name": name, "Value": value}
        for name, value in json.loads(os.environ["METRIC_DIMENSIONS"]).items()
    ]

    cloudwatch.put_metric_data(
        Namespace=os.environ["METRICS_NAMESPACE"],
        MetricData=[
            _metric("Connected", connected, "Count", dimensions),
            _metric("InUse", in_use, "Count", dimensions),
            _metric("Idle", idle, "Count", dimensions),
            _metric("UtilizationPercent", utilization_percent, "Percent", dimensions),
            _metric("DesiredCount", service_capacity["desired"], "Count", dimensions),
            _metric("RunningTasks", service_capacity["running"], "Count", dimensions),
            _metric("RecommendedCapacity", recommended_capacity, "Count", dimensions),
            _metric("TargetIdleWorkers", target_idle_workers, "Count", dimensions),
        ],
    )

    return {
        "connected": connected,
        "inUse": in_use,
        "idle": idle,
        "utilizationPercent": utilization_percent,
        "runningTasks": len(task_private_ips),
        "matchedWorkers": connected,
        "desiredCount": service_capacity["desired"],
        "recommendedCapacity": recommended_capacity,
        "scaleOut": scale_out,
    }


def _describe_service_capacity(cluster_name, service_name):
    response = ecs.describe_services(cluster=cluster_name, services=[service_name])
    services = response.get("services", [])
    if not services:
        raise RuntimeError(f"ECS service not found: {cluster_name}/{service_name}")

    service = services[0]
    return {
        "desired": int(service.get("desiredCount") or 0),
        "running": int(service.get("runningCount") or 0),
        "pending": int(service.get("pendingCount") or 0),
    }


def _recommended_capacity(
    connected,
    in_use,
    idle,
    service_capacity,
    target_idle_workers,
    min_capacity,
    max_capacity,
):
    if connected == 0:
        return min(max(min_capacity, service_capacity["desired"]), max_capacity)

    current_capacity = max(service_capacity["desired"], service_capacity["running"], connected)
    idle_shortfall = max(target_idle_workers - idle, 0)
    recommended = current_capacity + idle_shortfall

    return min(max(recommended, min_capacity), max_capacity)


def _maybe_scale_out(
    cluster_name,
    service_name,
    service_capacity,
    recommended_capacity,
):
    if os.environ.get("ENABLE_DYNAMIC_SCALE_OUT", "true").lower() != "true":
        return {"enabled": False, "updated": False}

    current_desired = service_capacity["desired"]
    if recommended_capacity <= current_desired:
        return {"enabled": True, "updated": False}

    ecs.update_service(
        cluster=cluster_name,
        service=service_name,
        desiredCount=recommended_capacity,
    )

    return {
        "enabled": True,
        "updated": True,
        "previousDesiredCount": current_desired,
        "newDesiredCount": recommended_capacity,
    }


def _list_service_task_private_ips(cluster_name, service_name):
    task_arns = []
    paginator = ecs.get_paginator("list_tasks")
    for page in paginator.paginate(
        cluster=cluster_name,
        serviceName=service_name,
        desiredStatus="RUNNING",
    ):
        task_arns.extend(page.get("taskArns", []))

    private_ips = set()
    for index in range(0, len(task_arns), 100):
        response = ecs.describe_tasks(
            cluster=cluster_name,
            tasks=task_arns[index : index + 100],
        )
        for task in response.get("tasks", []):
            private_ips.update(_task_private_ips(task))

    return private_ips


def _task_private_ips(task):
    private_ips = set()
    for attachment in task.get("attachments", []):
        for detail in attachment.get("details", []):
            if detail.get("name") == "privateIPv4Address" and detail.get("value"):
                private_ips.add(detail["value"])

    return private_ips


def _read_secret(secret_arn):
    response = secretsmanager.get_secret_value(SecretId=secret_arn)
    if "SecretString" in response:
        return response["SecretString"]

    return base64.b64decode(response["SecretBinary"]).decode("utf-8")


def _fetch_workers(url, api_key):
    workers = []
    next_page_token = None

    while True:
        response = _fetch_json(
            url,
            api_key,
            {
                "status": "all",
                "limit": "100",
                **({"nextPageToken": next_page_token} if next_page_token else {}),
            },
        )
        workers.extend(response.get("workers", []))
        next_page_token = response.get("nextPageToken")
        if not next_page_token:
            return workers


def _fetch_json(url, api_key, query):
    auth_value = base64.b64encode(f"{api_key}:".encode("utf-8")).decode("ascii")
    request_url = _append_query(url, query)
    request = urllib.request.Request(
        request_url,
        headers={
            "Authorization": f"Basic {auth_value}",
            "Accept": "application/json",
            "User-Agent": "cursor-ecs-metrics-publisher/1.0",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Cursor worker list request failed: {error.code} {body}") from error


def _append_query(url, query):
    parsed = urllib.parse.urlparse(url)
    current_query = dict(urllib.parse.parse_qsl(parsed.query))
    current_query.update({key: value for key, value in query.items() if value})
    return urllib.parse.urlunparse(
        parsed._replace(query=urllib.parse.urlencode(current_query))
    )


def _summarize_matching_workers(workers, task_private_ips):
    connected = 0
    in_use = 0

    for worker in workers:
        if not _worker_matches_task(worker, task_private_ips):
            continue

        connected += 1
        if worker.get("isInUse") or worker.get("activeBcId"):
            in_use += 1

    return connected, in_use


def _worker_matches_task(worker, task_private_ips):
    name = worker.get("name") or ""
    for private_ip in task_private_ips:
        private_dns_fragment = f"ip-{private_ip.replace('.', '-')}"
        if _name_contains_ip(name, private_ip) or _name_contains_dns_fragment(
            name, private_dns_fragment
        ):
            return True

    return False


def _name_contains_ip(name, private_ip):
    return _name_contains_token(name, private_ip, _continues_ip_token)


def _name_contains_dns_fragment(name, private_dns_fragment):
    return _name_contains_token(
        name, private_dns_fragment, _continues_dns_fragment_token
    )


def _name_contains_token(name, token, continues_token):
    start = 0
    while True:
        index = name.find(token, start)
        if index == -1:
            return False

        before_ok = index == 0 or not continues_token(name[index - 1])
        end = index + len(token)
        after_ok = end == len(name) or not continues_token(name[end])
        if before_ok and after_ok:
            return True

        start = index + 1


def _continues_ip_token(char):
    return char.isdigit() or char == "."


def _continues_dns_fragment_token(char):
    return char.isdigit()


def _metric(name, value, unit, dimensions):
    return {
        "MetricName": name,
        "Value": value,
        "Unit": unit,
        "Dimensions": dimensions,
    }

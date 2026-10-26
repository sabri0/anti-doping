#!/usr/bin/env bash
# Record the host on which the measurements were taken: operating system,
# processor, virtualisation layer, container runtime, memory, storage, and the
# durable-write latency of the storage the ledgers live on.
#
# The fsync figure matters because every committed block, and every CouchDB
# state update, ends in a synchronous write: a host whose storage takes
# milliseconds per fsync bounds commit throughput whatever the processors do.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
OUT=${OUT:-docs/measurements/host.json}
PY=${PY:-python}

os=$(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem | Select-Object -Property Caption,Version | ConvertTo-Json -Compress)" 2>/dev/null | tr -d '\r')
cpu=$(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1 -Property Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress)" 2>/dev/null | tr -d '\r')
disk=$(powershell.exe -NoProfile -Command "(Get-PhysicalDisk | Select-Object -Property FriendlyName,MediaType,BusType,Size | ConvertTo-Json -Compress)" 2>/dev/null | tr -d '\r')
dinfo=$(docker info --format '{"serverVersion":"{{.ServerVersion}}","kernel":"{{.KernelVersion}}","os":"{{.OperatingSystem}}","cpus":{{.NCPU}},"memBytes":{{.MemTotal}},"storageDriver":"{{.Driver}}"}')
compose=$(docker compose version --short)

# Durable 4 KiB writes on a Docker named volume, the storage the peer ledgers,
# state databases and orderer write-ahead logs use.
docker volume create antidoping-fsync-probe >/dev/null
fsync=$(docker run --rm -v antidoping-fsync-probe:/probe debian:bookworm-slim sh -c \
  'dd if=/dev/zero of=/probe/f bs=4k count=2000 oflag=dsync 2>&1 | tail -1')
seq=$(docker run --rm -v antidoping-fsync-probe:/probe debian:bookworm-slim sh -c \
  'dd if=/dev/zero of=/probe/g bs=1M count=512 conv=fdatasync 2>&1 | tail -1')
docker volume rm antidoping-fsync-probe >/dev/null

"$PY" - "$OUT" <<PY
import json, re, sys
def parse(s):
    try: return json.loads(s)
    except Exception: return s
fs = """$fsync"""
m = re.search(r"([\d.]+) s,", fs)
per_write_ms = float(m.group(1)) / 2000 * 1000 if m else None
info = {
  "os": parse('''$os'''), "processor": parse('''$cpu'''), "disks": parse('''$disk'''),
  "docker": parse('''$dinfo'''), "composeVersion": "$compose",
  "virtualisation": "Docker Desktop on WSL 2 (Hyper-V lightweight utility VM); container volumes on the VM's ext4 virtual disk",
  "networkProcessors": "0-5 (cpuset)", "driverProcessors": "6-7 (cpuset)",
  "storage": {"syncWrite4KiB": fs.strip(), "meanSyncWriteMs": per_write_ms, "sequential512MiBFdatasync": """$seq""".strip()},
}
json.dump(info, open(sys.argv[1], "w"), indent=1)
print(json.dumps(info, indent=1))
PY

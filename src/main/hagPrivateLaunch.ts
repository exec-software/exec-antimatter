import type { HagContainment } from './hagProcess';

/**
 * Runs inside the freshly created systemd service. Only shell builtins run before exec: a
 * helper process would invalidate the singleton ownership check. All variable data is argv.
 * systemd-run must use --expand-environment=no to preserve this fixed shell source literally.
 */
export const PRIVATE_HAG_LAUNCH = String.raw`set -eu
fail() { printf '%s\n' 'Native HAG private service attestation failed.' >&2; exit 1; }
unset BEHOLDD_HAG_PRIVATE_CGROUP
unit=$1
binary=$2
config=$3
port=$4
expected_max=$5
expected_high=$6
expected_tasks=$7
expected_cpu=$8
exec 3< /proc/self/cgroup
IFS= read -r membership <&3 || fail
if IFS= read -r extra <&3; then fail; fi
exec 3<&-
case "$membership" in 0::/*) group=${'${'}membership#0::} ;; *) fail ;; esac
case "$group" in /|*//*|*/../*|*/./*|*/..|*/.|*[!a-zA-Z0-9/_.@-]*) fail ;; esac
case "$group" in */"$unit") ;; *) fail ;; esac
root=/sys/fs/cgroup$group
mount_ok=0
while read -r mount_id parent device mount_root mount_point mount_options rest; do
  if [ "$mount_point" = /sys/fs/cgroup ]; then
    case "$rest" in '- cgroup2 '*|*' - cgroup2 '*) mount_ok=1 ;; esac
  fi
done < /proc/self/mountinfo
[ "$mount_ok" = 1 ] || fail
members=0
while IFS= read -r member; do
  [ "$member" = "$$" ] || fail
  members=$((members + 1))
done < "$root/cgroup.procs"
[ "$members" = 1 ] || fail
for entry in "$root"/*; do [ ! -d "$entry" ] || fail; done
IFS= read -r actual < "$root/memory.max"
[ "$actual" = "$expected_max" ] || fail
IFS= read -r actual < "$root/memory.high"
[ "$actual" = "$expected_high" ] || fail
IFS= read -r actual < "$root/memory.swap.max"
[ "$actual" = 0 ] || fail
IFS= read -r actual < "$root/pids.max"
[ "$actual" = "$expected_tasks" ] || fail
read -r quota period extra < "$root/cpu.max"
case "$quota:$period" in *[!0-9:]*|:*|*:) fail ;; esac
[ "$period" -gt 0 ] && [ "$quota" -gt 0 ] || fail
[ "$((quota * 100))" -eq "$((period * expected_cpu))" ] || fail
affinity_ok=0
privileges_ok=0
while read -r key value extra; do
  case "$key" in
    Cpus_allowed_list:) [ "$value" = 0-1 ] || fail; affinity_ok=1 ;;
    NoNewPrivs:) [ "$value" = 1 ] || fail; privileges_ok=1 ;;
  esac
done < /proc/self/status
[ "$affinity_ok" = 1 ] && [ "$privileges_ok" = 1 ] || fail
IFS= read -r baseline < "$root/memory.current"
[ "$baseline" -le 67108864 ] && [ "$baseline" -lt "$expected_high" ] || fail
IFS= read -r actual < "$root/memory.swap.current"
[ "$actual" = 0 ] || fail
for events in memory.events pids.events; do
  while read -r name count extra; do [ "$count" = 0 ] || fail; done < "$root/$events"
done
IFS= read -r after < /proc/self/cgroup
[ "$after" = "$membership" ] || fail
printf 'ANTIMATTER_HAG_ATTESTATION_V1 %s %s %s %s\n' "$unit" "$$" "$baseline" "$group"
export BEHOLDD_HAG_PRIVATE_CGROUP="$group"
exec "$binary" serve --config "$config" --host 127.0.0.1 --port "$port"
`;

export function privateHagLaunchArgs(binary: string, config: string, port: number, unit: string, policy: HagContainment): string[] {
  if (!/^antimatter-hag-[0-9]+-[a-f0-9-]+\.service$/.test(unit)) throw new Error('Invalid owned HAG unit identity.');
  return ['/bin/sh', '-c', PRIVATE_HAG_LAUNCH, 'antimatter-native-hag', unit, binary, config, String(port),
    String(policy.memoryMaxBytes), String(policy.memoryHighBytes), String(policy.tasksMax), String(policy.cpuQuotaPercent)];
}

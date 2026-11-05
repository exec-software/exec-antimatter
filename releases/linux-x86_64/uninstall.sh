#!/usr/bin/env bash
# Managed by the Antimatter user-local installer.
set -Eeuo pipefail
IFS=$'\n\t'

readonly APP_ID='co.antimatter.app'
readonly PLATFORM='linux-x86_64'
readonly MANAGED_MARKER='Managed by the Antimatter user-local installer.'
readonly MODEL_ID='qwen3-coder-30b'
readonly MODEL_FILENAME='Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf'

say() {
  printf 'Antimatter: %s\n' "$*"
}

warn() {
  printf 'Antimatter: warning: %s\n' "$*" >&2
}

die() {
  printf 'Antimatter: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: uninstall.sh

Remove the user-local Antimatter application, launcher, desktop entry, and icon.
Models, Beholdd configuration, conversations, settings, and project data are preserved.

Run this script as the same desktop user that installed Antimatter. Do not use sudo.
EOF
}

if (($#)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
fi

((EUID != 0)) || die 'do not run this user-local uninstaller with sudo or as root'
[[ $(uname -s) == Linux ]] || die 'this uninstaller supports Linux only'
[[ ${HOME:-} == /* && $HOME != / ]] || die 'HOME must be an absolute, non-root path'

for command in awk chmod cmp find flock mapfile mktemp python3 readlink rm rmdir sha256sum stat uname; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
bin_home=${XDG_BIN_HOME:-"$HOME/.local/bin"}

for path in "$data_home" "$config_home" "$state_home" "$bin_home"; do
  [[ $path == /* && $path != / && $path != *$'\n'* && $path != *$'\r'* ]] ||
    die "unsafe XDG path: $path"
done

app_data_root="$data_home/antimatter"
releases_root="$app_data_root/releases"
current_link="$app_data_root/current"
models_root="$app_data_root/models"
model_file="$models_root/$MODEL_ID/$MODEL_FILENAME"
app_config_root="$config_home/antimatter"
beholdd_home="$app_config_root/beholdd"
installed_uninstaller="$app_data_root/uninstall.sh"
wrapper_path="$bin_home/antimatter"
desktop_path="$data_home/applications/$APP_ID.desktop"
icon_path="$data_home/icons/hicolor/scalable/apps/$APP_ID.svg"
state_root="$state_home/antimatter"
receipt_path="$state_root/install.json"
lock_path="$state_root/install.lock"
work_dir=''

[[ -d $state_root && ! -L $state_root ]] ||
  die "a real installer state directory is required: $state_root"
[[ $(stat -c '%u' -- "$state_root") == "$EUID" ]] ||
  die "installer state is owned by another user: $state_root"
[[ $(stat -c '%a' -- "$state_root") == 700 ]] ||
  die "installer state must have mode 0700: $state_root"
[[ -f $receipt_path && ! -L $receipt_path ]] ||
  die "a trustworthy install receipt is required: $receipt_path"
[[ $(stat -c '%u' -- "$receipt_path") == "$EUID" && $(stat -c '%a' -- "$receipt_path") == 600 ]] ||
  die "install receipt must be owned by the current user with mode 0600: $receipt_path"
[[ -f $lock_path && ! -L $lock_path ]] || die "installer lock is missing or unsafe: $lock_path"
[[ $(stat -c '%u' -- "$lock_path") == "$EUID" && $(stat -c '%a' -- "$lock_path") == 600 ]] ||
  die "installer lock must be owned by the current user with mode 0600: $lock_path"
[[ $(stat -c '%h' -- "$lock_path") == 1 ]] || die "installer lock must not be hard-linked: $lock_path"
exec 9<"$lock_path"
flock -n 9 || die 'another Antimatter install or uninstall is in progress'

[[ -f $receipt_path && ! -L $receipt_path ]] ||
  die "install receipt changed while acquiring the lock: $receipt_path"
[[ $(stat -c '%u' -- "$receipt_path") == "$EUID" && $(stat -c '%a' -- "$receipt_path") == 600 ]] ||
  die "install receipt changed while acquiring the lock: $receipt_path"

if [[ -e $app_data_root || -L $app_data_root ]]; then
  [[ -d $app_data_root && ! -L $app_data_root ]] ||
    die "refusing installer-data symlink or special path: $app_data_root"
  [[ $(stat -c '%u' -- "$app_data_root") == "$EUID" ]] ||
    die "installer data is owned by another user: $app_data_root"
fi
if [[ -e $releases_root || -L $releases_root ]]; then
  [[ -d $releases_root && ! -L $releases_root ]] ||
    die "refusing releases symlink or special path: $releases_root"
  [[ $(stat -c '%u' -- "$releases_root") == "$EUID" ]] ||
    die "releases directory is owned by another user: $releases_root"
fi

reject_mountpoints_at_or_below() {
  local root=$1
  python3 - "$root" <<'PY'
import os
import re
import sys

root = os.path.realpath(sys.argv[1])
if root == "/":
    raise SystemExit("refusing to inspect the filesystem root as a deletion target")

def unescape_mount_path(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)

try:
    with open("/proc/self/mountinfo", encoding="utf-8", errors="surrogateescape") as handle:
        for line in handle:
            fields = line.split(" - ", 1)[0].split()
            if len(fields) < 5:
                raise ValueError("malformed mountinfo entry")
            mountpoint = os.path.realpath(unescape_mount_path(fields[4]))
            if mountpoint == root or mountpoint.startswith(root + os.sep):
                raise SystemExit(f"mountpoint at or below deletion root: {mountpoint}")
except OSError as error:
    raise SystemExit(f"cannot inspect /proc/self/mountinfo: {error}")
except ValueError as error:
    raise SystemExit(f"cannot safely parse /proc/self/mountinfo: {error}")
PY
}

work_dir=$(mktemp -d "$state_root/.uninstall-work.XXXXXX")
chmod 700 -- "$work_dir"

cleanup_work_dir() {
  [[ -n $work_dir && $work_dir == "$state_root"/.uninstall-work.* ]] || return 0
  [[ -d $work_dir && ! -L $work_dir ]] || return 0
  reject_mountpoints_at_or_below "$work_dir" || return 1
  find "$work_dir" -xdev -depth -mindepth 1 -delete 2>/dev/null || return 1
  rmdir -- "$work_dir" 2>/dev/null || return 1
  work_dir=''
}

cleanup() {
  local status=$?
  cleanup_work_dir || true
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# The current application does not expose a reliable command-line quit operation. Refuse to
# delete its payload while any Antimatter process is visible; never kill a process by name here.
if command -v pgrep >/dev/null 2>&1 && pgrep -u "$EUID" -x antimatter >/dev/null 2>&1; then
  die 'Antimatter is running; choose Quit from its tray menu, then run the uninstaller again'
fi

parse_receipt() {
  local output=$1
  python3 - "$receipt_path" "$output" "$APP_ID" "$EUID" "$PLATFORM" \
    "$app_data_root" "$releases_root" "$current_link" "$wrapper_path" "$desktop_path" \
    "$icon_path" "$installed_uninstaller" "$beholdd_home" "$model_file" <<'PY'
import json
import os
import re
import stat
import sys

(
    source,
    output,
    app_id,
    expected_uid,
    platform,
    data_root,
    releases_root,
    current,
    launcher,
    desktop,
    icon,
    uninstaller,
    beholdd_home,
    model,
) = sys.argv[1:]
expected_uid = int(expected_uid)

fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("receipt is not a regular file")
    if info.st_nlink != 1:
        raise ValueError("receipt is hard-linked")
    if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("receipt ownership or permissions are invalid")
    if info.st_size > 1024 * 1024:
        raise ValueError("receipt is unexpectedly large")
    with os.fdopen(fd, encoding="utf-8") as handle:
        fd = -1
        document = json.load(handle)
finally:
    if fd >= 0:
        os.close(fd)

required_keys = {
    "schemaVersion", "appId", "uid", "platform", "installedAt", "updatedAt",
    "dataRoot", "current", "currentVersion", "launcher", "desktopEntry", "icon",
    "uninstaller", "beholddHome", "model", "modelVerified", "releases",
}
if not isinstance(document, dict) or set(document) != required_keys:
    raise SystemExit("install receipt has an unexpected schema")
if document["schemaVersion"] != 2 or document["appId"] != app_id:
    raise SystemExit("install receipt has the wrong identity")
if type(document["uid"]) is not int or document["uid"] != expected_uid:
    raise SystemExit("install receipt belongs to another user")
if document["platform"] != platform:
    raise SystemExit("install receipt has the wrong platform")
expected_paths = {
    "dataRoot": data_root,
    "current": current,
    "launcher": launcher,
    "desktopEntry": desktop,
    "icon": icon,
    "uninstaller": uninstaller,
    "beholddHome": beholdd_home,
    "model": model,
}
for key, expected in expected_paths.items():
    if document[key] != expected:
        raise SystemExit(f"install receipt has an unexpected {key} path")
timestamp = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
if not all(isinstance(document[key], str) and timestamp.fullmatch(document[key])
           for key in ("installedAt", "updatedAt")):
    raise SystemExit("install receipt has an invalid timestamp")
if type(document["modelVerified"]) is not bool:
    raise SystemExit("install receipt has an invalid model status")
version_pattern = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}")
digest_pattern = re.compile(r"[0-9a-f]{64}")
releases = document["releases"]
if not isinstance(releases, list) or not releases or len(releases) > 256:
    raise SystemExit("install receipt has an invalid release list")
seen = set()
records = []
for release in releases:
    if not isinstance(release, dict) or set(release) != {
        "version", "path", "packageSha256", "payloadManifestSha256"
    }:
        raise SystemExit("install receipt has an invalid release entry")
    version = release["version"]
    if not isinstance(version, str) or not version_pattern.fullmatch(version) or version in seen:
        raise SystemExit("install receipt has an invalid or duplicate version")
    seen.add(version)
    if release["path"] != os.path.join(releases_root, version):
        raise SystemExit("install receipt has an unexpected release path")
    if not all(isinstance(release[key], str) and digest_pattern.fullmatch(release[key])
               for key in ("packageSha256", "payloadManifestSha256")):
        raise SystemExit("install receipt has an invalid release digest")
    records.append((version, release["path"], release["packageSha256"],
                    release["payloadManifestSha256"]))
current_version = document["currentVersion"]
if not isinstance(current_version, str) or current_version not in seen:
    raise SystemExit("install receipt current version is not installed")

with open(output, "xb") as handle:
    for value in (current_version, *(item for record in records for item in record)):
        handle.write(value.encode("utf-8") + b"\0")
PY
}

build_payload_manifest() {
  local root=$1
  local output=$2
  python3 - "$root" "$output" <<'PY'
import hashlib
import json
import os
import stat
import sys

root, output = map(os.path.abspath, sys.argv[1:])
metadata = {".antimatter-package.sha256", ".antimatter-payload-manifest.json"}
try:
    root_stat = os.lstat(root)
except OSError as error:
    raise SystemExit(f"cannot inspect payload root: {error}")
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit("payload root is not a real directory")
if root_stat.st_uid != os.geteuid():
    raise SystemExit("payload root is owned by another user")
root_device = root_stat.st_dev
entries = []

def scan(directory, prefix=""):
    try:
        children = sorted(os.scandir(directory), key=lambda item: item.name)
    except OSError as error:
        raise SystemExit(f"cannot scan payload: {error}")
    for child in children:
        relative = f"{prefix}/{child.name}" if prefix else child.name
        if not prefix and child.name in metadata:
            continue
        try:
            info = child.stat(follow_symlinks=False)
        except OSError as error:
            raise SystemExit(f"cannot inspect payload entry {relative!r}: {error}")
        if info.st_dev != root_device:
            raise SystemExit(f"cross-filesystem payload entry is not allowed: {relative}")
        if info.st_uid != os.geteuid():
            raise SystemExit(f"payload entry is owned by another user: {relative}")
        mode = f"{stat.S_IMODE(info.st_mode):04o}"
        if stat.S_ISDIR(info.st_mode):
            entries.append({"mode": mode, "path": relative, "type": "directory"})
            scan(child.path, relative)
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                raise SystemExit(f"payload hardlink is not allowed: {relative}")
            digest = hashlib.sha256()
            try:
                with open(child.path, "rb", buffering=1024 * 1024) as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
            except OSError as error:
                raise SystemExit(f"cannot hash payload entry {relative!r}: {error}")
            entries.append({
                "bytes": info.st_size,
                "mode": mode,
                "path": relative,
                "sha256": digest.hexdigest(),
                "type": "file",
            })
        elif stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"payload symlink is not allowed: {relative}")
        else:
            raise SystemExit(f"payload special file is not allowed: {relative}")

scan(root)
document = {
    "schemaVersion": 1,
    "rootMode": f"{stat.S_IMODE(root_stat.st_mode):04o}",
    "entries": entries,
}
with open(output, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
}

validate_critical_executables() {
  local root=$1
  python3 - "$root" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

root = os.path.abspath(sys.argv[1])

def regular(relative):
    path = os.path.join(root, *relative.split("/"))
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        raise SystemExit(f"critical payload path is not a current-user regular file: {relative}")
    return path, info

def executable_elf_x86_64(relative):
    path, info = regular(relative)
    if not info.st_mode & stat.S_IXUSR:
        raise SystemExit(f"critical payload file is not executable: {relative}")
    with open(path, "rb") as handle:
        header = handle.read(20)
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1:
        raise SystemExit(f"critical payload file is not a 64-bit little-endian ELF: {relative}")
    if int.from_bytes(header[18:20], "little") != 62:
        raise SystemExit(f"critical payload file is not x86_64: {relative}")
    return path, info

executable_elf_x86_64("antimatter")
beholdd_path, beholdd_info = executable_elf_x86_64("resources/vendor/beholdd/bin/beholdd")
manifest_path, _ = regular("resources/vendor/beholdd/manifest.json")
try:
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid embedded Beholdd manifest: {error}")
artifacts = manifest.get("artifacts")
if not isinstance(artifacts, list):
    raise SystemExit("embedded Beholdd manifest has no artifact list")
matches = [item for item in artifacts if isinstance(item, dict) and item.get("path") == "bin/beholdd"]
if len(matches) != 1:
    raise SystemExit("embedded Beholdd manifest must identify bin/beholdd exactly once")
expected_hash = matches[0].get("sha256")
expected_bytes = matches[0].get("bytes")
if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
    raise SystemExit("embedded Beholdd manifest has an invalid binary SHA-256")
if expected_bytes != beholdd_info.st_size:
    raise SystemExit("embedded Beholdd binary size does not match its manifest")
digest = hashlib.sha256()
with open(beholdd_path, "rb", buffering=1024 * 1024) as handle:
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(block)
if digest.hexdigest() != expected_hash:
    raise SystemExit("embedded Beholdd binary SHA-256 does not match its manifest")
PY
}

receipt_records="$work_dir/receipt-records"
parse_receipt "$receipt_records" || die "install receipt is not trustworthy: $receipt_path"
mapfile -d '' -t receipt_fields < "$receipt_records"
(( ${#receipt_fields[@]} >= 5 && (${#receipt_fields[@]} - 1) % 4 == 0 )) ||
  die 'install receipt produced an invalid release record set'
current_version=${receipt_fields[0]}
release_versions=()
release_paths=()
release_package_hashes=()
release_manifest_hashes=()
for ((field_index = 1; field_index < ${#receipt_fields[@]}; field_index += 4)); do
  release_versions+=("${receipt_fields[field_index]}")
  release_paths+=("${receipt_fields[field_index + 1]}")
  release_package_hashes+=("${receipt_fields[field_index + 2]}")
  release_manifest_hashes+=("${receipt_fields[field_index + 3]}")
done

validate_release_payload() {
  local index=$1
  local version=${release_versions[index]}
  local target=${release_paths[index]}
  local package_hash=${release_package_hashes[index]}
  local manifest_hash=${release_manifest_hashes[index]}
  local package_marker="$target/.antimatter-package.sha256"
  local payload_manifest="$target/.antimatter-payload-manifest.json"
  local expected_marker="$work_dir/expected-package-$index"
  local rebuilt_manifest="$work_dir/rebuilt-manifest-$index"
  local actual_manifest_hash

  [[ $target == "$releases_root/$version" ]] || die "receipt contains an unsafe release path: $target"
  if [[ ! -e $target && ! -L $target ]]; then
    say "receipt release is already absent: $target"
    return 0
  fi
  [[ -d $releases_root && ! -L $releases_root ]] ||
    die "cannot validate release without a real releases directory: $releases_root"
  [[ -d $target && ! -L $target ]] || die "receipt release is not a real directory: $target"
  [[ $(stat -c '%u' -- "$target") == "$EUID" ]] ||
    die "receipt release is owned by another user: $target"
  [[ $(stat -c '%d' -- "$target") == "$(stat -c '%d' -- "$releases_root")" ]] ||
    die "receipt release is a cross-filesystem mount: $target"
  reject_mountpoints_at_or_below "$target" ||
    die "receipt release contains a mountpoint and cannot be removed: $target"
  for metadata_path in "$package_marker" "$payload_manifest"; do
    [[ -f $metadata_path && ! -L $metadata_path ]] ||
      die "release metadata is missing or unsafe: $metadata_path"
    [[ $(stat -c '%u' -- "$metadata_path") == "$EUID" && $(stat -c '%a' -- "$metadata_path") == 600 ]] ||
      die "release metadata ownership or permissions are invalid: $metadata_path"
    [[ $(stat -c '%h' -- "$metadata_path") == 1 ]] ||
      die "release metadata must not be hard-linked: $metadata_path"
  done
  printf '%s\n' "$package_hash" > "$expected_marker"
  cmp -s -- "$expected_marker" "$package_marker" ||
    die "release package marker does not match its receipt: $target"
  actual_manifest_hash=$(sha256sum -- "$payload_manifest" | awk '{print $1}')
  [[ $actual_manifest_hash == "$manifest_hash" ]] ||
    die "release payload manifest does not match its receipt: $target"
  build_payload_manifest "$target" "$rebuilt_manifest" ||
    die "release contains unsafe or unreadable entries: $target"
  cmp -s -- "$rebuilt_manifest" "$payload_manifest" ||
    die "release payload has changed; reinstall this version before uninstalling: $target"
  validate_critical_executables "$target" ||
    die "release critical executable validation failed: $target"
}

for ((release_index = 0; release_index < ${#release_versions[@]}; release_index += 1)); do
  validate_release_payload "$release_index"
done

has_managed_header() {
  local target=$1
  local kind=$2
  local first=''
  local second=''
  local descriptor
  exec {descriptor}< "$target" || return 1
  IFS= read -r first <&$descriptor || true
  IFS= read -r second <&$descriptor || true
  exec {descriptor}<&-
  case "$kind" in
    shell) [[ $first == '#!/usr/bin/env bash' && $second == "# $MANAGED_MARKER" ]] ;;
    desktop) [[ $first == "# $MANAGED_MARKER" && $second == '[Desktop Entry]' ]] ;;
    svg) [[ $first == '<?xml version="1.0" encoding="UTF-8"?>' && $second == "<!-- $MANAGED_MARKER -->" ]] ;;
    *) return 1 ;;
  esac
}

remove_managed_file() {
  local target=$1
  local kind=$2
  if [[ -L $target ]]; then
    warn "leaving unexpected symbolic link: $target"
  elif [[ -f $target ]]; then
    if has_managed_header "$target" "$kind"; then
      rm -f -- "$target"
    else
      warn "leaving file not recognized as installer-managed: $target"
    fi
  fi
}

safe_remove_receipt_release() {
  local index=$1
  local version=${release_versions[index]}
  local target=${release_paths[index]}
  [[ $target == "$releases_root/$version" && $target != / ]] ||
    die "refusing unsafe receipt release path: $target"
  [[ ! -e $target && ! -L $target ]] && return 0
  [[ -d $target && ! -L $target ]] || die "release changed before removal: $target"
  [[ $(stat -c '%u' -- "$target") == "$EUID" ]] || die "release owner changed before removal: $target"
  [[ $(stat -c '%d' -- "$target") == "$(stat -c '%d' -- "$releases_root")" ]] ||
    die "release filesystem changed before removal: $target"
  reject_mountpoints_at_or_below "$target" ||
    die "release gained a mountpoint before removal: $target"
  find "$target" -xdev -depth -mindepth 1 -delete ||
    die "could not safely remove release; check for a nested mount: $target"
  rmdir -- "$target" || die "could not remove release directory: $target"
  say "removed verified application payload: $target"
}

for ((release_index = 0; release_index < ${#release_versions[@]}; release_index += 1)); do
  safe_remove_receipt_release "$release_index"
done

if [[ -L $current_link ]]; then
  expected_current="$releases_root/$current_version"
  if [[ $(readlink -- "$current_link") == "$expected_current" ]]; then
    rm -f -- "$current_link"
  else
    warn "leaving current link with an unexpected target: $current_link"
  fi
elif [[ -e $current_link ]]; then
  warn "leaving unexpected non-symlink path: $current_link"
fi

remove_managed_file "$wrapper_path" shell
remove_managed_file "$desktop_path" desktop
remove_managed_file "$icon_path" svg

if [[ -d $releases_root && ! -L $releases_root ]]; then
  rmdir -- "$releases_root" 2>/dev/null ||
    warn "leaving unrecognized content in releases directory: $releases_root"
fi

rm -f -- "$receipt_path"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data_home/applications" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 &&
  [[ -f $data_home/icons/hicolor/index.theme ]]; then
  gtk-update-icon-cache -f -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true
fi

# Deleting a running shell script is safe on Linux: Bash already holds the open file.
remove_managed_file "$installed_uninstaller" shell

cleanup_work_dir || die "could not remove temporary uninstall state: $work_dir"
if [[ -f $lock_path && ! -L $lock_path && $(stat -c '%u' -- "$lock_path") == "$EUID" ]]; then
  rm -f -- "$lock_path"
else
  warn "leaving installer lock that changed during uninstall: $lock_path"
fi
rmdir -- "$state_root" 2>/dev/null || true
rmdir -- "$app_data_root" 2>/dev/null || true

say 'application removed'
say "preserved model directory: $app_data_root/models"
say "preserved Beholdd configuration: $config_home/antimatter/beholdd"
say "preserved Antimatter settings: $config_home/Antimatter"
say "preserved conversations and workspaces: $HOME/.antimatter"

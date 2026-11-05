#!/usr/bin/env bash
# Managed by the Antimatter user-local installer.
set -Eeuo pipefail
IFS=$'\n\t'

readonly VERSION='21.0.0'
readonly RELEASE_TAG="v$VERSION"
readonly PLATFORM='linux-x86_64'
readonly APP_ID='co.antimatter.app'
readonly ARCHIVE_ROOT="Antimatter-$VERSION-$PLATFORM"
readonly PACKAGE_NAME="$ARCHIVE_ROOT.tar.gz"
readonly RELEASE_REPOSITORY='exec-software/exec-antimatter'
readonly MIN_GLIBC='2.34'
readonly MANAGED_MARKER='Managed by the Antimatter user-local installer.'

readonly CONFIG_TEMPLATE_NAME='beholdd.streaming.yaml'
readonly CONFIG_TEMPLATE_SHA256='96992cbb0fa2578b8adfcb80ff5f3cbba521b8ecb3acfcd348ac5be9a74f08b6'
readonly ICON_NAME='co.antimatter.app.svg'
readonly ICON_SHA256='a6a1d5d8ea1fa97405212cbb34c7bbe5142d6b3aa2fcf4a465f98f7814b68db3'
readonly UNINSTALLER_NAME='uninstall.sh'
readonly UNINSTALLER_SHA256='b68f0ca7dde9c619148977125fa729c2434aaba1ff41cb61e881eaa67d1a25fa'

readonly MODEL_ID='qwen3-coder-30b'
readonly MODEL_REPOSITORY='lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF'
readonly MODEL_REVISION='e9eb3e611bdcd5842e021c014b392c70746da574'
readonly MODEL_FILENAME='Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf'
readonly MODEL_BYTES=32483934528
readonly MODEL_SHA256='a4a0207f4653bfece73d9818c83acf714f5593525fe3aab7026347fd73090fcc'
readonly MODEL_URL="https://huggingface.co/$MODEL_REPOSITORY/resolve/$MODEL_REVISION/$MODEL_FILENAME?download=true"

skip_model=0
package_argument=''
checksums_argument=''
work_dir=''
stage_parent=''

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
  cat <<EOF
Usage: install.sh [OPTIONS]

Install Antimatter $VERSION for the current user.

Options:
  --package PATH    Install this local $PLATFORM tar.gz instead of the sibling
                    release archive or a download from GitHub Releases.
  --checksums PATH  Use this SHA256SUMS file. With --package, the default is a
                    file named SHA256SUMS beside the package.
  --skip-model      Do not download the 32,483,934,528-byte local model.
  -h, --help        Show this help.

The default installation downloads the pinned Qwen3-Coder 30B Q8_0 checkpoint when
it is absent. Existing models and Beholdd configuration files are never overwritten.
Do not run this installer with sudo.
EOF
}

while (($#)); do
  case "$1" in
    --package)
      (($# >= 2)) || die '--package requires a path'
      package_argument=$2
      shift 2
      ;;
    --package=*)
      package_argument=${1#*=}
      shift
      ;;
    --checksums)
      (($# >= 2)) || die '--checksums requires a path'
      checksums_argument=$2
      shift 2
      ;;
    --checksums=*)
      checksums_argument=${1#*=}
      shift
      ;;
    --skip-model)
      skip_model=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

((EUID != 0)) || die 'do not run this user-local installer with sudo or as root'
[[ $(uname -s) == Linux ]] || die 'this release supports Linux only'
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "this release requires x86_64; found $(uname -m)" ;;
esac
[[ ${HOME:-} == /* && $HOME != / ]] || die 'HOME must be an absolute, non-root path'

for command in awk basename cat chmod cmp cp date df dirname find flock getconf install ln mkdir mktemp mv python3 rm rmdir sha256sum sort stat tar; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

glibc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
[[ $glibc_version =~ ^[0-9]+\.[0-9]+ ]] || die 'GNU libc is required'
oldest_glibc=$(printf '%s\n%s\n' "$MIN_GLIBC" "$glibc_version" | sort -V | awk 'NR == 1 { print; exit }')
[[ $oldest_glibc == "$MIN_GLIBC" ]] ||
  die "GNU libc $MIN_GLIBC or newer is required; found $glibc_version"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
bin_home=${XDG_BIN_HOME:-"$HOME/.local/bin"}

for path in "$script_dir" "$data_home" "$config_home" "$state_home" "$bin_home"; do
  [[ $path == /* && $path != / && $path != *$'\n'* && $path != *$'\r'* ]] ||
    die "unsafe path: $path"
done

app_data_root="$data_home/antimatter"
releases_root="$app_data_root/releases"
target_dir="$releases_root/$VERSION"
current_link="$app_data_root/current"
models_root="$app_data_root/models"
model_dir="$models_root/$MODEL_ID"
model_file="$model_dir/$MODEL_FILENAME"
model_part="$model_file.part"
app_config_root="$config_home/antimatter"
beholdd_home="$app_config_root/beholdd"
beholdd_config="$beholdd_home/config.yaml"
beholdd_v2_config="$beholdd_home/config.v2.yaml"
wrapper_path="$bin_home/antimatter"
desktop_dir="$data_home/applications"
desktop_path="$desktop_dir/$APP_ID.desktop"
icon_theme_root="$data_home/icons/hicolor"
icon_dir="$icon_theme_root/scalable/apps"
icon_path="$icon_dir/$ICON_NAME"
state_root="$state_home/antimatter"
receipt_path="$state_root/install.json"
installed_uninstaller="$app_data_root/uninstall.sh"
lock_path="$state_root/install.lock"

for protected_path in "$app_data_root" "$releases_root" "$models_root" "$model_dir" \
  "$app_config_root" "$beholdd_home" "$state_root"; do
  [[ ! -L $protected_path ]] || die "refusing installer-managed directory symlink: $protected_path"
done
[[ ! -L $target_dir ]] || die "refusing version-directory symlink: $target_dir"
[[ ! -e $current_link || -L $current_link ]] ||
  die "refusing to replace non-symlink current path: $current_link"
if [[ -e $receipt_path || -L $receipt_path ]]; then
  [[ -f $receipt_path && ! -L $receipt_path ]] || die "refusing install-receipt symlink or special file: $receipt_path"
  [[ $(stat -c '%u' -- "$receipt_path") == "$EUID" ]] || die "existing install receipt is owned by another user: $receipt_path"
  [[ $(stat -c '%a' -- "$receipt_path") == 600 ]] || die "existing install receipt must have mode 0600: $receipt_path"
fi

umask 077
mkdir -p -- "$app_data_root" "$releases_root" "$model_dir" "$beholdd_home" "$state_root" \
  "$bin_home" "$desktop_dir" "$icon_dir"
chmod 700 -- "$app_data_root" "$releases_root" "$model_dir" "$beholdd_home" "$state_root"
chmod 700 -- "$models_root" "$app_config_root"

if [[ -e $lock_path || -L $lock_path ]]; then
  [[ -f $lock_path && ! -L $lock_path ]] || die "refusing installer-lock symlink or special file: $lock_path"
  [[ $(stat -c '%u' -- "$lock_path") == "$EUID" && $(stat -c '%h' -- "$lock_path") == 1 ]] ||
    die "existing installer lock has unsafe ownership or links: $lock_path"
fi
exec 9>>"$lock_path"
chmod 600 -- "$lock_path"
flock -n 9 || die 'another Antimatter install or uninstall is in progress'

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

cleanup_installer_tree() {
  local target=$1
  local allowed_parent=$2
  local pattern=$3
  [[ -n $target && $target == "$allowed_parent"/$pattern ]] || return 1
  [[ ! -e $target && ! -L $target ]] && return 0
  [[ -d $target && ! -L $target ]] || return 1
  [[ $(stat -c '%d' -- "$target") == "$(stat -c '%d' -- "$allowed_parent")" ]] || return 1
  reject_mountpoints_at_or_below "$target" || return 1
  find "$target" -xdev -depth -mindepth 1 -delete || return 1
  rmdir -- "$target"
}

cleanup() {
  local status=$?
  if [[ -n $stage_parent ]]; then
    cleanup_installer_tree "$stage_parent" "$releases_root" '.stage.*' ||
      warn "leaving temporary stage that could not be removed safely: $stage_parent"
  fi
  if [[ -n $work_dir ]]; then
    cleanup_installer_tree "$work_dir" "$app_data_root" '.install-work.*' ||
      warn "leaving temporary work directory that could not be removed safely: $work_dir"
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

work_dir=$(mktemp -d "$app_data_root/.install-work.XXXXXX")
chmod 700 -- "$work_dir"

fetch_release_asset() {
  local name=$1
  local destination=$2
  local download_dir
  local downloaded
  [[ $name == "$(basename -- "$name")" && $name != '.' && $name != '..' ]] ||
    die "unsafe release asset name: $name"
  command -v gh >/dev/null 2>&1 ||
    die "this private release requires the GitHub CLI; authenticate with 'gh auth login' or place $name beside install.sh"
  gh auth status --hostname github.com >/dev/null 2>&1 ||
    die "GitHub CLI is not authenticated; run 'gh auth login' or place $name beside install.sh"
  download_dir=$(mktemp -d "$work_dir/.gh-download.XXXXXX")
  chmod 700 -- "$download_dir"
  say "downloading private release asset $name with the authenticated GitHub CLI"
  gh release download "$RELEASE_TAG" --repo "$RELEASE_REPOSITORY" --pattern "$name" \
    --dir "$download_dir" || die "could not download $name from private release $RELEASE_TAG"
  downloaded="$download_dir/$name"
  [[ -f $downloaded && ! -L $downloaded ]] ||
    die "GitHub release did not provide the expected regular asset: $name"
  chmod 600 -- "$downloaded"
  mv -- "$downloaded" "$destination"
  rmdir -- "$download_dir"
}

fetch_resumable() {
  local url=$1
  local destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 \
      --continue-at - --output "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --tries=3 --continue --output-document="$destination" "$url"
  else
    die 'curl or wget is required to download the model'
  fi
}

copy_private() {
  local source=$1
  local destination=$2
  if ! cp --reflink=auto -- "$source" "$destination" 2>/dev/null; then
    cp -- "$source" "$destination"
  fi
  chmod 600 -- "$destination"
}

snapshot_existing_receipt() {
  local source=$1
  local destination=$2
  python3 - "$source" "$destination" "$APP_ID" "$EUID" "$PLATFORM" \
    "$app_data_root" "$releases_root" "$current_link" "$wrapper_path" "$desktop_path" \
    "$icon_path" "$installed_uninstaller" "$beholdd_home" "$model_file" <<'PY'
import json
import os
import re
import stat
import sys

(
    source,
    destination,
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
    if info.st_uid != expected_uid:
        raise ValueError("receipt is owned by another user")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("receipt mode is not 0600")
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
    raise SystemExit("existing install receipt has an unexpected schema")
if document["schemaVersion"] != 2 or document["appId"] != app_id:
    raise SystemExit("existing install receipt has the wrong identity")
if type(document["uid"]) is not int or document["uid"] != expected_uid:
    raise SystemExit("existing install receipt belongs to another user")
if document["platform"] != platform:
    raise SystemExit("existing install receipt has the wrong platform")
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
        raise SystemExit(f"existing install receipt has an unexpected {key} path")
timestamp = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
if not all(isinstance(document[key], str) and timestamp.fullmatch(document[key])
           for key in ("installedAt", "updatedAt")):
    raise SystemExit("existing install receipt has an invalid timestamp")
if type(document["modelVerified"]) is not bool:
    raise SystemExit("existing install receipt has an invalid model status")
version_pattern = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}")
digest_pattern = re.compile(r"[0-9a-f]{64}")
releases = document["releases"]
if not isinstance(releases, list) or not releases or len(releases) > 256:
    raise SystemExit("existing install receipt has an invalid release list")
seen = set()
for release in releases:
    if not isinstance(release, dict) or set(release) != {
        "version", "path", "packageSha256", "payloadManifestSha256"
    }:
        raise SystemExit("existing install receipt has an invalid release entry")
    version = release["version"]
    if not isinstance(version, str) or not version_pattern.fullmatch(version) or version in seen:
        raise SystemExit("existing install receipt has an invalid or duplicate version")
    seen.add(version)
    if release["path"] != os.path.join(releases_root, version):
        raise SystemExit("existing install receipt has an unexpected release path")
    if not all(isinstance(release[key], str) and digest_pattern.fullmatch(release[key])
               for key in ("packageSha256", "payloadManifestSha256")):
        raise SystemExit("existing install receipt has an invalid release digest")
current_version = document["currentVersion"]
if not isinstance(current_version, str) or current_version not in seen:
    raise SystemExit("existing install receipt current version is not installed")

output_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
with os.fdopen(output_fd, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
}

verified_sha256=''
verify_checksum_entry() {
  local asset=$1
  local checksums=$2
  local basename_value
  local hash
  local recorded_name
  local extra
  local expected=''
  local matches=0

  basename_value=$(basename -- "$asset")
  [[ -f $checksums && ! -L $checksums ]] || die "SHA256SUMS not found: $checksums"
  while IFS=' ' read -r hash recorded_name extra; do
    recorded_name=${recorded_name#\*}
    if [[ $recorded_name == "$basename_value" ]]; then
      [[ -z ${extra:-} && $hash =~ ^[[:xdigit:]]{64}$ ]] ||
        die "malformed SHA256SUMS entry for $basename_value"
      expected=${hash,,}
      ((matches += 1))
    fi
  done < "$checksums"
  ((matches == 1)) || die "SHA256SUMS must contain exactly one entry for $basename_value"

  say "verifying $basename_value with SHA256SUMS"
  verified_sha256=$(sha256sum -- "$asset" | awk '{print $1}')
  [[ $verified_sha256 == "$expected" ]] ||
    die "SHA-256 mismatch for $basename_value (expected $expected, found $verified_sha256)"
}

support_file=''
acquire_support_file() {
  local name=$1
  local expected=$2
  local candidate="$script_dir/$name"
  local actual

  if [[ ! -f $candidate || -L $candidate ]]; then
    candidate="$work_dir/$name"
    fetch_release_asset "$name" "$candidate"
  fi
  actual=$(sha256sum -- "$candidate" | awk '{print $1}')
  [[ $actual == "$expected" ]] ||
    die "unexpected $name content (expected $expected, found $actual)"
  support_file=$candidate
}

validate_release_archive() {
  local archive=$1
  python3 - "$archive" "$ARCHIVE_ROOT" <<'PY'
import pathlib
import sys
import tarfile

archive, expected_root = sys.argv[1:]
reserved = {
    f"{expected_root}/.antimatter-package.sha256",
    f"{expected_root}/.antimatter-payload-manifest.json",
}
critical = {
    f"{expected_root}/antimatter",
    f"{expected_root}/resources/vendor/beholdd/bin/beholdd",
    f"{expected_root}/resources/vendor/beholdd/manifest.json",
    f"{expected_root}/resources/vendor/llama-vulkan/manifest.json",
    f"{expected_root}/resources/vendor/llama-vulkan/runtime/llama-server",
    f"{expected_root}/resources/vendor/llama-vulkan/runtime/libggml-vulkan.so",
    f"{expected_root}/resources/vendor/llama-vulkan/runtime/LICENSE",
}
seen = set()
regular = set()
total = 0

try:
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        if not members or len(members) > 100_000:
            raise ValueError("archive has an invalid entry count")
        for member in members:
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            if not name or name.startswith("/") or "\\" in name:
                raise ValueError(f"unsafe archive path: {member.name!r}")
            raw_parts = name.rstrip("/").split("/")
            if any(part in ("", ".", "..") for part in raw_parts):
                raise ValueError(f"unsafe archive path: {member.name!r}")
            if raw_parts[0] != expected_root:
                raise ValueError(f"archive entry is outside {expected_root}: {member.name!r}")
            normalized = "/".join(raw_parts)
            if normalized in seen:
                raise ValueError(f"duplicate archive entry: {normalized}")
            seen.add(normalized)
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"links and special files are not allowed: {normalized}")
            if member.size < 0:
                raise ValueError(f"negative archive entry size: {normalized}")
            total += member.size
            if total > 2 * 1024 * 1024 * 1024:
                raise ValueError("archive expands beyond the 2 GiB safety limit")
            regular.add(normalized)
except (OSError, tarfile.TarError, ValueError) as error:
    raise SystemExit(f"invalid release archive: {error}")

collision = reserved.intersection(seen)
if collision:
    raise SystemExit(f"release archive contains reserved installer metadata: {sorted(collision)[0]}")
missing = critical.difference(regular)
if missing:
    raise SystemExit(f"release archive is missing critical file: {sorted(missing)[0]}")
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
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"critical payload path is not a regular file: {relative}")
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

llama_manifest_path, _ = regular("resources/vendor/llama-vulkan/manifest.json")
try:
    with open(llama_manifest_path, encoding="utf-8") as handle:
        llama_manifest = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid embedded llama.cpp manifest: {error}")
if llama_manifest.get("schemaVersion") != 1 or llama_manifest.get("name") != "llama-vulkan":
    raise SystemExit("embedded llama.cpp manifest has the wrong schema or identity")
source = llama_manifest.get("source")
archive = llama_manifest.get("archive")
runtime = llama_manifest.get("runtime")
if not isinstance(source, dict) or source.get("tag") != "b11223" or source.get("commit") != "4da6337767f973e2b4d0797e5b323d77d8565e4a":
    raise SystemExit("embedded llama.cpp manifest has the wrong source pin")
if not isinstance(archive, dict) or archive.get("sha256") != "d4505b5752a967e070fb418ec1d365d4448d692eccea1d7d4d0a6e75b7300025":
    raise SystemExit("embedded llama.cpp manifest has the wrong archive pin")
if not isinstance(runtime, dict) or runtime.get("sha256") != "e621c95dda21dd9b40fb1838b42f6507a90d33aea8fd1e045b0f682b5c199de8":
    raise SystemExit("embedded llama.cpp manifest has the wrong runtime tree pin")
llama_artifacts = llama_manifest.get("artifacts")
if not isinstance(llama_artifacts, list):
    raise SystemExit("embedded llama.cpp manifest has no artifact list")
critical_llama = {
    "runtime/llama-server": True,
    "runtime/libggml-vulkan.so": True,
    "runtime/LICENSE": False,
}
for artifact_relative, must_execute in critical_llama.items():
    matches = [
        item for item in llama_artifacts
        if isinstance(item, dict) and item.get("path") == artifact_relative
    ]
    if len(matches) != 1:
        raise SystemExit(f"embedded llama.cpp manifest must identify {artifact_relative} exactly once")
    artifact = matches[0]
    relative = f"resources/vendor/llama-vulkan/{artifact_relative}"
    artifact_path, artifact_info = (
        executable_elf_x86_64(relative) if must_execute else regular(relative)
    )
    artifact_hash = artifact.get("sha256")
    artifact_bytes = artifact.get("bytes")
    if not isinstance(artifact_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", artifact_hash):
        raise SystemExit(f"embedded llama.cpp manifest has an invalid SHA-256 for {artifact_relative}")
    if artifact_bytes != artifact_info.st_size:
        raise SystemExit(f"embedded llama.cpp artifact size does not match its manifest: {artifact_relative}")
    digest = hashlib.sha256()
    with open(artifact_path, "rb", buffering=1024 * 1024) as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != artifact_hash:
        raise SystemExit(f"embedded llama.cpp artifact SHA-256 does not match its manifest: {artifact_relative}")
PY
}

safe_remove_installer_tree() {
  local target=$1
  local allowed_parent=$2
  [[ $target == "$allowed_parent"/.replaced.* || $target == "$allowed_parent"/.stage.* ]] ||
    die "refusing unsafe installer cleanup path: $target"
  [[ -d $target && ! -L $target ]] || die "refusing non-directory installer cleanup path: $target"
  [[ $(stat -c '%d' -- "$target") == "$(stat -c '%d' -- "$allowed_parent")" ]] ||
    die "refusing cross-filesystem installer cleanup path: $target"
  reject_mountpoints_at_or_below "$target" ||
    die "refusing installer cleanup tree containing a mountpoint: $target"
  find "$target" -xdev -depth -mindepth 1 -delete ||
    die "could not safely remove installer tree; check for a nested mount: $target"
  rmdir -- "$target" || die "could not remove installer tree: $target"
}

available_bytes() {
  df -Pk -- "$1" | awk 'END { printf "%.0f\n", $4 * 1024 }'
}

require_free_space() {
  local path=$1
  local required=$2
  local purpose=$3
  local available
  available=$(available_bytes "$path")
  [[ $available =~ ^[0-9]+$ ]] || die "could not determine free space for $path"
  ((available >= required)) ||
    die "$purpose needs $required free bytes; only $available are available at $path"
}

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

check_managed_collision() {
  local target=$1
  local kind=$2
  if [[ -e $target || -L $target ]]; then
    [[ -f $target && ! -L $target ]] || die "refusing unexpected path: $target"
    has_managed_header "$target" "$kind" ||
      die "refusing to overwrite a file not managed by this installer: $target"
  fi
}

check_managed_collision "$wrapper_path" shell
check_managed_collision "$desktop_path" desktop
check_managed_collision "$icon_path" svg
check_managed_collision "$installed_uninstaller" shell

existing_receipt_snapshot=''
if [[ -e $receipt_path || -L $receipt_path ]]; then
  existing_receipt_snapshot="$work_dir/existing-install.json"
  snapshot_existing_receipt "$receipt_path" "$existing_receipt_snapshot" ||
    die "existing install receipt is not trustworthy: $receipt_path"
fi

# Resolve the application archive and its checksum list. A sibling package is preferred so the
# exact files produced by `npm run release:linux` install without any network access.
remote_package=0
if [[ -n $package_argument ]]; then
  [[ -f $package_argument && ! -L $package_argument ]] || die "package not found: $package_argument"
  package_source=$package_argument
elif [[ -f $script_dir/$PACKAGE_NAME && ! -L $script_dir/$PACKAGE_NAME ]]; then
  package_source="$script_dir/$PACKAGE_NAME"
else
  remote_package=1
  package_source="$work_dir/$PACKAGE_NAME"
fi

if [[ -n $checksums_argument ]]; then
  [[ -f $checksums_argument && ! -L $checksums_argument ]] ||
    die "checksum file not found: $checksums_argument"
  checksums_source=$checksums_argument
elif ((remote_package)); then
  checksums_source="$work_dir/SHA256SUMS"
else
  checksums_source="$(dirname -- "$package_source")/SHA256SUMS"
  [[ -f $checksums_source && ! -L $checksums_source ]] ||
    die "SHA256SUMS must be beside the local package (or supplied with --checksums)"
fi

if ((remote_package)); then
  if [[ -n $checksums_argument ]]; then
    copy_private "$checksums_source" "$work_dir/SHA256SUMS"
  else
    fetch_release_asset 'SHA256SUMS' "$work_dir/SHA256SUMS"
  fi
  fetch_release_asset "$PACKAGE_NAME" "$package_source"
else
  package_copy="$work_dir/$(basename -- "$package_source")"
  copy_private "$package_source" "$package_copy"
  package_source=$package_copy
  copy_private "$checksums_source" "$work_dir/SHA256SUMS"
fi
checksums_source="$work_dir/SHA256SUMS"

verify_checksum_entry "$package_source" "$checksums_source"
package_sha256=$verified_sha256

# Resolve and pin every small support asset before installing the payload or beginning the large
# model transfer. A missing release asset should fail fast, not after a 32 GB download.
acquire_support_file "$CONFIG_TEMPLATE_NAME" "$CONFIG_TEMPLATE_SHA256"
config_template=$support_file
acquire_support_file "$ICON_NAME" "$ICON_SHA256"
icon_source=$support_file
acquire_support_file "$UNINSTALLER_NAME" "$UNINSTALLER_SHA256"
uninstaller_source=$support_file

# One GiB covers the compressed archive and its FUSE-free extracted payload. The exact model space
# check happens separately and accounts for a resumable partial download.
require_free_space "$app_data_root" 1073741824 'the application installation'

validate_release_archive "$package_source"

stage_parent=$(mktemp -d "$releases_root/.stage.$VERSION.XXXXXX")
chmod 700 -- "$stage_parent"
tar --extract --gzip --file="$package_source" --directory="$stage_parent" \
  --no-same-owner --no-same-permissions
payload_dir="$stage_parent/$ARCHIVE_ROOT"
payload_executable="$payload_dir/antimatter"
[[ -d $payload_dir && ! -L $payload_dir ]] || die 'release archive is missing its payload directory'
package_marker="$payload_dir/.antimatter-package.sha256"
payload_manifest="$payload_dir/.antimatter-payload-manifest.json"
[[ ! -e $package_marker && ! -L $package_marker ]] ||
  die 'release archive contains the reserved package marker'
[[ ! -e $payload_manifest && ! -L $payload_manifest ]] ||
  die 'release archive contains the reserved payload manifest'

# Validate both ELF identities and Beholdd's embedded artifact hash before normalizing private
# permissions. A checksum-valid archive with the wrong binary or native architecture is unusable.
validate_critical_executables "$payload_dir"
chmod -R u+rwX,u-s,g-s,o-t,go-rwx -- "$payload_dir"
validate_critical_executables "$payload_dir"

staged_manifest="$work_dir/payload-manifest.json"
build_payload_manifest "$payload_dir" "$staged_manifest"
payload_manifest_sha256=$(sha256sum -- "$staged_manifest" | awk '{print $1}')
install -m 600 -- "$staged_manifest" "$payload_manifest"
printf '%s\n' "$package_sha256" > "$work_dir/package.sha256"
install -m 600 -- "$work_dir/package.sha256" "$package_marker"

if [[ -e $target_dir || -L $target_dir ]]; then
  [[ -d $target_dir && ! -L $target_dir ]] || die "refusing unexpected version path: $target_dir"
  [[ $(stat -c '%u' -- "$target_dir") == "$EUID" ]] ||
    die "existing version directory is owned by another user: $target_dir"
  [[ $(stat -c '%d' -- "$target_dir") == "$(stat -c '%d' -- "$releases_root")" ]] ||
    die "existing version is a cross-filesystem mount and cannot be repaired safely: $target_dir"
  reject_mountpoints_at_or_below "$target_dir" ||
    die "existing version contains a mountpoint and cannot be repaired safely: $target_dir"
  for metadata_path in "$target_dir/.antimatter-package.sha256" "$target_dir/.antimatter-payload-manifest.json"; do
    [[ ! -L $metadata_path ]] || die "existing installer metadata is a symlink: $metadata_path"
    [[ ! -e $metadata_path || -f $metadata_path ]] ||
      die "existing installer metadata is a special file: $metadata_path"
  done

  existing_manifest="$work_dir/existing-payload-manifest.json"
  if ! build_payload_manifest "$target_dir" "$existing_manifest"; then
    die "existing version contains unsafe entries and was not replaced: $target_dir"
  fi
  if cmp -s -- "$staged_manifest" "$existing_manifest"; then
    validate_critical_executables "$target_dir"
    manifest_tmp=$(mktemp "$target_dir/.payload-manifest.XXXXXX")
    marker_tmp=$(mktemp "$target_dir/.package-sha.XXXXXX")
    install -m 600 -- "$staged_manifest" "$manifest_tmp"
    install -m 600 -- "$work_dir/package.sha256" "$marker_tmp"
    mv -f -- "$manifest_tmp" "$target_dir/.antimatter-payload-manifest.json"
    mv -f -- "$marker_tmp" "$target_dir/.antimatter-package.sha256"
    say "application version $VERSION is already installed and passed a complete payload verification"
  else
    replaced_dir="$releases_root/.replaced.$VERSION.$$.${RANDOM}"
    [[ ! -e $replaced_dir && ! -L $replaced_dir ]] ||
      die "could not allocate a safe replacement path: $replaced_dir"
    say "repairing damaged application payload: $target_dir"
    mv -- "$target_dir" "$replaced_dir"
    if ! mv -- "$payload_dir" "$target_dir"; then
      mv -- "$replaced_dir" "$target_dir" || true
      die 'could not activate the verified replacement payload'
    fi
    validate_critical_executables "$target_dir"
    safe_remove_installer_tree "$replaced_dir" "$releases_root"
    say "repaired application version $VERSION from the verified release archive"
  fi
else
  mv -- "$payload_dir" "$target_dir"
  validate_critical_executables "$target_dir"
  say "installed application payload: $target_dir"
fi

model_installed=false
discard_model_part() {
  local reason=$1
  [[ $model_part == "$model_dir/$MODEL_FILENAME.part" && -f $model_part && ! -L $model_part ]] ||
    die "refusing to discard an unexpected partial-model path: $model_part"
  warn "$reason"
  rm -f -- "$model_part"
  [[ ! -e $model_part && ! -L $model_part ]] || die "could not discard invalid partial model: $model_part"
  say 'the invalid .part file was removed; the pinned download can restart safely'
}

if ((skip_model)); then
  say 'skipping model download by request'
else
  if [[ -r /proc/meminfo ]]; then
    available_memory_kib=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)
    if [[ $available_memory_kib =~ ^[0-9]+$ ]] &&
      ((available_memory_kib * 1024 < 14000000000)); then
      warn "the streaming profile requests a 14,000,000,000-byte runtime budget, but Linux currently reports only $((available_memory_kib * 1024)) bytes available"
      warn 'the model will still be downloaded; use --skip-model instead if this machine will use an external source'
    fi
  fi
  [[ ! -L $model_file ]] || die "refusing model-file symlink: $model_file"
  [[ ! -L $model_part ]] || die "refusing partial-model symlink: $model_part"

  if [[ -e $model_file ]]; then
    [[ -f $model_file ]] || die "existing model path is not a regular file: $model_file"
    existing_size=$(stat -c '%s' -- "$model_file")
    [[ $existing_size == "$MODEL_BYTES" ]] ||
      die "existing model has size $existing_size, expected $MODEL_BYTES; it was not overwritten"
    say 'verifying existing model SHA-256 (this can take several minutes)'
    existing_hash=$(sha256sum -- "$model_file" | awk '{print $1}')
    [[ $existing_hash == "$MODEL_SHA256" ]] ||
      die "existing model failed SHA-256 verification; it was not overwritten: $model_file"
    chmod 600 -- "$model_file"
    model_installed=true
    say 'existing model is valid; download not needed'
  else
    partial_size=0
    if [[ -e $model_part ]]; then
      [[ -f $model_part ]] || die "partial model path is not a regular file: $model_part"
      partial_size=$(stat -c '%s' -- "$model_part")
      if ((partial_size > MODEL_BYTES)); then
        discard_model_part "partial model has $partial_size bytes, larger than the pinned $MODEL_BYTES-byte artifact"
        partial_size=0
      elif ((partial_size == MODEL_BYTES)); then
        say 'verifying completed partial model before resuming'
        partial_hash=$(sha256sum -- "$model_part" | awk '{print $1}')
        if [[ $partial_hash != "$MODEL_SHA256" ]]; then
          discard_model_part 'completed partial model failed SHA-256 verification'
          partial_size=0
        fi
      fi
    fi
    remaining_bytes=$((MODEL_BYTES - partial_size))
    require_free_space "$model_dir" $((remaining_bytes + 536870912)) 'the model download'

    if ((remaining_bytes > 0)); then
      say "downloading $MODEL_FILENAME"
      say "pinned revision: $MODEL_REVISION"
      say "resuming at byte $partial_size of $MODEL_BYTES"
      fetch_resumable "$MODEL_URL" "$model_part"
    fi

    downloaded_size=$(stat -c '%s' -- "$model_part")
    [[ $downloaded_size == "$MODEL_BYTES" ]] ||
      die "model download has size $downloaded_size, expected $MODEL_BYTES; partial file was preserved"
    say 'verifying downloaded model SHA-256 (this can take several minutes)'
    downloaded_hash=$(sha256sum -- "$model_part" | awk '{print $1}')
    if [[ $downloaded_hash != "$MODEL_SHA256" ]]; then
      discard_model_part 'model SHA-256 mismatch after completing the resumable download'
      die 'model verification failed; rerun the installer to begin a clean download'
    fi
    chmod 600 -- "$model_part"
    mv -n -- "$model_part" "$model_file"
    [[ ! -e $model_part && -f $model_file ]] ||
      die "model destination appeared during installation; no existing file was overwritten: $model_file"
    model_installed=true
    say "installed verified model: $model_file"
  fi
fi

if [[ -e $beholdd_v2_config || -L $beholdd_v2_config ]]; then
  say "preserving existing Beholdd configuration: $beholdd_v2_config"
elif [[ -e $beholdd_config || -L $beholdd_config ]]; then
  say "preserving existing Beholdd configuration: $beholdd_config"
else
  config_tmp=$(mktemp "$beholdd_home/.config.yaml.XXXXXX")
  yaml_model_path=${model_file//\'/\'\'}
  replaced_path=0
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "    path: '@MODEL_PATH@'" ]]; then
      printf "    path: '%s'\n" "$yaml_model_path"
      ((replaced_path += 1))
    else
      printf '%s\n' "$line"
    fi
  done < "$config_template" > "$config_tmp"
  ((replaced_path == 1)) || die 'streaming configuration template has an invalid model placeholder'
  chmod 600 -- "$config_tmp"
  mv -n -- "$config_tmp" "$beholdd_config"
  [[ ! -e $config_tmp && -f $beholdd_config ]] ||
    die "Beholdd configuration appeared during installation and was not overwritten: $beholdd_config"
  say "installed Beholdd streaming configuration: $beholdd_config"
fi

icon_tmp=$(mktemp "$icon_dir/.co.antimatter.app.svg.XXXXXX")
install -m 644 -- "$icon_source" "$icon_tmp"
mv -f -- "$icon_tmp" "$icon_path"

uninstaller_tmp=$(mktemp "$app_data_root/.uninstall.sh.XXXXXX")
install -m 700 -- "$uninstaller_source" "$uninstaller_tmp"
mv -f -- "$uninstaller_tmp" "$installed_uninstaller"

printf -v quoted_app '%q' "$app_data_root/current/antimatter"
printf -v quoted_beholdd_home '%q' "$beholdd_home"
printf -v quoted_llama_vulkan_model '%q' "$model_file"
wrapper_tmp=$(mktemp "$bin_home/.antimatter.XXXXXX")
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' "# $MANAGED_MARKER"
  printf '%s\n' 'set -Eeuo pipefail'
  printf 'export BEHOLDD_HOME=%s\n' "$quoted_beholdd_home"
  printf 'export ANTIMATTER_LLAMA_VULKAN_MODEL=%s\n' "$quoted_llama_vulkan_model"
  printf 'readonly antimatter_executable=%s\n' "$quoted_app"
  printf '%s\n' '[[ -x $antimatter_executable ]] || {'
  printf '%s\n' '  printf "Antimatter is not installed at %s\\n" "$antimatter_executable" >&2'
  printf '%s\n' '  exit 1'
  printf '%s\n' '}'
  printf '%s\n' 'exec "$antimatter_executable" --class=Antimatter "$@"'
} > "$wrapper_tmp"
chmod 700 -- "$wrapper_tmp"
mv -f -- "$wrapper_tmp" "$wrapper_path"

desktop_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  value=${value//\`/\\\`}
  value=${value//%/%%}
  printf '%s' "$value"
}

desktop_exec=$(desktop_escape "$wrapper_path")
desktop_tmp=$(mktemp "$desktop_dir/.co.antimatter.app.desktop.XXXXXX")
cat > "$desktop_tmp" <<EOF
# $MANAGED_MARKER
[Desktop Entry]
Version=1.0
Type=Application
Name=Antimatter
Comment=Multi-model AI coding assistant
Exec="$desktop_exec"
Icon=$APP_ID
Terminal=false
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=Antimatter
EOF
chmod 644 -- "$desktop_tmp"
mv -f -- "$desktop_tmp" "$desktop_path"

current_tmp="$app_data_root/.current.$$.${RANDOM}"
ln -s -- "$target_dir" "$current_tmp"
mv -Tf -- "$current_tmp" "$current_link"

receipt_tmp=$(mktemp "$state_root/.install.json.XXXXXX")
receipt_now=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
python3 - "$existing_receipt_snapshot" "$receipt_tmp" "$receipt_now" "$APP_ID" "$EUID" \
  "$PLATFORM" "$app_data_root" "$current_link" "$VERSION" "$wrapper_path" "$desktop_path" \
  "$icon_path" "$installed_uninstaller" "$beholdd_home" "$model_file" "$model_installed" \
  "$target_dir" "$package_sha256" "$payload_manifest_sha256" "$skip_model" "$MODEL_BYTES" <<'PY'
import json
import os
import stat
import sys

(
    previous_path,
    output_path,
    now,
    app_id,
    uid,
    platform,
    data_root,
    current,
    version,
    launcher,
    desktop,
    icon,
    uninstaller,
    beholdd_home,
    model,
    model_verified,
    release_path,
    package_sha256,
    payload_manifest_sha256,
    skip_model,
    model_bytes,
) = sys.argv[1:]

previous = None
if previous_path:
    with open(previous_path, encoding="utf-8") as handle:
        previous = json.load(handle)
    installed_at = previous["installedAt"]
    releases = {item["version"]: item for item in previous["releases"]}
else:
    installed_at = now
    releases = {}

# An in-app update installs with --skip-model rather than re-hash a 30 GiB checkpoint it already
# verified. Skipping is not evidence against the model: if the last receipt verified it and the
# same file is still there at its exact size, it stays verified.
model_is_verified = model_verified == "true"
if not model_is_verified and skip_model == "1" and previous and previous.get("modelVerified") is True and previous.get("model") == model:
    try:
        model_stat = os.lstat(model)
        model_is_verified = stat.S_ISREG(model_stat.st_mode) and model_stat.st_size == int(model_bytes)
    except OSError:
        model_is_verified = False
releases[version] = {
    "version": version,
    "path": release_path,
    "packageSha256": package_sha256,
    "payloadManifestSha256": payload_manifest_sha256,
}
document = {
    "schemaVersion": 2,
    "appId": app_id,
    "uid": int(uid),
    "platform": platform,
    "installedAt": installed_at,
    "updatedAt": now,
    "dataRoot": data_root,
    "current": current,
    "currentVersion": version,
    "launcher": launcher,
    "desktopEntry": desktop,
    "icon": icon,
    "uninstaller": uninstaller,
    "beholddHome": beholdd_home,
    "model": model,
    "modelVerified": model_is_verified,
    "releases": [releases[key] for key in sorted(releases)],
}
with open(output_path, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=True, indent=2, sort_keys=True)
    handle.write("\n")
PY
chmod 600 -- "$receipt_tmp"
mv -f -- "$receipt_tmp" "$receipt_path"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop_path" || warn "desktop entry validation reported a problem: $desktop_path"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [[ -f $icon_theme_root/index.theme ]]; then
  gtk-update-icon-cache -f -t "$icon_theme_root" >/dev/null 2>&1 || true
fi

say "Antimatter $VERSION is installed"
say "launch command: $wrapper_path"
say "desktop entry: $desktop_path"
say "uninstall command: $installed_uninstaller"
if ((skip_model)); then
  warn "the local model was skipped; install it later or configure an external inference source"
else
  say "local model: $model_file"
fi
case ":${PATH:-}:" in
  *":$bin_home:"*) ;;
  *) warn "$bin_home is not currently on PATH; use the desktop launcher or add it to PATH" ;;
esac

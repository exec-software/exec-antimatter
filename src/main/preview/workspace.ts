import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { insideWorkspace } from '../../../mcp/workspace';

/** The canonical workspace path written beside every new live image preview. */
export const canonicalWorkspace = (workspace: string): string => realpathSync(resolve(workspace));

export interface ImagePreviewRequest {
  path: string;
  /** The canonical workspace path recorded when the image was shown. Missing only on legacy rows. */
  workspace?: string | null;
}

export interface BoundPreviewImage {
  workspace: string;
  target: string;
}

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

/** Directory metadata is durable only after the entry containing the rename is flushed. */
function fsyncDirectory(descriptor: number): void {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
  }
}

/**
 * Atomically writes binary output beneath a workspace without following a replaced target.
 *
 * The screenshot bytes first go to an exclusively-created sibling. Renaming that regular file
 * over the destination replaces a last-component symlink rather than following it, and keeps an
 * existing screenshot whole if the process exits during the write. On Linux, where the release
 * ships today, both names are addressed through an open directory descriptor; swapping a parent
 * pathname for a symlink after validation therefore cannot redirect either operation.
 */
export function writeWorkspaceBinary(workspaceValue: string, candidate: string, bytes: Buffer): string {
  const workspace = canonicalWorkspace(workspaceValue);
  const target = insideWorkspace(workspace, candidate);
  const requestedParent = dirname(target);

  // Creating directories cannot expose pixels: containment is re-proved before the first byte is
  // written. Existing symlink ancestors are already rejected by insideWorkspace above.
  mkdirSync(requestedParent, { recursive: true });
  const parent = realpathSync(requestedParent);
  insideWorkspace(workspace, parent);

  let directory: number | null = null;
  let temporary = '';
  try {
    const heldParent = statSync(parent);
    if (!heldParent.isDirectory()) throw new Error('The screenshot destination parent is not a directory.');

    try {
      directory = openSync(
        parent,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      // Windows does not consistently allow opening a directory handle. The canonical path plus
      // identity checks below remain the portable fallback; Linux must have the descriptor because
      // its /proc path is what closes the parent-symlink swap window for the shipping build.
      if (process.platform === 'linux') throw error;
    }
    if (directory !== null && !sameFile(heldParent, fstatSync(directory))) {
      throw new Error('The screenshot destination changed while it was being opened; try again.');
    }

    const verifyParent = (): void => {
      const namedParent = statSync(realpathSync(requestedParent));
      if (!sameFile(heldParent, namedParent)) {
        throw new Error('The screenshot destination changed while it was being written; try again.');
      }
      insideWorkspace(workspace, realpathSync(requestedParent));
    };
    verifyParent();

    // /proc/self/fd pins traversal to the directory inode rather than its mutable pathname. The
    // metadata check above remains the portable fallback for platforms without that facility.
    let operationParent = parent;
    if (process.platform === 'linux') {
      if (directory === null) throw new Error('The screenshot destination directory could not be pinned.');
      const pinned = `/proc/self/fd/${directory}`;
      const pinnedParent = realpathSync(pinned);
      insideWorkspace(workspace, pinnedParent);
      if (!sameFile(heldParent, statSync(pinnedParent))) {
        throw new Error('The screenshot destination changed while it was being opened; try again.');
      }
      operationParent = pinned;
    }

    const name = basename(target);
    temporary = join(operationParent, `.${name}.${randomUUID()}.antimatter.tmp`);
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o666
    );
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    verifyParent();
    renameSync(temporary, join(operationParent, name));
    temporary = '';
    if (directory !== null) fsyncDirectory(directory);

    const written = lstatSync(join(operationParent, name));
    if (!written.isFile() || written.isSymbolicLink()) {
      throw new Error('The screenshot destination did not become a regular file.');
    }
    return target;
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (directory !== null) closeSync(directory);
  }
}

/**
 * Resolves an image only when its recorded workspace is the workspace currently selected.
 *
 * This binds a live preview to a canonical path, not to a historical snapshot of its contents.
 * If a workspace is deliberately replaced at the same path, previews show the current file there.
 *
 * The renderer is not trusted to nominate an arbitrary root. It may repeat either the configured
 * spelling of the current workspace or the canonical spelling recorded by a new preview, and both
 * are resolved once before the candidate path is bounded beneath it. Legacy previews with no
 * recorded root are deliberately not guessed against whichever workspace happens to be current.
 */
export function boundPreviewImage(currentWorkspace: string, request: ImagePreviewRequest): BoundPreviewImage {
  const path = String(request?.path ?? '');
  if (!path.trim()) throw new Error('No image path was provided.');

  const recorded = typeof request?.workspace === 'string' ? request.workspace.trim() : '';
  if (!recorded) {
    throw new Error(
      'This preview predates workspace-bound images and cannot be reopened safely. Rerun preview_image or take a new screenshot.'
    );
  }

  const configured = resolve(currentWorkspace);
  const canonical = canonicalWorkspace(configured);
  const claimed = resolve(recorded);
  // Check the spelling before realpath so an untrusted renderer cannot use this endpoint to probe
  // whether arbitrary directories elsewhere on the machine exist.
  if (claimed !== configured && claimed !== canonical) {
    throw new Error('This image belongs to another workspace. Switch back to that workspace to open it.');
  }

  let claimedCanonical: string;
  try {
    claimedCanonical = canonicalWorkspace(claimed);
  } catch {
    throw new Error('The workspace recorded for this image is no longer available.');
  }
  if (claimedCanonical !== canonical) {
    throw new Error('This image belongs to another workspace. Switch back to that workspace to open it.');
  }
  return { workspace: canonical, target: insideWorkspace(canonical, path) };
}

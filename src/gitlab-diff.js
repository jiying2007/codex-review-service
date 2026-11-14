'use strict';

const { quoteGitPath, parseGitDiffHeaderPaths, parseGitFileHeaderPath } = require('./codex-safe-core/context-builder');

function invalidDiff(message) {
  return Object.assign(new Error(message), { code: 'EGITLABDIFFPATH' });
}

// GitLab old_path/new_path are raw repository paths, not Windows paths or
// already-quoted Git headers. Preserve their identity and encode only here.
function toUnifiedReviewBlock(file) {
  const oldPath = String(file.old_path || file.new_path || file.path || '');
  const newPath = String(file.new_path || file.old_path || file.path || '');
  if (!oldPath || !newPath) throw invalidDiff('Provider diff is missing its repository path.');
  const oldHeader = file.new_file === true ? '/dev/null' : quoteGitPath(`a/${oldPath}`);
  const newHeader = file.deleted_file === true ? '/dev/null' : quoteGitPath(`b/${newPath}`);
  const raw = String(file.diff || '');
  const firstHunk = raw.search(/^@@ /m);
  const metadata = firstHunk < 0 ? raw : raw.slice(0, firstHunk);
  const headers = [...raw.matchAll(/^diff --git .*$/gm)];
  if (headers.length) {
    const paths = parseGitDiffHeaderPaths(headers[0][0]);
    if (headers.length !== 1 || headers[0].index !== 0 || !paths || paths.old !== oldPath || paths.new !== newPath) {
      throw invalidDiff('Provider diff headers do not match the declared repository paths.');
    }
  }
  for (const [prefix, expected] of [['--- ', file.new_file === true ? '/dev/null' : oldPath], ['+++ ', file.deleted_file === true ? '/dev/null' : newPath]]) {
    const lines = metadata.split('\n').filter(line => line.startsWith(prefix));
    if (lines.length > 1) throw invalidDiff('Provider diff contains repeated file headers.');
    if (lines.length) {
      let actual;
      try { actual = parseGitFileHeaderPath(lines[0], prefix); } catch { throw invalidDiff('Provider diff contains an invalid file header.'); }
      if (actual !== expected) throw invalidDiff('Provider file header does not match its declared repository path.');
    }
  }
  // Rebuild metadata from authoritative raw paths. Existing file headers and
  // rename text must not create an alternative identity for the same hunk.
  const hunks = firstHunk < 0 ? '' : raw.slice(firstHunk);
  return [`diff --git ${quoteGitPath(`a/${oldPath}`)} ${quoteGitPath(`b/${newPath}`)}`, `--- ${oldHeader}`, `+++ ${newHeader}`, hunks].filter(Boolean).join('\n');
}

module.exports = { toUnifiedReviewBlock };

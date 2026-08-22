'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function encodeProject(value) {
  return encodeURIComponent(String(value));
}

function nextPageFromHeaders(headers, currentPage) {
  const xNextPage = String(headers.get('x-next-page') || '').trim();
  if (xNextPage) {
    const next = Number(xNextPage);
    return Number.isInteger(next) && next > currentPage ? next : null;
  }

  const link = String(headers.get('link') || '');
  for (const part of link.split(',')) {
    if (!/;\s*rel="?next"?/i.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match) return null;
    try {
      const next = Number(new URL(match[1]).searchParams.get('page'));
      return Number.isInteger(next) && next > currentPage ? next : null;
    } catch {
      return null;
    }
  }
  return 0;
}

function normalizeDiffVersionSize(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const size = Number(text);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

class GitLabClient {
  constructor(config) {
    this.config = config;
    this.apiUrl = config.gitlabApiUrl;
    this.token = config.gitlabToken;
    this.statusName = config.statusName;
  }

  async request(method, pathname, { query, body, expected = [200], accept = 'json' } = {}) {
    const url = new URL(this.apiUrl + pathname);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'PRIVATE-TOKEN': this.token,
          'User-Agent': 'codex-review-service/1.0',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.gitlabRequestTimeoutMs)
      });
    } catch (cause) {
      const error = new Error(`GitLab ${method} ${pathname} network failure`);
      error.code = 'EGITLABNETWORK';
      error.cause = cause;
      throw error;
    }

    const text = await response.text();
    if (!expected.includes(response.status)) {
      const error = new Error(`GitLab ${method} ${pathname} failed with ${response.status}`);
      error.code = 'EGITLABHTTP';
      error.status = response.status;
      error.responseBody = text.slice(0, 2000);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
      }
      throw error;
    }

    let data = text;
    if (accept === 'json') {
      if (!text) data = null;
      else {
        try {
          data = JSON.parse(text);
        } catch (cause) {
          const error = new Error(`GitLab ${method} ${pathname} returned invalid JSON`);
          error.code = 'EGITLABJSON';
          error.cause = cause;
          throw error;
        }
      }
    }
    return { data, status: response.status, headers: response.headers };
  }

  async getVersion() {
    return (await this.request('GET', '/version')).data;
  }

  async getMergeRequest(projectId, iid) {
    return (await this.request('GET', `/projects/${encodeProject(projectId)}/merge_requests/${iid}`)).data;
  }

  async paginated(pathname, query = {}) {
    const items = [];
    let page = 1;

    while (page <= this.config.gitlabMaxPages) {
      const response = await this.request('GET', pathname, {
        query: { ...query, per_page: 100, page }
      });
      if (!Array.isArray(response.data)) {
        const error = new Error('GitLab pagination response is not an array');
        error.code = 'EGITLABJSON';
        throw error;
      }
      items.push(...response.data);

      const nextPage = nextPageFromHeaders(response.headers, page);
      if (nextPage === 0) return { items, complete: true };
      if (!nextPage) return { items, complete: false };
      page = nextPage;
    }
    return { items, complete: false };
  }

  listMergeRequestDiffs(projectId, iid) {
    return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/diffs`);
  }

  listMergeRequestVersions(projectId, iid) {
    return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/versions`);
  }

  async validateMergeRequestDiffCoverage(projectId, iid, mr, diffResult) {
    if (!diffResult?.complete || !Array.isArray(diffResult.items)) {
      return { complete: false, reason: 'diff_pagination' };
    }

    const versions = await this.listMergeRequestVersions(projectId, iid);
    if (!versions.complete) return { complete: false, reason: 'diff_versions_pagination' };

    const headSha = String(mr.diff_refs?.head_sha || mr.sha || '');
    const startSha = String(mr.diff_refs?.start_sha || '');
    const baseSha = String(mr.diff_refs?.base_sha || '');
    const version = versions.items.find(item =>
      String(item.head_commit_sha || '') === headSha &&
      String(item.start_commit_sha || '') === startSha &&
      (!baseSha || String(item.base_commit_sha || '') === baseSha)
    );
    if (!version) return { complete: false, reason: 'diff_version_not_found' };
    if (String(version.state || '') !== 'collected') {
      return { complete: false, reason: `diff_version_state:${String(version.state || 'unknown')}` };
    }

    const realSize = normalizeDiffVersionSize(version.real_size);
    if (realSize === null) return { complete: false, reason: 'diff_version_real_size_unknown' };
    if (realSize !== diffResult.items.length) {
      return {
        complete: false,
        reason: 'diff_version_size_mismatch',
        realSize,
        returnedSize: diffResult.items.length
      };
    }
    return { complete: true, reason: 'complete', realSize };
  }

  listOpenMergeRequests(projectId) {
    return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests`, {
      state: 'opened',
      scope: 'all'
    });
  }

  listNotes(projectId, iid) {
    return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`, {
      sort: 'asc'
    });
  }

  async createNote(projectId, iid, body) {
    return (await this.request('POST', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`, {
      body: { body },
      expected: [201]
    })).data;
  }

  async updateNote(projectId, iid, noteId, body) {
    return (await this.request('PUT', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes/${noteId}`, {
      body: { body }
    })).data;
  }

  async upsertSummary(projectId, iid, body) {
    const marker = '<!-- codex-review-service:summary -->';
    const result = await this.listNotes(projectId, iid);
    if (!result.complete) {
      const error = new Error('Could not exhaustively scan MR notes for the summary marker');
      error.code = 'EGITLABPAGINATION';
      throw error;
    }
    const existing = result.items.find(note => typeof note.body === 'string' && note.body.includes(marker));
    const rendered = `${body}\n\n${marker}`;
    return existing
      ? this.updateNote(projectId, iid, existing.id, rendered)
      : this.createNote(projectId, iid, rendered);
  }

  async createDiscussion(projectId, iid, finding, diffRefs, oldPath, newPath) {
    const position = {
      position_type: 'text',
      base_sha: diffRefs.base_sha,
      start_sha: diffRefs.start_sha,
      head_sha: diffRefs.head_sha,
      old_path: oldPath || newPath,
      new_path: newPath || oldPath
    };
    if (finding.side === 'old') position.old_line = finding.line;
    else position.new_line = finding.line;

    const body = `**${finding.severity.toUpperCase()} · ${finding.title}**\n\n${finding.description}` +
      (finding.suggestion ? `\n\n**Suggestion:** ${finding.suggestion}` : '') +
      `\n\n<!-- codex-review-service:finding:${finding.fingerprint} -->`;
    return (await this.request('POST', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions`, {
      body: { body, position },
      expected: [201]
    })).data;
  }

  async getDiscussion(projectId, iid, discussionId) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`, {
      expected: [200, 404]
    });
    return response.status === 404 ? null : response.data;
  }

  async setDiscussionResolved(projectId, iid, discussionId, resolved) {
    return (await this.request('PUT', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`, {
      body: { resolved: Boolean(resolved) }
    })).data;
  }

  async getProjectMember(projectId, userId) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/members/all/${encodeURIComponent(userId)}`, {
      expected: [200, 404]
    });
    return response.status === 404 ? null : response.data;
  }

  async getRepositoryFileRaw(projectId, filePath, ref) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/repository/files/${encodeURIComponent(filePath)}/raw`, {
      query: { ref },
      expected: [200, 404],
      accept: 'text'
    });
    return response.status === 404 ? null : response.data;
  }

  async setCommitStatus(projectId, sha, state, description, ref = '') {
    const doRequest = () => this.request('POST', `/projects/${encodeProject(projectId)}/statuses/${sha}`, {
      query: {
        state,
        name: this.statusName,
        description: String(description || '').slice(0, 255),
        ref,
        target_url: this.config.statusTargetUrl || undefined
      },
      expected: [201]
    });
    let lastError;
    for (let attempt = 0; attempt < this.config.gitlabStatusRetries; attempt += 1) {
      try {
        return (await doRequest()).data;
      } catch (error) {
        lastError = error;
        if (error.status !== 409 || attempt === this.config.gitlabStatusRetries - 1) throw error;
        await sleep(Math.min(2000, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

function discussionResolved(discussion) {
  if (!discussion || !Array.isArray(discussion.notes)) return null;
  const note = discussion.notes.find(item => item?.resolvable === true);
  return note ? Boolean(note.resolved) : null;
}

module.exports = {
  GitLabClient,
  discussionResolved,
  encodeProject,
  nextPageFromHeaders,
  normalizeDiffVersionSize
};

'use strict';

class GitLabClient {
  constructor(config) {
    this.apiUrl = config.gitlabApiUrl;
    this.token = config.gitlabToken;
    this.statusName = config.statusName;
  }

  async request(method, pathname, { query, body, expected = [200] } = {}) {
    const url = new URL(this.apiUrl + pathname);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'User-Agent': 'codex-review-service/0.1',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    if (!expected.includes(response.status)) {
      const error = new Error(`GitLab ${method} ${pathname} failed with ${response.status}`);
      error.status = response.status;
      error.responseBody = text.slice(0, 2000);
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  getMergeRequest(projectId, iid) {
    return this.request('GET', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}`);
  }

  async listMergeRequestDiffs(projectId, iid) {
    const all = [];
    for (let page = 1; page <= 100; page += 1) {
      const rows = await this.request('GET', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/diffs`, {
        query: { per_page: 100, page }
      });
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  }

  async listNotes(projectId, iid) {
    const all = [];
    for (let page = 1; page <= 100; page += 1) {
      const rows = await this.request('GET', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, {
        query: { per_page: 100, page, sort: 'asc' }
      });
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  }

  createNote(projectId, iid, body) {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, {
      body: { body }, expected: [201]
    });
  }

  updateNote(projectId, iid, noteId, body) {
    return this.request('PUT', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes/${noteId}`, {
      body: { body }
    });
  }

  async upsertSummary(projectId, iid, body) {
    const marker = '<!-- codex-review-service:summary -->';
    const notes = await this.listNotes(projectId, iid);
    const existing = notes.find(note => typeof note.body === 'string' && note.body.includes(marker));
    return existing
      ? this.updateNote(projectId, iid, existing.id, `${body}\n\n${marker}`)
      : this.createNote(projectId, iid, `${body}\n\n${marker}`);
  }

  createDiscussion(projectId, iid, finding, diffRefs, oldPath, newPath) {
    const position = {
      position_type: 'text',
      base_sha: diffRefs.base_sha,
      start_sha: diffRefs.start_sha,
      head_sha: diffRefs.head_sha,
      old_path: oldPath || newPath,
      new_path: newPath || oldPath,
      new_line: finding.line
    };
    const body = `**${finding.severity.toUpperCase()} · ${finding.title}**\n\n${finding.description}` +
      (finding.suggestion ? `\n\n**Suggestion:** ${finding.suggestion}` : '') +
      `\n\n<!-- codex-review-service:finding:${finding.fingerprint} -->`;
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/discussions`, {
      body: { body, position }, expected: [201]
    });
  }

  resolveDiscussion(projectId, iid, discussionId) {
    return this.request('PUT', `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/discussions/${discussionId}`, {
      body: { resolved: true }
    });
  }

  setCommitStatus(projectId, sha, state, description) {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/statuses/${sha}`, {
      query: {
        state,
        name: this.statusName,
        description: String(description || '').slice(0, 255)
      },
      expected: [201]
    });
  }
}

module.exports = { GitLabClient };

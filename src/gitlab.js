'use strict';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function encodeProject(value) { return encodeURIComponent(String(value)); }

class GitLabClient {
  constructor(config) { this.config = config; this.apiUrl = config.gitlabApiUrl; this.token = config.gitlabToken; this.statusName = config.statusName; }
  async request(method, pathname, { query, body, expected = [200], accept = 'json' } = {}) {
    const url = new URL(this.apiUrl + pathname);
    if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, { method, headers: { 'PRIVATE-TOKEN': this.token, 'User-Agent': 'codex-review-service/1.0', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.config.gitlabRequestTimeoutMs) });
    } catch (cause) { const error = new Error(`GitLab ${method} ${pathname} network failure`); error.code = 'EGITLABNETWORK'; error.cause = cause; throw error; }
    const text = await response.text();
    if (!expected.includes(response.status)) {
      const error = new Error(`GitLab ${method} ${pathname} failed with ${response.status}`); error.code = 'EGITLABHTTP'; error.status = response.status; error.responseBody = text.slice(0, 2000);
      const retryAfter = response.headers.get('retry-after'); if (retryAfter) { const seconds = Number(retryAfter); if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000); }
      throw error;
    }
    let data = text;
    if (accept === 'json') {
      if (!text) data = null; else try { data = JSON.parse(text); } catch (cause) { const error = new Error(`GitLab ${method} ${pathname} returned invalid JSON`); error.code = 'EGITLABJSON'; error.cause = cause; throw error; }
    }
    return { data, status: response.status, headers: response.headers };
  }
  async getVersion() { return (await this.request('GET', '/version')).data; }
  async getMergeRequest(projectId, iid) { return (await this.request('GET', `/projects/${encodeProject(projectId)}/merge_requests/${iid}`)).data; }
  async paginated(pathname, query = {}) {
    const items = []; let page = 1; let complete = true;
    while (page <= this.config.gitlabMaxPages) {
      const response = await this.request('GET', pathname, { query: { ...query, per_page: 100, page } });
      if (!Array.isArray(response.data)) { const error = new Error('GitLab pagination response is not an array'); error.code = 'EGITLABJSON'; throw error; }
      items.push(...response.data); const next = response.headers.get('x-next-page'); if (!next) return { items, complete: true };
      const nextPage = Number(next); if (!Number.isInteger(nextPage) || nextPage <= page) { complete = false; break; } page = nextPage;
    }
    return { items, complete };
  }
  listMergeRequestDiffs(projectId, iid) { return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/diffs`); }
  listOpenMergeRequests(projectId) { return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests`, { state: 'opened', scope: 'all' }); }
  listNotes(projectId, iid) { return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`, { sort: 'asc' }); }
  async createNote(projectId, iid, body) { return (await this.request('POST', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes`, { body: { body }, expected: [201] })).data; }
  async updateNote(projectId, iid, noteId, body) { return (await this.request('PUT', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/notes/${noteId}`, { body: { body } })).data; }
  async upsertSummary(projectId, iid, body) {
    const marker = '<!-- codex-review-service:summary -->'; const result = await this.listNotes(projectId, iid);
    if (!result.complete) { const error = new Error('Could not exhaustively scan MR notes for the summary marker'); error.code = 'EGITLABPAGINATION'; throw error; }
    const existing = result.items.find(note => typeof note.body === 'string' && note.body.includes(marker)); const rendered = `${body}\n\n${marker}`;
    return existing ? this.updateNote(projectId, iid, existing.id, rendered) : this.createNote(projectId, iid, rendered);
  }
  async createDiscussion(projectId, iid, finding, diffRefs, oldPath, newPath) {
    const position = { position_type: 'text', base_sha: diffRefs.base_sha, start_sha: diffRefs.start_sha, head_sha: diffRefs.head_sha,
      old_path: oldPath || newPath, new_path: newPath || oldPath };
    if (finding.side === 'old') position.old_line = finding.line; else position.new_line = finding.line;
    const body = `**${finding.severity.toUpperCase()} · ${finding.title}**\n\n${finding.description}` + (finding.suggestion ? `\n\n**Suggestion:** ${finding.suggestion}` : '') + `\n\n<!-- codex-review-service:finding:${finding.fingerprint} -->`;
    return (await this.request('POST', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions`, { body: { body, position }, expected: [201] })).data;
  }
  async getDiscussion(projectId, iid, discussionId) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`, { expected: [200, 404] });
    return response.status === 404 ? null : response.data;
  }
  async setDiscussionResolved(projectId, iid, discussionId, resolved) {
    return (await this.request('PUT', `/projects/${encodeProject(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`, { body: { resolved: Boolean(resolved) } })).data;
  }
  async getProjectMember(projectId, userId) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/members/all/${encodeURIComponent(userId)}`, { expected: [200, 404] });
    return response.status === 404 ? null : response.data;
  }
  async getRepositoryFileRaw(projectId, filePath, ref) {
    const response = await this.request('GET', `/projects/${encodeProject(projectId)}/repository/files/${encodeURIComponent(filePath)}/raw`, { query: { ref }, expected: [200, 404], accept: 'text' });
    return response.status === 404 ? null : response.data;
  }
  async setCommitStatus(projectId, sha, state, description, ref = '') {
    const doRequest = () => this.request('POST', `/projects/${encodeProject(projectId)}/statuses/${sha}`, { query: { state, name: this.statusName,
      description: String(description || '').slice(0, 255), ref, target_url: this.config.statusTargetUrl || undefined }, expected: [201] });
    let lastError;
    for (let attempt = 0; attempt < this.config.gitlabStatusRetries; attempt += 1) {
      try { return (await doRequest()).data; } catch (error) { lastError = error; if (error.status !== 409 || attempt === this.config.gitlabStatusRetries - 1) throw error; await sleep(Math.min(2000, 250 * (attempt + 1))); }
    }
    throw lastError;
  }
}
function discussionResolved(discussion) {
  if (!discussion || !Array.isArray(discussion.notes)) return null;
  const note = discussion.notes.find(item => item?.resolvable === true); return note ? Boolean(note.resolved) : null;
}
module.exports = { GitLabClient, discussionResolved, encodeProject };

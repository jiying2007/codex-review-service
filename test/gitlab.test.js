'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GitLabClient,
  discussionResolved,
  nextPageFromHeaders
} = require('../src/gitlab');

function config() {
  return {
    gitlabApiUrl: 'https://gitlab.example.test/api/v4',
    gitlabToken: 'token',
    statusName: 'codex-review',
    statusTargetUrl: '',
    gitlabRequestTimeoutMs: 1000,
    gitlabMaxPages: 3,
    gitlabStatusRetries: 2
  };
}

test('pagination follows X-Next-Page and reports completeness', async () => {
  const oldFetch = global.fetch;
  const pages = [];
  global.fetch = async url => {
    const page = new URL(url).searchParams.get('page');
    pages.push(page);
    return new Response(JSON.stringify(page === '1' ? [{ id: 1 }] : [{ id: 2 }]), {
      status: 200,
      headers: page === '1' ? { 'x-next-page': '2' } : {}
    });
  };
  try {
    const result = await new GitLabClient(config()).listMergeRequestDiffs(1, 2);
    assert.deepEqual(pages, ['1', '2']);
    assert.equal(result.complete, true);
    assert.equal(result.items.length, 2);
  } finally {
    global.fetch = oldFetch;
  }
});

test('pagination falls back to RFC Link rel=next', async () => {
  const oldFetch = global.fetch;
  const pages = [];
  global.fetch = async url => {
    const page = new URL(url).searchParams.get('page');
    pages.push(page);
    const headers = page === '1'
      ? { link: '<https://gitlab.example.test/api/v4/items?page=2&per_page=100>; rel="next"' }
      : {};
    return new Response(JSON.stringify([{ id: Number(page) }]), { status: 200, headers });
  };
  try {
    const result = await new GitLabClient(config()).paginated('/items');
    assert.deepEqual(pages, ['1', '2']);
    assert.equal(result.complete, true);
  } finally {
    global.fetch = oldFetch;
  }
});

test('invalid pagination pointer fails closed', () => {
  const headers = new Headers({ 'x-next-page': '1' });
  assert.equal(nextPageFromHeaders(headers, 1), null);
});

test('diff version metadata detects hard-limit truncation', async () => {
  const oldFetch = global.fetch;
  global.fetch = async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/versions')) {
      return new Response(JSON.stringify([{
        base_commit_sha: 'b', start_commit_sha: 's', head_commit_sha: 'h', state: 'collected', real_size: '3'
      }]), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const client = new GitLabClient(config());
    const result = await client.validateMergeRequestDiffCoverage(
      1,
      2,
      { diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } },
      { complete: true, items: [{}, {}] }
    );
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'diff_version_size_mismatch');
  } finally {
    global.fetch = oldFetch;
  }
});

test('diff version metadata confirms complete coverage', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify([{
    base_commit_sha: 'b', start_commit_sha: 's', head_commit_sha: 'h', state: 'collected', real_size: '2'
  }]), { status: 200 });
  try {
    const result = await new GitLabClient(config()).validateMergeRequestDiffCoverage(
      1,
      2,
      { diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } },
      { complete: true, items: [{}, {}] }
    );
    assert.equal(result.complete, true);
    assert.equal(result.realSize, 2);
  } finally {
    global.fetch = oldFetch;
  }
});

test('commit status includes source ref', async () => {
  const oldFetch = global.fetch;
  let requestUrl = '';
  global.fetch = async url => {
    requestUrl = String(url);
    return new Response('{}', { status: 201 });
  };
  try {
    await new GitLabClient(config()).setCommitStatus(1, 'abc', 'success', 'ok', 'feat/test');
    assert.equal(new URL(requestUrl).searchParams.get('ref'), 'feat/test');
  } finally {
    global.fetch = oldFetch;
  }
});

test('discussion resolved state reads resolvable note', () => {
  assert.equal(discussionResolved({ notes: [{ resolvable: false }, { resolvable: true, resolved: true }] }), true);
  assert.equal(discussionResolved({ notes: [{ resolvable: true, resolved: false }] }), false);
  assert.equal(discussionResolved(null), null);
});

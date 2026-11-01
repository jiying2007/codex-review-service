'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const release=fs.readFileSync(path.join(__dirname,'../.github/workflows/release.yml'),'utf8');
const SHA='a'.repeat(40),DIGEST='sha256:'+'1'.repeat(64);
const idx=release.indexOf('      - name: Verify registry-bound BuildKit provenance and SBOM for both platforms');
const start=release.indexOf("          node - <<'NODE'\n",idx);
const end=release.indexOf('\n          NODE',start);
assert.ok(idx>=0&&start>idx&&end>start,'release must retain a real Node BuildKit verifier');
const verifier=release.slice(start+"          node - <<'NODE'\n".length,end)
  .split('\n').map(line=>line.replace(/^          /,'')).join('\n');
const hex=n=>'sha256:'+n.repeat(64);
function manifests(){
  const arches=['amd64','arm64'],sha=[hex('a'),hex('b')];
  return {schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',
    manifests:[
      ...arches.map((architecture,i)=>({mediaType:'application/vnd.oci.image.manifest.v1+json',
        digest:sha[i],platform:{os:'linux',architecture}})),
      ...arches.map((_,i)=>({mediaType:'application/vnd.oci.image.manifest.v1+json',
        digest:hex(i===0?'c':'d'),platform:{os:'unknown',architecture:'unknown'},
        annotations:{'vnd.docker.reference.type':'attestation-manifest',
          'vnd.docker.reference.digest':sha[i]}}))
    ]};
}
function fixture(t,{index=manifests(),provenance={SLSA:{builder:{id:'test'}}},
  sbom={SPDX:{spdxVersion:'SPDX-2.3'}},digest=DIGEST}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-oci-evidence-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const values={index,provenance,sbom};
  for(const [name,value] of Object.entries(values))
    fs.writeFileSync(path.join(dir,'release-oci-'+name+'.json'),JSON.stringify(value));
  return{dir,env:{...process.env,RUNNER_TEMP:dir,IMAGE_REF:'ghcr.io/jiying2007/codex-review-service:7.6.2',
    IMAGE_DIGEST:digest,RELEASE_SHA:SHA}};
}
function run(f){
  return spawnSync(process.execPath,['-e',verifier],{cwd:f.dir,env:f.env,encoding:'utf8',timeout:12000});
}
test('private owner cannot invoke unsupported GitHub Artifact Attestations API',()=>{
  assert.equal((release.match(/if: \$\{\{ !github\.event\.repository\.private \}\}/g)||[]).length,2);
  assert.match(release,/Explain private publisher attestation capability/);
  assert.match(release,/digest-bound, not an independent identity signature/);
  assert.match(release,/Attest canonical OCI image/);
  assert.match(release,/Attest immutable release files/);
  assert.doesNotMatch(release,/continue-on-error:\s*true/);
});
test('valid multiarch BuildKit provenance and SBOM yields bounded evidence',t=>{
  const f=fixture(t),result=run(f);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Verified BuildKit provenance and SBOM/);
  const evidence=JSON.parse(fs.readFileSync(path.join(f.dir,'BUILD_EVIDENCE.json')));
  assert.equal(evidence.sourceSha,SHA);
  assert.equal(evidence.imageDigest,DIGEST);
  assert.deepEqual(evidence.platforms,['amd64','arm64']);
  assert.equal(evidence.attestationType,'digest-bound-buildkit-not-signed-identity');
  assert.equal(evidence.signedReleaseAttestation,'must-be-verified-after-publication');
  for(const key of ['ociIndexSha256','provenanceSha256','sbomSha256'])assert.match(evidence[key],/^[a-f0-9]{64}$/);
});
test('missing attestation for either platform fails closed',t=>{
  const index=manifests();index.manifests.pop();
  const f=fixture(t,{index}),result=run(f);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Both platform-specific BuildKit provenance/);
  assert.equal(fs.existsSync(path.join(f.dir,'BUILD_EVIDENCE.json')),false);
});
test('missing SBOM or provenance fails closed',t=>{
  for(const name of ['sbom','provenance']){
    const input=name==='sbom'?{sbom:{}}:{provenance:{}};
    const f=fixture(t,input),r=run(f);
    assert.notEqual(r.status,0,name);
    assert.equal(fs.existsSync(path.join(f.dir,'BUILD_EVIDENCE.json')),false);
  }
});
test('invalid source SHA or image digest fails closed',t=>{
  const f=fixture(t),dir=f.dir;
  f.env.RELEASE_SHA='bad';
  assert.notEqual(run(f).status,0);
  f.env.RELEASE_SHA=SHA;f.env.IMAGE_DIGEST='sha256:null';
  assert.notEqual(run(f).status,0);
  assert.equal(fs.existsSync(path.join(dir,'BUILD_EVIDENCE.json')),false);
});
test('published release must attach evidence to all hashes and immutable assets',()=>{
  assert.match(release,/BUILD_EVIDENCE\.json compose\.release\.yaml CONSUMER_CI_RECEIPT\.json > SHA256SUMS/);
  assert.match(release,/gh release create "\$RELEASE_TAG" "\$tgz" SBOM\.spdx\.json IMAGE_DIGEST\.txt BUILD_EVIDENCE\.json/);
  assert.match(release,/signedReleaseAttestation:'must-be-verified-after-publication'/);
  assert.match(release,/Require genuine same-SHA main CI Gate before immutable publication/);
  assert.match(release,/Block unfixed Critical OCI vulnerabilities/);
});
test('frozen prerelease tag and ordinary main push require explicit release-retry',()=>{
  assert.match(release,/tag_sha=\$\(RELEASE_TAG="\$tag" node -e/);
  assert.match(release,/Version \$tag is already pinned to prior commit/);
  assert.match(release,/use explicit \/release-retry \$tag/);
  assert.match(release,/test "\$contract_version" = "\$version"/);
});

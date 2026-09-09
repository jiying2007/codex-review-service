'use strict';
const fs=require('node:fs'),path=require('node:path');
function tuple(version){return version.split('.').map(Number);}
function compareVersions(a,b){const av=tuple(a),bv=tuple(b);for(let i=0;i<3;i++)if(av[i]!==bv[i])return bv[i]-av[i];return 0;}
function normalizeChangelog(text){const source=String(text||'').replace(/\r\n/g,'\n').replace(/^# Changelog\s*$/gm,'').trim(),matches=[...source.matchAll(/^## (\d+\.\d+\.\d+)(?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/gm)];if(!matches.length)throw new Error('CHANGELOG has no SemVer release sections.');const sections=matches.map((match,index)=>({version:match[1],body:source.slice(match.index,index+1<matches.length?matches[index+1].index:source.length).trim()})),versions=sections.map(item=>item.version);if(new Set(versions).size!==versions.length)throw new Error('CHANGELOG contains duplicate release versions.');sections.sort((a,b)=>compareVersions(a.version,b.version));return`# Changelog\n\n${sections.map(item=>item.body).join('\n\n')}\n`;}
if(require.main===module){const file=path.resolve(__dirname,'..','CHANGELOG.md'),normalized=normalizeChangelog(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,normalized);console.log('CHANGELOG normalized in descending SemVer order.');}
module.exports={normalizeChangelog};

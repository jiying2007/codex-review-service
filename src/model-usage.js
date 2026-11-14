'use strict';

const FIELDS=Object.freeze([
  ['inputTokens','input_tokens'],
  ['cachedInputTokens','cached_input_tokens'],
  ['cacheWriteInputTokens','cache_write_input_tokens'],
  ['outputTokens','output_tokens'],
  ['reasoningOutputTokens','reasoning_output_tokens']
]);
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
function validTotal(usage,total){
  return Number.isSafeInteger(total)&&['totalTokens','total_tokens'].every(key=>
    !Object.hasOwn(usage,key)||(validCount(usage[key])&&usage[key]===total));
}
function observedUsage(usage,explicit){
  if(explicit===false)return null;
  const observed=normalizeObservedCodexUsage(usage);
  if(!observed)return null;
  // Unmarked normalized zero does not prove a provider observation.
  if(explicit!==true&&observed.inputTokens+observed.outputTokens===0)return null;
  return FIELDS.map(([key])=>observed[key]);
}
function normalizeObservedCodexUsage(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const usage={};
  for(const [camel,snake] of FIELDS){
    const keys=[camel,snake].filter(key=>Object.hasOwn(raw,key));
    if(!keys.length){if(camel==='inputTokens'||camel==='outputTokens')return null;usage[camel]=0;continue;}
    if(!keys.every(key=>validCount(raw[key]))||keys.some(key=>raw[key]!==raw[keys[0]]))return null;
    usage[camel]=raw[keys[0]];
  }
  if(!validTotal(raw,usage.inputTokens+usage.outputTokens))return null;
  if(usage.cachedInputTokens>usage.inputTokens||usage.cacheWriteInputTokens>usage.inputTokens||usage.reasoningOutputTokens>usage.outputTokens)return null;
  return Object.freeze(usage);
}

module.exports={observedUsage,normalizeObservedCodexUsage};

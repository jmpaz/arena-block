/** Local-only assets. The browser receives a short-lived picker capability, never the daemon bearer token. */
export const pickerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>arena-block · Capture</title><link rel="stylesheet" href="/picker.css"></head>
<body><header><div class="wordmark">arena-block<span class="header-rule"> / </span>capture</div><div class="header-note">Save a source to your Are.na channels</div></header>
<main><section class="source-panel" aria-labelledby="source-heading"><div class="section-heading"><span class="eyebrow">01 / SOURCE</span><h1 id="source-heading">Keep the source intact.</h1></div>
<label for="source-url">Paste a source or existing Are.na block</label><div class="source-input"><input id="source-url" type="url" inputmode="url" placeholder="https://…" autocomplete="off" spellcheck="false"><button id="prepare" type="button">Prepare</button></div>
<fieldset class="media"><legend>Media</legend><label><input type="radio" name="media" value="auto" checked> Automatic</label><label><input type="radio" name="media" value="all"> All</label><label><input type="radio" name="media" value="none"> Text only</label></fieldset>
<div id="plan-state" class="inline-state" role="status" aria-live="polite">Add a link to see the proposed block.</div>
<article id="plan-preview" class="preview" hidden><div class="eyebrow">PROPOSED BLOCK <span id="plan-kind"></span></div><h2 id="plan-title"></h2><p id="plan-url"></p><div id="plan-text" class="preview-text"></div><div id="plan-media" class="preview-media"></div></article>
<div id="web-fields" class="web-fields" hidden><label for="web-title">Link title</label><input id="web-title" maxlength="512"><label for="web-description">Description <span class="optional">optional</span></label><textarea id="web-description" rows="4" maxlength="20000"></textarea><button id="update-link" type="button" class="quiet">Update preview</button></div>
<div id="result" class="result" hidden><div class="eyebrow">MOST RECENT SAVE</div><div id="result-phase" class="result-phase"></div><p id="result-detail"></p><a id="open-block" target="_blank" rel="noopener noreferrer" hidden>Open block in Are.na ↗</a><div class="result-actions"><button id="check-save" type="button" class="quiet">Check status</button><button id="resume-request" type="button" class="quiet" hidden>Check or resend intent</button><button id="retry-save" type="button" class="quiet" hidden>Retry retained save</button><button id="cancel-save" type="button" class="quiet" hidden>Cancel pending work</button></div></div>
</section><section class="channels-panel" aria-labelledby="channels-heading"><div class="section-heading"><span class="eyebrow">02 / DESTINATIONS</span><h2 id="channels-heading">Choose channels.</h2><p>Choose one or several. Only the checked channels receive this block.</p></div>
<div class="selected"><div class="selected-heading"><strong>Selected</strong><span id="selected-count">0 / 20</span></div><div id="selected-chips" class="chips"><span class="empty-chips">Nothing selected yet</span></div></div>
<label for="channel-search" class="search-label">Find a channel</label><input id="channel-search" type="search" placeholder="Name, slug, or owner" autocomplete="off" spellcheck="false">
<div class="channel-scopes" role="group" aria-label="Channel search scope"><button type="button" data-scope="my" aria-pressed="true">My Are.na</button><button type="button" data-scope="following" aria-pressed="false">My network</button><button type="button" data-scope="all" aria-pressed="false">All</button></div>
<div class="list-heading"><span id="scope-heading">MY ARE.NA</span><span id="index-state" role="status" aria-live="polite">Loading…</span></div>
<div id="channel-list" class="channel-list"></div><div id="list-end" class="list-end"></div><button id="more-channels" class="quiet more" type="button" hidden>Load more channels</button><div id="channel-error" class="error" role="alert" hidden></div>
<div class="save-footer"><div id="save-guidance" class="save-guidance">Prepare a source and choose at least one channel.</div><button id="save" type="button" disabled>Save to 0 channels</button></div></section></main><script src="/picker.js" defer></script></body></html>`;

export const pickerCss = String.raw`
:root{color-scheme:light dark;--bg:#c3c8b8;--ink:#1b1f17;--grid:#a9af9c;--mid:#b7bcab;--dim:#4d5345;--edge:#6a6f61;--sel:#b2b7a8;--strong:#9ea395;--bad:#7e3832;--button:#1b1f17;--button-ink:#e6e2d8;font-family:Geist,-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#101113;--ink:#e6e2d8;--grid:#2b2d31;--mid:#1d1f22;--dim:#a0a19f;--edge:#606161;--sel:#252627;--strong:#3f3f3e;--bad:#e28f87;--button:#e6e2d8;--button-ink:#101113}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.45}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}header{height:52px;border-bottom:1px solid var(--grid);display:flex;align-items:center;justify-content:space-between;padding:0 26px}.wordmark{font-size:14px;font-weight:650;letter-spacing:-.025em}.header-rule,.header-note,.eyebrow,.optional{color:var(--dim)}.header-note{font-size:12px}.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:650;letter-spacing:.09em}main{display:grid;grid-template-columns:minmax(330px,1fr) minmax(360px,480px);max-width:1400px;margin:0 auto;min-height:calc(100vh - 52px)}section{min-width:0}.source-panel{padding:34px clamp(24px,5vw,70px);border-right:1px solid var(--grid)}.channels-panel{padding:34px 28px 0;display:flex;flex-direction:column;min-height:calc(100vh - 52px)}.section-heading{margin-bottom:32px}.section-heading h1,.section-heading h2{font-size:clamp(24px,3vw,36px);font-weight:500;line-height:1.15;letter-spacing:-.045em;margin:11px 0 0}.section-heading p{margin:9px 0 0;color:var(--dim);font-size:13px}.source-panel>label,.web-fields label,.search-label{font-size:12px;font-weight:600;display:block;margin:0 0 7px}.source-input{display:flex}.source-input input,.web-fields input,.web-fields textarea,.channels-panel input[type=search]{background:transparent;color:var(--ink);border:1px solid var(--edge);border-radius:0;min-height:42px;width:100%;padding:9px 12px;outline:none}.source-input input{min-width:0}.source-input button{border:1px solid var(--ink);background:var(--button);color:var(--button-ink);padding:0 16px;min-width:92px}.media{border:0;padding:18px 0 0;margin:14px 0 0;display:flex;gap:15px;flex-wrap:wrap}.media legend{font-size:12px;font-weight:600}.media label{white-space:nowrap;font-size:12px}.media input{accent-color:var(--ink)}.inline-state{min-height:35px;margin-top:23px;color:var(--dim);font-size:12px}.preview{border-top:1px solid var(--grid);padding:22px 0 28px}.preview h2{font-size:24px;line-height:1.2;font-weight:500;letter-spacing:-.03em;margin:12px 0 7px;overflow-wrap:anywhere}.preview p{font-size:12px;color:var(--dim);overflow-wrap:anywhere;margin:0}.preview-text{white-space:pre-wrap;max-height:240px;overflow:auto;margin-top:20px;line-height:1.55}.preview-media{margin-top:12px;color:var(--dim);font-size:11px}.web-fields{border-top:1px solid var(--grid);padding-top:20px}.web-fields input,.web-fields textarea{margin-bottom:14px}.web-fields textarea{resize:vertical}.quiet{border:1px solid var(--edge);color:var(--ink);background:transparent;border-radius:0;min-height:35px;padding:6px 11px}.quiet:hover:not(:disabled){background:var(--sel)}.selected{border-top:1px solid var(--grid);border-bottom:1px solid var(--grid);padding:14px 0;min-height:104px}.selected-heading,.list-heading{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.03em}.selected-heading span,.list-heading{color:var(--dim)}.chips{display:flex;gap:5px;flex-wrap:wrap;padding-top:11px;max-height:100px;overflow:auto}.chips button{font-size:11px;padding:4px 7px;background:var(--sel);border:1px solid var(--grid);color:var(--ink);border-radius:0}.empty-chips{font-size:12px;color:var(--dim)}.search-label{margin-top:22px}.list-heading{margin-top:20px;padding-bottom:8px;border-bottom:1px solid var(--grid);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.channel-list{min-height:200px;max-height:calc(100vh - 385px);overflow:auto}.row{width:100%;min-height:60px;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--grid);color:var(--ink);display:flex;align-items:center;gap:12px;padding:8px 4px}.row:hover:not(:disabled),.row[aria-pressed=true]{background:var(--sel)}.row-check{width:17px;height:17px;flex:none;border:1px solid var(--edge);display:grid;place-items:center;font-size:12px}.row[aria-pressed=true] .row-check{background:var(--ink);color:var(--bg)}.row-body{flex:1;min-width:0}.row-title{font-size:13px;font-weight:570;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-sub{font-size:11px;color:var(--dim);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-count{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dim)}.list-end{height:8px}.more{margin:11px 0}.error{color:var(--bad);padding:12px 0;font-size:12px}.save-footer{position:sticky;bottom:0;margin:20px -28px 0;padding:15px 28px 20px;background:var(--bg);border-top:1px solid var(--grid)}.save-guidance{font-size:11px;color:var(--dim);min-height:20px;margin-bottom:8px}.save-footer button{width:100%;height:44px;background:var(--button);color:var(--button-ink);border:1px solid var(--button);font-size:13px;font-weight:600}.result{margin-top:18px;border-top:1px solid var(--grid);padding-top:20px}.result-phase{font-size:22px;font-weight:500;margin-top:9px}.result p{color:var(--dim);font-size:12px}.result a{color:var(--ink);font-weight:650}.result-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:16px}
@media(max-width:850px){main{display:block}.source-panel{border-right:0;border-bottom:1px solid var(--grid)}.channels-panel{min-height:unset}.channel-list{max-height:470px}}@media(max-width:530px){header{padding:0 18px}.header-note{display:none}.source-panel{padding:26px 18px}.channels-panel{padding:26px 18px 0}.save-footer{margin-left:-18px;margin-right:-18px;padding-left:18px;padding-right:18px}.media{gap:9px}.row{min-height:58px}}
@media(prefers-reduced-motion:no-preference){button,input,a{transition:background-color .12s ease,color .12s ease}}
.channel-scopes{display:flex;margin-top:12px;border:1px solid var(--grid)}.channel-scopes button{flex:1;border:0;border-right:1px solid var(--grid);background:transparent;color:var(--dim);min-height:36px;font-size:11px}.channel-scopes button:last-child{border-right:0}.channel-scopes button[aria-pressed=true]{background:var(--sel);color:var(--ink);font-weight:650}
`;

export const pickerJs = String.raw`
(() => {
  const $ = id => document.getElementById(id);
  const secret = new URLSearchParams(location.hash.slice(1)).get('session') || sessionStorage.getItem('arena-block-picker-session');
  if (secret) sessionStorage.setItem('arena-block-picker-session', secret);
  history.replaceState(null, '', location.pathname);
  if (!secret) { $('plan-state').textContent = 'Open the private URL printed by arena-block picker.'; return; }
  const state = { channels:new Map(), remoteChannels:new Map(), selected:new Map(), nextPage:1, loading:false, indexError:null,
    scope:'my', remotePage:1, remoteLoading:false, remoteError:null, remoteTicket:0, remoteController:null, indexAt:null,
    plan:null, existing:null, mode:'publish', planTicket:0, prepareController:null, saveId:null, status:null, poll:null, submission:null,
    submitting:false, saveLocked:false };
  const maxChannels = 20;
  const api = async (path, method='GET', body, signal) => {
    const res = await fetch(path, { method, headers: { 'x-arena-block-picker':secret,
      ...(body === undefined ? {} : {'content-type':'application/json'}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal, cache:'no-store' });
    const data = await res.json();
    if (!res.ok) { const error = new Error(data.error || 'Request failed'); error.status = data.saveStatus; throw error; }
    return data;
  };
  const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const terms = text => normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const subsequence = (needle, haystack) => { let n=0; for (const c of haystack) if (c===needle[n]) n++; return n===needle.length; };
  const typo = (a,b) => { if(Math.abs(a.length-b.length)>2)return 3; let p=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=0;i<a.length;i++){const c=[i+1];for(let j=0;j<b.length;j++)c.push(Math.min(p[j+1]+1,c[j]+1,p[j]+(a[i]===b[j]?0:1)));p=c;}return p[b.length]; };
  const score = (word, value) => { const field=normalize(value), parts=terms(value);
    if(field===word)return 100;if(parts.includes(word))return 95;if(field.startsWith(word))return 90;
    if(parts.some(p=>p.startsWith(word)))return 78;if(field.includes(word))return 65;
    if(word.length>=3&&parts.some(p=>subsequence(word,p)))return 43;
    if(word.length>=4&&parts.some(p=>typo(word,p)<=(word.length>=7?2:1)))return 30;return -1; };
  const rank = (channel, query) => { const words=terms(query);if(!words.length)return 0;let total=0;
    for(const word of words){const best=Math.max(score(word,channel.title),score(word,channel.slug)-8,score(word,channel.owner.name)-16);if(best<0)return -1;total+=best;}return total; };
  const message = (id, value) => { $(id).textContent=value; };
  const renderSelection = () => {
    const count=state.selected.size;message('selected-count',count+' / '+maxChannels);
    const box=$('selected-chips');box.replaceChildren();
    if(!count){const empty=document.createElement('span');empty.className='empty-chips';empty.textContent='Nothing selected yet';box.append(empty);}
    for(const channel of state.selected.values()){const chip=document.createElement('button');chip.type='button';chip.textContent=channel.title+' ×';chip.title='Remove '+channel.title;
      chip.onclick=()=>toggle(channel);box.append(chip);}
    $('save').textContent=(state.existing?'Add to ':'Save to ')+count+' '+(count===1?'channel':'channels');
    $('save').disabled=!(state.plan||state.existing)||!count||state.submitting||state.saveLocked||Boolean(state.status&&state.status.active);
    message('save-guidance',!(state.plan||state.existing)?'Prepare a source first.':!count?'Choose at least one channel.':state.existing?'The existing block will be added to these channels.':'The selected channels will receive this exact proposed block.');
  };
  const toggle = channel => { if(state.submitting||state.saveLocked)return;
    if(state.selected.has(channel.id))state.selected.delete(channel.id);
    else if(state.selected.size<maxChannels){state.selected.set(channel.id,channel);}renderSelection();renderChannels(channel.id); };
  const renderChannels = focusId => {
    const query=$('channel-search').value, entries=[...(state.scope==='my'?state.channels:state.remoteChannels).values()].map((channel,index)=>({channel,index,score:state.scope==='my'?rank(channel,query):0}))
      .filter(row=>row.score>=0).sort((a,b)=>b.score-a.score||a.index-b.index);
    const box=$('channel-list');box.replaceChildren();
    if(!entries.length){const empty=document.createElement('p');empty.className='row-sub';empty.textContent=state.scope!=='my'?(state.remoteLoading?'Searching Are.na…':'No channels found in this scope.'):
      state.loading?'Looking through your channels…':state.nextPage?'No match yet; indexing continues.':'No matching channel in the loaded index.';box.append(empty);}
    const fragment=document.createDocumentFragment();
    for(const {channel} of entries.slice(0,120)){const row=document.createElement('button');row.type='button';row.className='row';row.dataset.channelId=String(channel.id);row.setAttribute('aria-pressed',state.selected.has(channel.id));
      row.disabled=channel.canAdd===false;row.title=row.disabled?'This channel does not allow additions':'';
      const check=document.createElement('span');check.className='row-check';check.setAttribute('aria-hidden','true');check.textContent=state.selected.has(channel.id)?'✓':'';
      const body=document.createElement('span');body.className='row-body';const title=document.createElement('span');title.className='row-title';title.textContent=channel.title;
      const sub=document.createElement('span');sub.className='row-sub';sub.textContent=channel.owner.name+' / '+channel.slug+' · '+channel.visibility;
      const count=document.createElement('span');count.className='row-count';count.textContent=channel.count==null?'':channel.count.toLocaleString();
      body.append(title,sub);row.append(check,body,count);row.onclick=()=>toggle(channel);fragment.append(row);}
    box.append(fragment);if(entries.length>120){const note=document.createElement('p');note.className='row-sub';note.textContent='Showing first 120 of '+entries.length+'. Refine your search to find more.';box.append(note);}
    if(focusId!==undefined)for(const row of box.querySelectorAll('button'))if(row.dataset.channelId===String(focusId))row.focus();
    $('more-channels').hidden=state.scope==='my'?!state.nextPage:!state.remotePage;
    message('index-state',state.scope==='my'?(state.loading?'Refreshing '+state.channels.size+'…':state.indexAt?'Saved index · '+state.channels.size:state.channels.size+' indexed'):
      state.remoteLoading?'Searching…':state.remoteChannels.size+' found');
  };
  const loadNext = async () => { if(state.loading||!state.nextPage)return;
    const page=state.nextPage;state.loading=true;state.indexError=null;$('channel-error').hidden=true;renderChannels();
    try {const data=await api('/api/channels?page='+page);for(const channel of data.channels)state.channels.set(channel.id,channel);
      state.nextPage=data.nextPage;if(!state.nextPage){const snapshot=await api('/api/channel-index');state.channels=new Map(snapshot.channels.map(channel=>[channel.id,channel]));state.indexAt=snapshot.completeAt;}
      renderChannels();}
    catch(error){state.indexError=error.message;message('channel-error','Could not load page '+page+'. '+error.message+' Select Load more to retry.');$('channel-error').hidden=false;}
    finally{state.loading=false;renderChannels();}
  };
  const indexMore = async () => {if(!state.nextPage)return;await loadNext();if(state.nextPage&&!state.indexError)setTimeout(indexMore,500);};
  const displayPlan = plan => {state.plan=plan;$('plan-preview').hidden=false;
    message('plan-kind','/ '+plan.block.kind.toUpperCase());message('plan-title',plan.block.title);message('plan-url',plan.block.canonicalSource);
    message('plan-text',plan.block.markdown||plan.block.description||'');
    message('plan-media',plan.block.selectedMedia.length?plan.block.selectedMedia.length+' media item(s) selected':'No composed media');
    $('web-fields').hidden=plan.block.kind!=='url';
    if(plan.block.kind==='url'){if(!$('web-title').value)$('web-title').value=plan.block.title;
      if(!$('web-description').value)$('web-description').value=plan.block.description||'';}
    renderSelection();};
  const displayExisting = block => {state.existing=block;$('plan-preview').hidden=false;$('web-fields').hidden=true;
    message('plan-kind','/ EXISTING '+block.type.toUpperCase());message('plan-title',block.title);message('plan-url',block.blockUrl);
    message('plan-text','This block already exists on Are.na. Its source and content will stay intact.');
    message('plan-media',block.state==='available'?'Ready to connect to selected channels.':'Block state: '+block.state);
    renderSelection();};
  const prepare = async () => {const url=$('source-url').value.trim();const ticket=++state.planTicket;
    if(state.prepareController)state.prepareController.abort();state.prepareController=new AbortController();
    state.plan=null;state.existing=null;$('plan-preview').hidden=true;renderSelection();
    if(!url){message('plan-state','Add a link to see the proposed block.');return;}
    message('plan-state','Preparing source…');$('prepare').disabled=true;
    try{const existing=/^https:\/\/(?:www\.)?are\.na\/block\/[1-9][0-9]{0,15}(?:[/?#].*)?$/i.test(url);
      const data=existing?await api('/api/existing-block?url='+encodeURIComponent(url),'GET',undefined,state.prepareController.signal):
        await api('/api/plan','POST',{url,media:document.querySelector('input[name=media]:checked').value,
          ...($('web-fields').hidden?{}:{title:$('web-title').value.trim()||undefined,description:$('web-description').value||undefined})},state.prepareController.signal);
      if(ticket!==state.planTicket)return;
      if(existing)displayExisting(data);else displayPlan(data.plan);
      message('plan-state','Ready. Review the block and destinations.');}
    catch(error){if(ticket!==state.planTicket||error.name==='AbortError')return;message('plan-state',error.message);}
    finally{if(ticket===state.planTicket)$('prepare').disabled=false;}
  };
  let debounce; $('source-url').addEventListener('input',()=>{clearTimeout(debounce);state.planTicket++;
    if(state.prepareController)state.prepareController.abort();state.prepareController=null;$('prepare').disabled=false;state.plan=null;state.existing=null;
    $('plan-preview').hidden=true;$('web-fields').hidden=true;$('web-title').value='';$('web-description').value='';
    renderSelection();debounce=setTimeout(()=>{try{new URL($('source-url').value);prepare();}catch{}},550);});
  $('prepare').onclick=prepare;$('update-link').onclick=prepare;
  for(const item of document.querySelectorAll('input[name=media]'))item.onchange=()=>{if($('source-url').value)prepare();};
  const remoteSearch=async(reset=true)=>{if(state.scope==='my')return;
    const ticket=++state.remoteTicket;if(state.remoteController)state.remoteController.abort();state.remoteController=new AbortController();
    if(reset){state.remoteChannels.clear();state.remotePage=1;}
    const page=state.remotePage;if(!page)return;state.remoteLoading=true;state.remoteError=null;$('channel-error').hidden=true;renderChannels();
    try{const data=await api('/api/channel-search?scope='+state.scope+'&query='+encodeURIComponent($('channel-search').value.trim())+'&page='+page,'GET',undefined,state.remoteController.signal);
      if(ticket!==state.remoteTicket)return;for(const channel of data.channels)state.remoteChannels.set(channel.id,channel);state.remotePage=data.nextPage;}
    catch(error){if(ticket!==state.remoteTicket||error.name==='AbortError')return;state.remoteError=error.message;
      message('channel-error',error.message+' My Are.na remains available.');$('channel-error').hidden=false;}
    finally{if(ticket===state.remoteTicket){state.remoteLoading=false;renderChannels();}}
  };
  let searchDebounce;$('channel-search').oninput=()=>{if(state.scope==='my')renderChannels();else{clearTimeout(searchDebounce);searchDebounce=setTimeout(()=>remoteSearch(),350);}};
  for(const button of document.querySelectorAll('[data-scope]'))button.onclick=()=>{state.scope=button.dataset.scope;
    for(const item of document.querySelectorAll('[data-scope]'))item.setAttribute('aria-pressed',item===button?'true':'false');
    message('scope-heading',state.scope==='my'?'MY ARE.NA':state.scope==='following'?'MY NETWORK':'ALL ARE.NA');
    $('channel-error').hidden=true;if(state.scope==='my'){state.remoteTicket++;state.remoteController?.abort();renderChannels();}
    else remoteSearch();};
  $('more-channels').onclick=()=>state.scope==='my'?loadNext():remoteSearch(false);
  const renderStatus = status => {state.status=status;$('result').hidden=false;
    const names={prepared:'Prepared',running:'Saving',saved:'Saved',partial:status.active?'Saving':'Needs review',unknown:'Outcome uncertain',cancelled:'Cancelled',not_saved:'Not saved'};
    message('result-phase',names[status.phase]||status.phase);
    const receipt=status.receipt;const pending=receipt&&receipt.pendingDestinations||[];
    const stage=receipt?.stage?receipt.stage.charAt(0).toUpperCase()+receipt.stage.slice(1)+' block. ':'';
    message('result-detail',status.phase==='saved'&&receipt?'Verified in '+receipt.destinations.length+' channel(s).':
      receipt?stage+(pending.length?'Pending channels: '+pending.join(', ')+'. ':'')+'Block and channel placement are not fully verified yet.':
      status.phase==='unknown'?'The request may have reached Are.na. Check this retained save before retrying.':'Your exact save ID is retained for recovery.');
    const open=$('open-block');open.hidden=!receipt?.blockUrl;if(receipt?.blockUrl)open.href=receipt.blockUrl;
    $('resume-request').hidden=true;
    $('retry-save').hidden=!['partial','unknown','not_saved'].includes(status.phase)||status.active;
    $('cancel-save').hidden=!status.active;
    if(status.phase==='saved'){state.saveLocked=false;state.submitting=false;state.submission=null;sessionStorage.removeItem('arena-block-picker-submission');}
    else if(status.phase==='not_saved'||status.phase==='partial'||status.phase==='unknown'||status.active)state.saveLocked=true;
    renderSelection();
    if(state.poll)clearTimeout(state.poll);if(status.active||status.phase==='prepared'||status.phase==='running')state.poll=setTimeout(checkStatus,1600);
  };
  const renderPlacementStatus = status => {state.status=status;$('result').hidden=false;
    const names={prepared:'Ready to place',running:'Adding to channels',saved:'Added to channels',partial:'Some channels pending',unknown:'Connection outcome uncertain',cancelled:'Cancelled'};
    message('result-phase',names[status.phase]||status.phase);
    const pending=status.destinations.filter(id=>!status.confirmed.includes(id));
    message('result-detail',status.phase==='saved'?'Confirmed in '+status.confirmed.length+' channel(s).':
      status.confirmed.length+' confirmed; '+pending.length+' pending. '+(status.error||'Check this retained placement before trying again.'));
    const open=$('open-block');open.hidden=false;open.href='https://www.are.na/block/'+status.blockId;
    $('resume-request').hidden=true;$('retry-save').hidden=status.active||status.phase==='saved';$('cancel-save').hidden=!status.active;
    if(status.phase==='saved'){state.saveLocked=false;state.submitting=false;state.submission=null;sessionStorage.removeItem('arena-block-picker-submission');}
    else state.saveLocked=true;
    renderSelection();if(state.poll)clearTimeout(state.poll);if(status.active)state.poll=setTimeout(checkStatus,1600);
  };
  const renderCurrentStatus = status => state.mode==='place'?renderPlacementStatus(status):renderStatus(status);
  const checkStatus = async () => {if(!state.saveId)return;try{renderCurrentStatus(await api((state.mode==='place'?'/api/placements/':'/api/saves/')+state.saveId));}
    catch(error){if(state.submitting){state.poll=setTimeout(checkStatus,1600);return;}
      message('result-detail','Status check failed: '+error.message+'. Check or resend the same retained intent when connected.');$('resume-request').hidden=!state.submission;}};
  $('check-save').onclick=checkStatus;
  $('resume-request').onclick=async()=>{if(!state.submission)return;$('resume-request').disabled=true;
    try{renderCurrentStatus(await api(state.mode==='place'?'/api/place':'/api/save','POST',state.submission));}
    catch(error){if(error.status&&state.mode==='publish')renderStatus(error.status);else message('result-detail',error.message+'; retry the same retained intent when connected.');}
    finally{$('resume-request').disabled=false;}};
  $('save').onclick=async()=>{if(!(state.plan||state.existing)||!state.selected.size||state.submitting||state.saveLocked)return;
    const destinations=[...state.selected.keys()].map(String),plan=state.plan;
    const id=crypto.randomUUID();state.saveId=id;state.mode=state.existing?'place':'publish';
    state.submission=state.existing?{blockId:state.existing.blockId,destinations:destinations.map(Number),placementId:id}:{plan,destinations,saveId:id};
    state.submitting=true;state.saveLocked=true;
    localStorage.setItem('arena-block-picker-last',JSON.stringify({id,mode:state.mode}));
    try{sessionStorage.setItem('arena-block-picker-submission',JSON.stringify(state.submission));}catch{}
    if(state.mode==='place')renderPlacementStatus({phase:'running',active:true,blockId:state.existing.blockId,destinations:destinations.map(Number),confirmed:[]});
    else renderStatus({phase:'running',active:true,saveId:id});checkStatus();
    try{renderCurrentStatus(await api(state.mode==='place'?'/api/place':'/api/save','POST',state.submission));}
    catch(error){if(error.status&&state.mode==='publish')renderStatus(error.status);else{message('result-phase','Check needed');message('result-detail',error.message+'. Check the retained operation before retrying.');$('resume-request').hidden=false;}}
    finally{state.submitting=false;renderSelection();}
  };
  $('retry-save').onclick=async()=>{if(!state.saveId)return;$('retry-save').disabled=true;
    try{renderCurrentStatus(await api((state.mode==='place'?'/api/placements/':'/api/saves/')+state.saveId+'/retry','POST',{}));}
    catch(error){if(error.status&&state.mode==='publish')renderStatus(error.status);else message('result-detail',error.message);}
    finally{$('retry-save').disabled=false;}};
  $('cancel-save').onclick=async()=>{if(!state.saveId)return;try{renderCurrentStatus(await api((state.mode==='place'?'/api/placements/':'/api/saves/')+state.saveId+'/cancel','POST',{}));}
    catch(error){message('result-detail',error.message);}};
  let last;try{last=JSON.parse(localStorage.getItem('arena-block-picker-last')||'null');}catch{}
  if(!last&&localStorage.getItem('arena-block-picker-save'))last={id:localStorage.getItem('arena-block-picker-save'),mode:'publish'};
  if(last&&/^[a-f0-9-]{36}$/.test(last.id)&&['publish','place'].includes(last.mode)){
    state.saveId=last.id;state.mode=last.mode;state.saveLocked=true;
    try{const retained=JSON.parse(sessionStorage.getItem('arena-block-picker-submission')||'null');
      if((retained?.saveId===last.id&&retained.plan||retained?.placementId===last.id&&retained.blockId)&&Array.isArray(retained.destinations))state.submission=retained;}catch{}
    renderSelection();checkStatus();}
  api('/api/channel-index').then(data=>{for(const channel of data.channels)state.channels.set(channel.id,channel);
    state.indexAt=data.completeAt;renderChannels();
    if(data.completeAt&&Date.now()-Date.parse(data.completeAt)<24*60*60*1000){state.nextPage=null;renderChannels();return;}
    loadNext().then(()=>{if(state.nextPage)setTimeout(indexMore,500);});
  }).catch(()=>loadNext().then(()=>{if(state.nextPage)setTimeout(indexMore,500);}));
})();
`;

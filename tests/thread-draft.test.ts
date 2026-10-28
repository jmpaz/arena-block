import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeThreadDraft} from '../src/thread-draft.ts';
import {captureThread,type ThreadCapture} from '../src/thread-capture.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const fixture=():ThreadCapture=>({sourceUrl:'https://x.com/main/status/1',provider:'x',capturedAt:'2026-10-05T00:00:00Z',posts:[{id:'1',url:'https://x.com/main/status/1',author:{handle:'main'},text:'main',segments:[{text:'main'}],status:'available',media:[{url:'https://example.test/image.jpg',kind:'image',alt:'source alt'}]},{id:'2',url:'https://x.com/quote/status/2',author:{handle:'quote'},text:'quote',segments:[{text:'quote'}],status:'available',media:[]},{id:'3',url:'https://x.com/other/status/3',author:{handle:'other'},text:'other',segments:[{text:'other'}],status:'available',media:[]}],edges:[{from:'1',to:'2',kind:'quote'}],coverage:{complete:false,scope:'explicit selection',limits:[],errors:[],capturedPosts:3,availablePosts:3,mediaWithoutDescriptions:1},originals:[{url:'https://api.fxtwitter.com/main/status/1',payload:{exact:'original payload'}}]});
test('curator selection retains quote context, originals and explicit omitted-media manifest',async()=>{const dir=await mkdtemp(join(tmpdir(),'arena-thread-'));dirs.push(dir);const original=fixture(),before=JSON.stringify(original);const result=await writeThreadDraft(original,dir,{scope:'chain',media:'none',selectedIds:['1']});expect(result.manifest.selection.selectedIds).toEqual(['1','2']);expect(result.manifest.omittedPostIds).toEqual(['3']);expect(result.manifest.omittedMedia.length).toBe(1);expect(await Bun.file(join(result.directory,'capture.json')).json()).toEqual(original);const markdown=await Bun.file(join(result.directory,'thread.md')).text();expect(markdown).toContain('main');expect(markdown).toContain('quote');expect(markdown).not.toContain('example.test/image');expect(markdown).toContain('Draft curator selection');expect(JSON.stringify(original)).toBe(before);});
test('retry preserves user files and writes complete independent owned bundles',async()=>{const dir=await mkdtemp(join(tmpdir(),'arena-thread-'));dirs.push(dir);await Bun.write(join(dir,'thread.md'),'user writing');const a=await writeThreadDraft(fixture(),dir,{scope:'chain',media:'all'}),b=await writeThreadDraft(fixture(),dir,{scope:'chain',media:'all'});expect(a.directory).not.toBe(b.directory);expect(await Bun.file(join(dir,'thread.md')).text()).toBe('user writing');for(const result of[a,b])expect((await readdir(result.directory)).sort()).toEqual(['capture.json','coverage.txt','manifest.json','thread.html','thread.md']);expect((await readdir(dir)).filter(x=>x.startsWith('.thread-'))).toEqual([]);});
test('invalid selection and cancellation never leave a half-written bundle',async()=>{const dir=await mkdtemp(join(tmpdir(),'arena-thread-'));dirs.push(dir);await expect(writeThreadDraft(fixture(),dir,{scope:'chain',media:'all',selectedIds:['missing']})).rejects.toThrow('not captured');const c=new AbortController();c.abort();await expect(writeThreadDraft(fixture(),dir,{scope:'chain',media:'all'},c.signal)).rejects.toThrow();expect(await readdir(dir)).toEqual([]);});
test('slow source cancellation aborts acquisition and can be retried without credentials or writes',async()=>{const c=new AbortController();const pending=captureThread('https://x.com/main/status/1',{signal:c.signal,fetch:((_:any,init:any)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});}))as typeof fetch});c.abort();await expect(pending).rejects.toThrow();const calls:any[]=[];const capture=await captureThread('https://x.com/main/status/1',{fetch:(async(url:any,init:any)=>{calls.push({url,redirect:init.redirect,credentials:init.credentials});return Response.json({tweet:{id:'1',author:{screen_name:'main'},text:'Recovered'}});})as typeof fetch});expect(capture.posts[0]?.text).toBe('Recovered');expect(calls).toEqual([{url:'https://api.fxtwitter.com/main/status/1',redirect:'error',credentials:'omit'}]);expect(capture.coverage.complete).toBe(false);});
test('selecting a quoted post by itself keeps its text visible without the omitted quoting post',async()=>{const dir=await mkdtemp(join(tmpdir(),'arena-thread-'));dirs.push(dir);const result=await writeThreadDraft(fixture(),dir,{scope:'chain',media:'all',selectedIds:['2']});expect(result.manifest.selection.selectedIds).toEqual(['2']);const markdown=await Bun.file(join(result.directory,'thread.md')).text(),html=await Bun.file(join(result.directory,'thread.html')).text();expect(markdown).toContain('quote');expect(markdown).toContain('Original post');expect(html).toContain('quote');expect(html).toContain('<article>');expect(result.manifest.omittedPostIds).toEqual(['1','3']);});

test.each(['reply', 'ancestor'] as const)('reply-only drafts distinguish excluded and unacquired parents through %s edges', async kind => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-thread-'));
  dirs.push(dir);
  const post = (id: string, text: string) => ({
    id, url: `https://x.com/person/status/${id}`, author: { handle: 'person' },
    text, segments: [{ text }], media: [], status: 'available' as const,
  });
  const parentEdge = (parent: string, child: string) => kind === 'reply'
    ? { from: parent, to: child, kind } : { from: child, to: parent, kind };
  const original: ThreadCapture = {
    ...fixture(),
    posts: [
      { ...fixture().posts[0]!, text: 'omitted announcement prose', segments: [{ text: 'omitted announcement prose' }] },
      post('question', 'selected question'), post('answer', 'selected answer'),
      post('sibling', 'unrelated reply prose'), post('orphan', 'selected orphan'),
    ],
    edges: [parentEdge('1', 'question'), parentEdge('question', 'answer'), parentEdge('1', 'sibling'), parentEdge('missing', 'orphan')],
  };
  const before = JSON.stringify(original);
  const result = await writeThreadDraft(original, dir, { scope: 'tree', media: 'all', selectedIds: ['question', 'answer', 'orphan'] });
  const markdown = await Bun.file(join(result.directory, 'thread.md')).text();
  const html = await Bun.file(join(result.directory, 'thread.html')).text();
  expect(markdown).toContain('Reply to [@main](<https://x.com/main/status/1>) (intentionally excluded from this draft)');
  expect(html).toContain('<a href="https://x.com/main/status/1" rel="noreferrer noopener">@main</a> (intentionally excluded from this draft)');
  for (const output of [markdown, html]) {
    expect(output).toContain('selected question');
    expect(output).toContain('selected answer');
    expect(output).not.toContain('omitted announcement prose');
    expect(output).not.toContain('unrelated reply prose');
    expect(output).not.toContain('https://example.test/image.jpg');
    expect(output.match(/Reply parent unavailable/g)).toHaveLength(1);
  }
  expect(result.manifest.selection.selectedIds).toEqual(['question', 'answer', 'orphan']);
  expect(result.manifest.omittedPostIds).toEqual(['1', 'sibling']);
  expect(await Bun.file(join(result.directory, 'manifest.json')).json()).toEqual(result.manifest);
  expect(await Bun.file(join(result.directory, 'capture.json')).json()).toEqual(original);
  expect(JSON.stringify(original)).toBe(before);
});

test('an omitted unavailable parent keeps its acquisition status in the rendered draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-thread-'));
  dirs.push(dir);
  const original = fixture();
  original.posts[0]!.status = 'unavailable';
  original.edges = [{ from: '1', to: '3', kind: 'reply' }];
  const result = await writeThreadDraft(original, dir, { scope: 'tree', media: 'none', selectedIds: ['3'] });
  for (const filename of ['thread.md', 'thread.html']) {
    const output = await Bun.file(join(result.directory, filename)).text();
    expect(output).toContain('Reply parent unavailable');
    expect(output).not.toContain('intentionally excluded');
  }
});

function quotedConversation(): ThreadCapture {
  const capture = fixture();
  capture.posts[1] = {
    ...capture.posts[1]!, cid: 'quoted-record-cid', text: 'omitted quoted announcement prose',
    segments: [{ text: 'omitted quoted announcement prose' }],
    media: [{ url: 'https://example.test/quoted-image.jpg', kind: 'image', alt: 'quoted image' }],
  };
  capture.posts.push(
    { id: '4', url: 'https://x.com/main/status/4', author: { handle: 'main' }, text: 'selected follow-up', segments: [{ text: 'selected follow-up' }], media: [], status: 'available' },
    { id: '5', url: 'https://x.com/nested/status/5', author: { handle: 'nested' }, text: 'omitted nested quotation prose', segments: [{ text: 'omitted nested quotation prose' }], media: [], status: 'available' },
  );
  capture.edges.push({ from: '2', to: '5', kind: 'quote' }, { from: '1', to: '4', kind: 'reply' }, { from: '1', to: '3', kind: 'reply' });
  capture.coverage = { ...capture.coverage, capturedPosts: 5, availablePosts: 5, mediaWithoutDescriptions: 2 };
  return capture;
}

test('reference-only quotes preserve source identity while excluding quoted prose and descendants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-thread-'));
  dirs.push(dir);
  const original = quotedConversation(), before = JSON.stringify(original);
  const result = await writeThreadDraft(original, dir, {
    scope: 'tree', media: 'all', selectedIds: ['1', '4'], referenceOnlyQuoteIds: ['2'],
  });
  const markdown = await Bun.file(join(result.directory, 'thread.md')).text();
  const html = await Bun.file(join(result.directory, 'thread.html')).text();
  expect(markdown).toContain('Quoted source [@quote](<https://x.com/quote/status/2>) (intentionally excluded from this draft)');
  expect(html).toContain('Quoted source <a href="https://x.com/quote/status/2" rel="noreferrer noopener">@quote</a> (intentionally excluded from this draft)');
  for (const output of [markdown, html]) {
    expect(output).toContain('selected follow-up');
    expect(output).toContain('https://example.test/image.jpg');
    expect(output).not.toContain('omitted quoted announcement prose');
    expect(output).not.toContain('omitted nested quotation prose');
    expect(output).not.toContain('https://example.test/quoted-image.jpg');
    expect(output).not.toContain('https://x.com/other/status/3');
    expect(output).not.toContain('Quoted post unavailable');
  }
  expect(result.manifest.selection.selectedIds).toEqual(['1', '4']);
  expect(result.manifest.selection.referenceOnlyQuoteIds).toEqual(['2']);
  expect(result.manifest.referenceOnlyQuotes).toEqual([{ from: '1', to: '2', url: 'https://x.com/quote/status/2', cid: 'quoted-record-cid' }]);
  expect(result.manifest.omittedPostIds).toEqual(['2', '3', '5']);
  expect(await Bun.file(join(result.directory, 'capture.json')).json()).toEqual(original);
  expect(await Bun.file(join(result.directory, 'manifest.json')).json()).toEqual(result.manifest);
  expect(JSON.stringify(original)).toBe(before);
});

test('reference-only selection can omit a nested quote while retaining its selected parent quotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-thread-'));
  dirs.push(dir);
  const result = await writeThreadDraft(quotedConversation(), dir, {
    scope: 'tree', media: 'none', selectedIds: ['1', '2'], referenceOnlyQuoteIds: ['5'],
  });
  for (const filename of ['thread.md', 'thread.html']) {
    const output = await Bun.file(join(result.directory, filename)).text();
    expect(output).toContain('omitted quoted announcement prose');
    expect(output).toContain('https://x.com/nested/status/5');
    expect(output).toContain('intentionally excluded from this draft');
    expect(output).not.toContain('omitted nested quotation prose');
  }
  expect(result.manifest.selection.selectedIds).toEqual(['1', '2']);
});

test.each(['unknown', 'not-quoted', 'selected-prose', 'unavailable'] as const)('reference-only quotes reject %s source choices before writing', async choice => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-thread-'));
  dirs.push(dir);
  const capture = quotedConversation();
  if (choice === 'unavailable') capture.posts[1]!.status = 'unavailable';
  const id = choice === 'unknown' ? 'missing' : choice === 'not-quoted' ? '3' : '2';
  await expect(writeThreadDraft(capture, dir, {
    scope: 'tree', media: 'none', selectedIds: choice === 'selected-prose' ? ['1', '2'] : ['1'], referenceOnlyQuoteIds: [id],
  })).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});
